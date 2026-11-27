import { readdirSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { exists, listFiles, readText } from "../util.ts";
import { namedAfter } from "./coverage.ts";
import { cLikeQuoted, cLikeSites } from "./jvm.ts";
import type { DraftCommand, Ecosystem, LanguageDef, ToolSetup } from "./language.ts";

// Microsoft's install script, pinned to a commit of dotnet/install-scripts and checked against its
// digest before it runs as root in the audit's container: the pattern the audit flags in a repo's
// own setup (a script piped from the network into a shell) never runs unchecked here. The commit is
// the one dot.net/v1/dotnet-install.sh served on Nov 27, 2026.
export const DOTNET_INSTALL_SCRIPT = {
  url: "https://raw.githubusercontent.com/dotnet/install-scripts/ee83f9c42135205be4e0503bd472b6f99c9b7d51/src/dotnet-install.sh",
  sha256: "082f7685e156738a1b2e2ed8381a621870d4ce8e8c59278034556f05c186eb2e",
};
const FETCH_INSTALL_SCRIPT = `curl -fsSL ${DOTNET_INSTALL_SCRIPT.url} -o /tmp/dotnet-install.sh && echo "${DOTNET_INSTALL_SCRIPT.sha256}  /tmp/dotnet-install.sh" | sha256sum -c --quiet -`;

// Owned by the Java, Kotlin and .NET group. C# projects built with the .NET SDK are scored.

const PROJECT = /\.(csproj|fsproj|vbproj)$/;
const SOLUTION = /\.slnx?$/;
const OUTPUT = /(^|\/)(bin|obj)\//;

// .NET Framework target monikers: net20 to net481. Modern .NET has a dot (net8.0).
const NETFX = /^net\d{2,3}$/;

// What makes a project build or run only on Windows, or null when the .NET SDK in a Linux
// container builds and tests it: "pre-SDK .NET Framework 4.8 format", "Windows Forms", "net48".
export function windowsOnly(text: string, packagesConfig: boolean): string | null {
  const sdkStyle = /<Project\b[^>]*\bSdk\s*=/.test(text) || /<Sdk\s+Name\s*=/.test(text) || /<Import\b[^>]*\bSdk\s*=/.test(text);
  const v = text.match(/<TargetFrameworkVersion>\s*v?([\d.]+)/)?.[1];
  if (!sdkStyle && (v || /schemas\.microsoft\.com\/developer\/msbuild\/2003/.test(text))) return `pre-SDK .NET Framework${v ? ` ${v}` : ""} format`;
  if (/<UseWindowsForms>\s*true/i.test(text)) return "Windows Forms";
  if (/<UseWPF>\s*true/i.test(text)) return "WPF";
  const tfms = [...text.matchAll(/<TargetFrameworks?>([^<]+)</g)].flatMap((m) => m[1].split(";").map((t) => t.trim()).filter(Boolean));
  if (tfms.length && tfms.every((t) => NETFX.test(t) || /-windows/.test(t))) return tfms.join(", ");
  if (packagesConfig) return "packages.config";
  return null;
}

const projectFiles = (tree: string, path: string) => listFiles(join(tree, path)).filter((f) => PROJECT.test(f) && !OUTPUT.test(f));

// The folder's projects that need Windows, relative to the folder, each with why.
export function windowsProjects(tree: string, path: string): { file: string; why: string }[] {
  return projectFiles(tree, path).flatMap((f) => {
    const why = windowsOnly(readText(join(tree, path, f)), exists(join(tree, path, dirname(f), "packages.config")));
    return why ? [{ file: f, why }] : [];
  });
}

// The projects a Linux container can build: every project unless some need Windows.
function portable(tree: string, path: string): string[] {
  const windows = new Set(windowsProjects(tree, path).map((p) => p.file));
  return projectFiles(tree, path).filter((f) => !windows.has(f));
}

// Projects that reference packages, each with whether a packages.lock.json sits next to it.
function projects(tree: string, path: string): { file: string; locked: boolean }[] {
  return portable(tree, path)
    .filter((f) => /<PackageReference\b/.test(readText(join(tree, path, f))))
    .map((f) => ({ file: f, locked: exists(join(tree, path, dirname(f), "packages.lock.json")) }));
}

// What `dotnet` builds in a folder: nothing to name when the folder has one solution or project,
// else the one named after the folder, or the shortest name, as the scan names the component. A
// solution that also holds Windows-only projects can't be built whole on Linux, so the portable
// projects no other portable project references are named instead, and build the rest through
// their references.
function targets(tree: string, path: string): string[] {
  if (windowsProjects(tree, path).length) {
    const own = portable(tree, path);
    const referenced = new Set(own.flatMap((f) => [...readText(join(tree, path, f)).matchAll(/<ProjectReference\s+Include="([^"]+)"/g)].map((m) => posix.normalize(posix.join(dirname(f), m[1].replace(/\\/g, "/"))))));
    return own.filter((f) => !referenced.has(f)).sort().map((f) => ` ${f}`);
  }
  const names = readdirSync(join(tree, path)).filter((n) => SOLUTION.test(n) || PROJECT.test(n));
  const solutions = names.filter((n) => SOLUTION.test(n));
  const pool = solutions.length ? solutions : names;
  if (pool.length <= 1 && names.length <= 1) return [""];
  const folder = basename(path === "." ? tree : path).toLowerCase();
  const pick = pool.find((n) => n.replace(/\.\w+$/, "").toLowerCase() === folder) ?? [...pool].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  return [pick ? ` ${pick}` : ""];
}

const each = (verb: string, on: string[], rest: string) => on.map((t) => `dotnet ${verb}${t}${rest}`).join(" && ");

const nuget: Ecosystem = {
  id: "nuget",
  label: "NuGet",
  lockfiles: ["packages.lock.json"],
  rule: "`dotnet restore --locked-mode` with a committed `packages.lock.json` next to every project that references packages",
  install: (tree, path) => {
    const open = projects(tree, path).filter((p) => !p.locked);
    const on = targets(tree, path);
    return open.length === 0
      ? { command: each("restore", on, " --locked-mode"), reason: "locked restore from each project's packages.lock.json", frozen: true }
      : { command: each("restore", on, ""), reason: "some projects have no packages.lock.json, so the restore can't be frozen", frozen: false };
  },
  unpinned: (tree, path) => {
    const all = projects(tree, path);
    const open = all.filter((p) => !p.locked);
    return open.length ? `${open.length} of ${all.length} projects that reference packages have no packages.lock.json` : null;
  },
};

// Only the folder's own files: a solution next to its projects' folders.
function soleProject(tree: string, manifest: string): boolean {
  const ext = manifest.match(/\.\w+$/)![0];
  return readdirSync(join(tree, dirname(manifest))).filter((n) => n.endsWith(ext)).length === 1;
}

// The SDK lines the audit has an image for.
export const SDKS = [8, 9, 10];
const DEFAULT_SDK = 8;

function globalJson(tree: string, path: string): string | null {
  for (const dir of [path, "."]) {
    const f = join(tree, dir, "global.json");
    if (exists(f)) return dir === "." ? "global.json" : `${dir}/global.json`;
  }
  return null;
}

// The one SDK each pinned image ships (`dotnet --list-sdks` at the digest in IMAGES).
export const IMAGE_SDK: Record<number, string> = { 8: "8.0.428", 9: "9.0.321", 10: "10.0.404" };

type Version = [number, number, number];
const parse = (v: string): Version | null => {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const atLeast = (a: Version, b: Version) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];

// Whether an installed SDK satisfies global.json's version under its rollForward policy, as the
// .NET host decides it. The default policy is `patch`: the same feature band (8.0.1xx), at that
// patch or later.
export function sdkSatisfies(installed: string, requested: string, rollForward = "patch"): boolean {
  const have = parse(installed);
  const want = parse(requested);
  if (!have || !want) return false;
  const band = (v: Version) => Math.floor(v[2] / 100);
  const sameMinor = have[0] === want[0] && have[1] === want[1];
  switch (rollForward) {
    case "disable":
      return installed === requested;
    case "patch":
    case "latestPatch":
      return sameMinor && band(have) === band(want) && have[2] >= want[2];
    case "feature":
    case "latestFeature":
      return sameMinor && atLeast(have, want);
    case "minor":
    case "latestMinor":
      return have[0] === want[0] && atLeast(have, want);
    case "major":
    case "latestMajor":
      return atLeast(have, want);
    default:
      return false;
  }
}

function sdkPin(tree: string, path: string): { version: string; rollForward: string } | null {
  const pin = globalJson(tree, path);
  if (!pin) return null;
  const text = readText(join(tree, pin));
  const version = text.match(/"version"\s*:\s*"([^"]+)"/)?.[1];
  return version ? { version, rollForward: text.match(/"rollForward"\s*:\s*"([^"]+)"/)?.[1] ?? "patch" } : null;
}

// The SDK global.json pins, else the newest target framework the projects name (net8.0, net9.0).
export function sdkFor(tree: string, path: string): number {
  const pin = globalJson(tree, path);
  const pinned = pin ? Number(readText(join(tree, pin)).match(/"version"\s*:\s*"(\d+)\./)?.[1] ?? NaN) : NaN;
  const frameworks = portable(tree, path)
    .flatMap((f) => [...readText(join(tree, path, f)).matchAll(/<TargetFrameworks?>([^<]+)</g)].flatMap((m) => [...m[1].matchAll(/\bnet(\d+)\.\d/g)].map((x) => Number(x[1]))));
  const want = Number.isFinite(pinned) ? pinned : frameworks.length ? Math.max(...frameworks) : DEFAULT_SDK;
  return SDKS.find((v) => v >= want) ?? SDKS[SDKS.length - 1];
}

// VSTest prints one line per test project; Microsoft.Testing.Platform prints a summary.
export function dotnetTestCounts(output: string): { passed: number; failed: number; total: number } | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const vstest = [...text.matchAll(/(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+)/g)];
  if (vstest.length) {
    let passed = 0;
    let failed = 0;
    for (const m of vstest) {
      failed += Number(m[1]);
      passed += Number(m[2]);
    }
    return { passed, failed, total: passed + failed };
  }
  const mtp = [...text.matchAll(/total:\s+(\d+)\s*\n\s*failed:\s+(\d+)\s*\n\s*succeeded:\s+(\d+)/g)];
  if (mtp.length) {
    let passed = 0;
    let failed = 0;
    for (const m of mtp) {
      failed += Number(m[2]);
      passed += Number(m[3]);
    }
    return { passed, failed, total: passed + failed };
  }
  return null;
}

const isTest = (f: string) => /\.cs$/.test(f) && (/(^|\/)[^/]*Tests?(\/|$)/.test(dirname(f)) || /Tests?\.cs$/.test(f));
const isSource = (f: string) => /\.cs$/.test(f) && !isTest(f) && !OUTPUT.test(f) && !/(\.Designer|\.g|\.g\.i|AssemblyInfo|GlobalUsings)\.cs$/.test(f) && !/(^|\/)Migrations\//.test(f);

// A project `dotnet test` runs: one with the test SDK, a test framework or the testing platform.
// A folder without one has no tests to run, as a Node package without a test script has none.
const TEST_PROJECT = /<IsTestProject>\s*true|Include="(Microsoft\.NET\.Test\.Sdk|xunit(\.v3)?|NUnit|MSTest(\.TestFramework|\.Sdk)?|TUnit|Microsoft\.Testing\.Platform)"|Sdk="MSTest\.Sdk/i;

// The .NET majors the test projects run on, from target frameworks with no Condition, so a
// Windows-only net48 is left out.
export function testRuntimes(tree: string, path: string): number[] {
  const majors = new Set<number>();
  for (const f of testProjects(tree, path)) {
    for (const m of readText(join(tree, path, f)).matchAll(/<TargetFrameworks?>([^<]+)</g)) for (const t of m[1].matchAll(/\bnet(\d+)\.\d/g)) majors.add(Number(t[1]));
  }
  return [...majors].sort((a, b) => a - b);
}

export function aotProjects(tree: string, path: string): string[] {
  return portable(tree, path).filter((f) => /<PublishAot>\s*true\s*</i.test(readText(join(tree, path, f))));
}

function testProjects(tree: string, path: string): string[] {
  return portable(tree, path).filter((f) => TEST_PROJECT.test(readText(join(tree, path, f))));
}

function dotnetCommands(tree: string, path: string): DraftCommand[] {
  const on = targets(tree, path);
  const windows = windowsProjects(tree, path);
  const left = windows.length ? `; ${windows.map((p) => basename(p.file)).join(", ")} ${windows.length === 1 ? "needs" : "need"} Windows and ${windows.length === 1 ? "is" : "are"} listed apart` : "";
  const out: DraftCommand[] = [{ kind: "build", command: each("build", on, " --no-restore"), source: "readiness", reason: `the .NET SDK's build of the restored projects${left}` }];
  const tests = testProjects(tree, path);
  if (tests.length) out.push({ kind: "test", command: each("test", windows.length ? tests.map((t) => ` ${t}`) : on, " --no-restore"), source: "readiness", reason: `the .NET SDK's test run of ${tests.length === 1 ? tests[0] : `${tests.length} test projects`}, offline${left}` });
  return out;
}

// The facts about a Windows-only component read from its files, since nothing of it runs here.
function windowsNotes(tree: string, path: string): string[] {
  const projs = windowsProjects(tree, path);
  const byWhy = new Map<string, string[]>();
  for (const p of projs) byWhy.set(p.why, [...(byWhy.get(p.why) ?? []), basename(p.file).replace(PROJECT, "")]);
  const out = ["Windows-only: " + [...byWhy].map(([why, names]) => `${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]} (${why})`).join(", ")];
  const configs = projs.filter((p) => exists(join(tree, path, dirname(p.file), "packages.config"))).length;
  if (configs) out.push(`${configs === 1 ? "its packages.config pins" : `the packages.config of ${configs} projects pin`} exact package versions`);
  const refs = projs.filter((p) => /<PackageReference\b/.test(readText(join(tree, path, p.file))));
  const open = refs.filter((p) => !exists(join(tree, path, dirname(p.file), "packages.lock.json")));
  if (open.length) out.push(`${open.length} of ${refs.length} projects that reference packages have no packages.lock.json`);
  else if (refs.length) out.push("every project that references packages has a packages.lock.json");
  return out;
}

const IMAGES: Record<string, string> = {
  "mcr.microsoft.com/dotnet/sdk:8.0": "sha256:1b955f179b02df4f0eb5fadedaa898cbe44d620a64aab52eec72c8e91d1355b5",
  "mcr.microsoft.com/dotnet/sdk:9.0": "sha256:1dfdb27e9c2c345cb598925ccf6b13719ecfebea8467bd4745c23a3c108cdf84",
  "mcr.microsoft.com/dotnet/sdk:10.0": "sha256:fe0fd4e93bd2fbb47c883b7a6369e5c8d3db8bf01cdc5981f6ee35fbdf3ff4fb",
};

export const dotnet: LanguageDef = {
  id: "dotnet",
  label: ".NET",
  codes: ["csharp"],
  stacks: [
    { id: "dotnet", label: ".NET", kind: "stack", tier: "supported", files: /\.(cs|fs|vb|csproj|fsproj|vbproj|sln|slnx|razor)$/, proof: ["fixtures/dotnet-xunit", "fixtures/nested-apps-dotnet", "fixtures/standalone-nested-mixed", "fixtures/dotnet-ios-monorepo", "TheAlgorithms/C-Sharp@6d3b02a"] },
    {
      id: "dotnet-windows",
      label: "A Windows-only .NET project",
      kind: "stack",
      tier: "not_yet",
      needs: "Windows",
      reason: "it needs Windows, since it targets .NET Framework or Windows (net48, a -windows framework, Windows Forms, WPF, classic ASP.NET or packages.config), and the audit's containers run Linux, so it's blocked on this machine rather than broken",
      files: /\.(cs|fs|vb|csproj|fsproj|vbproj|sln|slnx|razor|resx|config|xaml|aspx|cshtml|asax)$/,
      proof: ["fixtures/dotnet-framework-windows", "fixtures/dotnet-ios-monorepo", "dotnet-architecture/eShopModernizing@63bc9ec", "ShareX/ShareX@abb975d"],
    },
  ],
  detect: {
    // A solution file comes first so it groups the projects under it into one component.
    manifests: [
      { match: SOLUTION, stack: "dotnet", rank: 10 },
      { match: PROJECT, stack: "dotnet", rank: 11 },
    ],
    sources: [{ ext: /\.(cs|fs)$/, stack: "dotnet", rank: 50 }],
    lockfiles: ["packages.lock.json"],
    // Several solutions in one folder name the project only when one matches the repo, so ShareX
    // isn't named after ShareX.ImageEditor.sln.
    projectName: (tree, manifest, _text, repoName) => {
      if (!/\.(slnx?|csproj|fsproj|vbproj)$/.test(manifest)) return undefined;
      const stem = manifest.split("/").pop()!.replace(/\.\w+$/, "");
      return soleProject(tree, manifest) || stem.toLowerCase() === repoName.toLowerCase() ? stem : undefined;
    },
    // A folder whose every project needs Windows is listed as blocked here, never built to fail.
    refine: (manifest, _text, tree) => {
      if (!tree) return undefined;
      const dir = dirname(manifest);
      return windowsProjects(tree, dir).length && !portable(tree, dir).length ? "dotnet-windows" : undefined;
    },
    // Next to projects that build on Linux, each Windows-only project in its own folder is listed
    // apart, so its changes and its reason show, and the rest is still assessed.
    parts: (tree, dir) => {
      if (!portable(tree, dir).length) return [];
      const seen = new Set<string>();
      return windowsProjects(tree, dir).flatMap((p) => {
        const sub = dirname(p.file);
        if (sub === "." || seen.has(sub)) return [];
        seen.add(sub);
        return [{ path: dir === "." ? sub : `${dir}/${sub}`, manifest: dir === "." ? p.file : `${dir}/${p.file}`, stack: "dotnet-windows" }];
      });
    },
    notes: (tree, dir, stackId) => (stackId === "dotnet-windows" ? windowsNotes(tree, dir) : []),
  },
  ecosystems: [nuget],
  replay: {
    classify: () => ({ language: "csharp", packageManager: "nuget" }),
    image: (tree, dir) => `mcr.microsoft.com/dotnet/sdk:${sdkFor(tree, dir)}.0`,
    images: IMAGES,
    doctor: "dotnet --version",
    pins: (tree, dir) => {
      const pin = globalJson(tree, dir);
      return pin && /"version"\s*:/.test(readText(join(tree, pin))) ? { found: [pin], missing: [] } : { found: [], missing: ["the .NET SDK version (the sdk version in global.json)"] };
    },
    commands: (tree, comp) => dotnetCommands(tree, comp.path),
    // A global.json that pins a feature band the image doesn't ship, such as 10.0.100 under the
    // default `patch` policy next to the image's 10.0.404, gets that exact SDK added from Microsoft's
    // install script, as a CI's setup-dotnet would. Where that can't be fetched the install is blocked.
    setup: (tree, dir) => {
      const out: ToolSetup[] = [];
      const pin = sdkPin(tree, dir);
      if (pin && parse(pin.version) && !sdkSatisfies(IMAGE_SDK[sdkFor(tree, dir)], pin.version, pin.rollForward)) {
        const v = pin.version;
        out.push({ tool: `dotnet-sdk-${v}`, spec: `dotnet-sdk@${v}`, install: `${FETCH_INSTALL_SCRIPT} && bash /tmp/dotnet-install.sh --version ${v} --install-dir /usr/share/dotnet --no-path && ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet-sdk-${v}` });
      }
      // A test project that also targets an older .NET, such as net8.0 next to net10.0, needs that
      // runtime to run its tests; the SDK image ships only its own.
      const sdk = sdkFor(tree, dir);
      const aspnet = portable(tree, dir).some((f) => /Microsoft\.NET\.Sdk\.Web|FrameworkReference Include="Microsoft\.AspNetCore\.App"/.test(readText(join(tree, dir, f))));
      for (const major of testRuntimes(tree, dir).filter((m) => m < sdk)) {
        const runtimes = aspnet ? ["dotnet", "aspnetcore"] : ["dotnet"];
        out.push({
          tool: `dotnet-runtime-${major}.0`,
          spec: `.NET ${major}.0 runtime${aspnet ? " and ASP.NET Core runtime" : ""}`,
          install: `${FETCH_INSTALL_SCRIPT} && ${runtimes.map((r) => `bash /tmp/dotnet-install.sh --runtime ${r} --channel ${major}.0 --install-dir /usr/share/dotnet --no-path`).join(" && ")} && ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet-runtime-${major}.0`,
        });
      }
      // A NativeAOT project links with the platform's C toolchain, which the SDK image doesn't ship;
      // Microsoft's Linux prerequisites are clang and zlib1g-dev.
      if (aotProjects(tree, dir).length) out.push({ tool: "clang", spec: "clang and zlib1g-dev (for NativeAOT)", install: "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends clang zlib1g-dev >/dev/null" });
      return out;
    },
    testCounts: dotnetTestCounts,
    budget: { commandTimeoutSec: 1200, componentMinutes: 45, mutationRunTimeoutSec: 900 },
    mutation: {
      isTest,
      isSource,
      covered: (tree, comp, tests, files) => {
        const windows = windowsProjects(tree, comp.path).filter((p) => dirname(p.file) !== ".").map((p) => posix.join(comp.path, dirname(p.file)));
        return namedAfter(tests, files.filter((f) => !windows.some((w) => f.startsWith(`${w}/`))), isSource);
      },
      sites: (line) => cLikeSites(line, true),
      quoted: (text) => cLikeQuoted(text, true),
      compileProbe: (comp) => ({ command: `dotnet build${comp.manifest ? ` ${basename(comp.manifest)}` : ""} --no-restore -v q -nologo`, cwd: comp.path }),
      compileError: (output) => /\berror CS\d{4}\b/.test(output),
    },
  },
};
