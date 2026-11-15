import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { exists, listFiles, readText } from "../util.ts";
import { namedAfter } from "./coverage.ts";
import { cLikeQuoted, cLikeSites } from "./jvm.ts";
import type { DraftCommand, Ecosystem, LanguageDef } from "./language.ts";

// Owned by the Java, Kotlin and .NET group. C# projects built with the .NET SDK are scored.

const PROJECT = /\.(csproj|fsproj|vbproj)$/;
const SOLUTION = /\.slnx?$/;
const OUTPUT = /(^|\/)(bin|obj)\//;

// Projects that reference packages, each with whether a packages.lock.json sits next to it.
function projects(tree: string, path: string): { file: string; locked: boolean }[] {
  return listFiles(join(tree, path))
    .filter((f) => PROJECT.test(f) && !OUTPUT.test(f) && /<PackageReference\b/.test(readText(join(tree, path, f))))
    .map((f) => ({ file: f, locked: exists(join(tree, path, dirname(f), "packages.lock.json")) }));
}

// What `dotnet` builds in a folder: nothing to name when the folder has one solution or project,
// else the one named after the folder, or the shortest name, as the scan names the component.
function target(tree: string, path: string): string {
  const names = readdirSync(join(tree, path)).filter((n) => SOLUTION.test(n) || PROJECT.test(n));
  const solutions = names.filter((n) => SOLUTION.test(n));
  const pool = solutions.length ? solutions : names;
  if (pool.length <= 1 && names.length <= 1) return "";
  const folder = basename(path === "." ? tree : path).toLowerCase();
  const pick = pool.find((n) => n.replace(/\.\w+$/, "").toLowerCase() === folder) ?? [...pool].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  return pick ? ` ${pick}` : "";
}

const nuget: Ecosystem = {
  id: "nuget",
  label: "NuGet",
  lockfiles: ["packages.lock.json"],
  rule: "`dotnet restore --locked-mode` with a committed `packages.lock.json` next to every project that references packages",
  install: (tree, path) => {
    const open = projects(tree, path).filter((p) => !p.locked);
    return open.length === 0
      ? { command: `dotnet restore${target(tree, path)} --locked-mode`, reason: "locked restore from each project's packages.lock.json", frozen: true }
      : { command: `dotnet restore${target(tree, path)}`, reason: "some projects have no packages.lock.json, so the restore can't be frozen", frozen: false };
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

// The SDK global.json pins, else the newest target framework the projects name (net8.0, net9.0).
export function sdkFor(tree: string, path: string): number {
  const pin = globalJson(tree, path);
  const pinned = pin ? Number(readText(join(tree, pin)).match(/"version"\s*:\s*"(\d+)\./)?.[1] ?? NaN) : NaN;
  const frameworks = listFiles(join(tree, path))
    .filter((f) => PROJECT.test(f) && !OUTPUT.test(f))
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

function testProjects(tree: string, path: string): string[] {
  return listFiles(join(tree, path)).filter((f) => PROJECT.test(f) && !OUTPUT.test(f) && TEST_PROJECT.test(readText(join(tree, path, f))));
}

function dotnetCommands(tree: string, path: string): DraftCommand[] {
  const t = target(tree, path);
  const out: DraftCommand[] = [{ kind: "build", command: `dotnet build${t} --no-restore`, source: "readiness", reason: "the .NET SDK's build of the restored projects" }];
  const tests = testProjects(tree, path);
  if (tests.length) out.push({ kind: "test", command: `dotnet test${t} --no-restore`, source: "readiness", reason: `the .NET SDK's test run of ${tests.length === 1 ? tests[0] : `${tests.length} test projects`}, offline` });
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
  stacks: [{ id: "dotnet", label: ".NET", kind: "stack", tier: "supported", files: /\.(cs|fs|vb|csproj|fsproj|vbproj|sln|slnx|razor)$/, proof: ["fixtures/dotnet-xunit", "fixtures/nested-apps-dotnet", "fixtures/standalone-nested-mixed", "TheAlgorithms/C-Sharp@6d3b02a"] }],
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
    testCounts: dotnetTestCounts,
    budget: { commandTimeoutSec: 1200, componentMinutes: 45, mutationRunTimeoutSec: 900 },
    mutation: {
      isTest,
      isSource,
      covered: (_tree, _comp, tests, files) => namedAfter(tests, files, isSource),
      sites: (line) => cLikeSites(line, true),
      quoted: (text) => cLikeQuoted(text, true),
      compileProbe: (comp) => ({ command: `dotnet build${comp.manifest ? ` ${basename(comp.manifest)}` : ""} --no-restore -v q -nologo`, cwd: comp.path }),
      compileError: (output) => /\berror CS\d{4}\b/.test(output),
    },
  },
};
