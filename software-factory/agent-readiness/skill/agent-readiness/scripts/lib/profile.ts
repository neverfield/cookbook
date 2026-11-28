import { basename, dirname, join } from "node:path";
import { LANGUAGES, languageOf as languageFile, languageOfStack, lockfileNames, manifestRules, rootAppRules, sourceRules } from "./languages/index.ts";
import type { LanguageDef } from "./languages/language.ts";
import { NODE_LOCKFILES, readPackageJson, yarnBerry, yarnPath, yarnPinned } from "./languages/node.ts";
import { PY_LOCKFILES, UV_WORKSPACE, pyproject, uvWorkspaceMembers } from "./languages/python.ts";
import type { Rubric } from "./rubric.ts";
import { STACKS, notSupportedReason, stack, supported } from "./support.ts";
import type { Component, Language, PackageManager, Profile, Unit } from "./types.ts";
import { capCutReason } from "./scope.ts";
import { MAX_FILES, containedPath, exists, listFilesScoped, ownSkillPath, readJson, readText, workspaceDirs } from "./util.ts";
import { OUTPUT_SEGMENT, SKIP_SEGMENT, inventory, namesByDir, pythonManifest, skipSegment } from "./discover/inventory.ts";
import { assignShares, changeCounts, shareUnder } from "./discover/ownership.ts";
import type { ChangeCounts } from "./discover/ownership.ts";
import { ownTestFiles } from "./plan/test-files.ts";

export { pyproject, readPackageJson, uvWorkspaceMembers, yarnBerry };

export function detectPackageManager(tree: string): PackageManager | null {
  if (exists(join(tree, "bun.lock")) || exists(join(tree, "bun.lockb"))) return "bun";
  if (exists(join(tree, "pnpm-lock.yaml"))) return "pnpm";
  if (exists(join(tree, "yarn.lock"))) return "yarn";
  if (exists(join(tree, "package-lock.json"))) return "npm";
  if (exists(join(tree, "package.json"))) {
    const pm = readPackageJson(tree)?.packageManager ?? "";
    if (pm.startsWith("bun")) return "bun";
    if (pm.startsWith("pnpm")) return "pnpm";
    if (pm.startsWith("yarn")) return "yarn";
    return "npm";
  }
  if (exists(join(tree, "uv.lock")) || UV_WORKSPACE.test(pyproject(tree))) return "uv";
  if (exists(join(tree, "poetry.lock")) || /^\[tool\.poetry\]/m.test(pyproject(tree))) return "poetry";
  if (exists(join(tree, "pyproject.toml")) || exists(join(tree, "requirements.txt")) || exists(join(tree, "setup.py"))) return "pip";
  return null;
}

const PACKAGE_STACKS = ["npm", "npm-workspaces", "pnpm", "yarn", "yarn-berry", "yarn-berry-unpinned", "bun", "pip", "uv", "uv-workspace", "poetry"] as const;

// The support entry a Node or Python component falls under, from its own package manager or the root's.
function stackOf(tree: string, c: Component, rootPm: PackageManager | null, workspaceMember: boolean): (typeof PACKAGE_STACKS)[number] {
  const pm = c.packageManager ?? rootPm;
  if (c.language === "py") {
    if (pm === "poetry") return "poetry";
    if ((UV_WORKSPACE.test(pyproject(tree)) && (c.path === "." || workspaceMember)) || UV_WORKSPACE.test(pyproject(join(tree, c.path)))) return "uv-workspace";
    return pm === "uv" ? "uv" : "pip";
  }
  if (pm === "bun") return "bun";
  if (pm === "yarn") return !yarnBerry(tree, c.path) ? "yarn" : yarnPinned(tree, c.path) ? "yarn-berry" : "yarn-berry-unpinned";
  if (pm === "pnpm") return "pnpm";
  return workspaceMember ? "npm-workspaces" : "npm";
}

function workspacePatterns(tree: string): string[] {
  const pkg = readPackageJson(tree);
  const ws = pkg?.workspaces;
  const fromPkg = Array.isArray(ws) ? ws : ws?.packages ?? [];
  // A Lerna monorepo with no workspaces field lists its packages in lerna.json, packages/* by default.
  if (!fromPkg.length && pkg && !exists(join(tree, "pnpm-workspace.yaml")) && exists(join(tree, "lerna.json"))) {
    try {
      const lerna = readJson<{ packages?: string[] }>(join(tree, "lerna.json"));
      return Array.isArray(lerna.packages) && lerna.packages.length ? lerna.packages : ["packages/*"];
    } catch {
      return ["packages/*"];
    }
  }
  const pnpmFile = join(tree, "pnpm-workspace.yaml");
  const fromPnpm: string[] = [];
  if (exists(pnpmFile)) {
    let inPackages = false;
    for (const line of readText(pnpmFile).split("\n")) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/);
        if (m) fromPnpm.push(m[1]);
        else if (/^\S/.test(line)) inPackages = false;
      }
    }
  }
  return [...fromPkg, ...fromPnpm];
}

function languageOf(tree: string, path: string, files: string[]): Language {
  const inside = files.filter((f) => path === "." || f.startsWith(path + "/"));
  if (inside.some((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith(".d.ts"))) return "ts";
  if (exists(join(tree, path, "package.json"))) return "js";
  if (inside.some((f) => f.endsWith(".py"))) return "py";
  return "other";
}

// Source with no manifest, listed by the top-level folder that holds it.
const UNSUPPORTED = sourceRules();

function sanitizeId(name: string): string {
  return name.replace(/^@[^/]+\//, "").replace(/[^A-Za-z0-9._-]/g, "-") || "root";
}

// Lockfiles of the toolchains no language file covers yet, so a component still reports the one it has.
const OTHER_LOCKFILES = ["Podfile.lock"];
const LOCKFILES = [...new Set([...NODE_LOCKFILES, ...PY_LOCKFILES, ...lockfileNames(), ...OTHER_LOCKFILES])];
// Pods/ and Carthage/ hold an Xcode app's vendored dependencies, often committed, and DerivedData/ its build output.
const VENDORED = /^(Pods|Carthage|DerivedData)$/;
// An Xcode project or workspace is a folder of its own files; the scan sees it as one name, and
// the file git tracks inside it is the manifest.
const XCODE_BUNDLE = /\.(xcodeproj|xcworkspace)$/;
const XCODE_MANIFEST: Record<string, string> = { xcodeproj: "project.pbxproj", xcworkspace: "contents.xcworkspacedata" };

// Manifests of every language file, by rank: a solution file claims its folder before a project
// file does, and a folder of .tf files is a Terraform module at any depth.
const UNSUPPORTED_MANIFESTS = manifestRules();

interface FoundManifest {
  dir: string;
  kind: "js" | "py" | "other";
  manifest: string;
  stack?: string;
  language?: LanguageDef;
}

const within = (dir: string, parent: string) => parent === "." || dir === parent || dir.startsWith(parent + "/");

// A folder a component already holds, with the kind of manifest it has.
interface Claim {
  path: string;
  kind: "js" | "py" | "other";
}

const claimKind = (c: { language?: Language; manifest?: string | null }): Claim["kind"] => (c.manifest?.endsWith("package.json") ? "js" : c.language === "py" ? "py" : "other");
const deepestFound = (xs: FoundManifest[], dir: string) => xs.filter((x) => within(dir, x.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];

// Folders that usually hold tests, samples or tooling next to the product. A manifest there is a
// satellite: it becomes a component only when the repo has nothing else to assess.
const SATELLITE_SEGMENT = /^(tests?|__tests__|specs?|e2e|samples?|examples?|demos?|bench|benchmarks?|plugins?|utils?|configs?|tooling|dev|scripts)$/;
const EXAMPLE_SEGMENT = /^(samples?|examples?|demos?|bench|benchmarks?)$/;
// Packaging and mobile platform folders, such as a Homebrew formula next to a Rust CLI or the
// android/ shell of a Flutter app, hold another toolchain's files without being another product.
const PACKAGING_SEGMENT = /^(HomebrewFormula|Formula|pkg|packaging|android|ios|debian|rpm|snap)$/;
const MOBILE_SEGMENT = /^(android|ios)$/;

// An android/ or ios/ folder is a cross-platform app's shell only when the folder holding it is a
// React Native, Capacitor or Flutter project; next to anything else it is a native app of its own.
function packagingSegment(tree: string, dir: string): string | undefined {
  const parts = dir.split("/");
  const i = parts.findIndex((s) => PACKAGING_SEGMENT.test(s));
  if (i < 0) return undefined;
  if (!MOBILE_SEGMENT.test(parts[i])) return parts[i];
  const parent = parts.slice(0, i).join("/") || ".";
  return exists(join(tree, parent, "package.json")) || exists(join(tree, parent, "pubspec.yaml")) ? parts[i] : undefined;
}
const CONFIG_PACKAGE = /^(@[^/]+\/)?((eslint|prettier|stylelint|babel|jest|vitest|tsconfig|typescript)-config(-[\w.-]+)?|eslint-config|tsconfig|config)$/;

// A Python manifest under docs/ is usually the docs build's requirements, such as Sphinx or MkDocs.
const DOCS_SEGMENT = /^(docs?|documentation|website)$/i;

const SATELLITE_HOLDS = "tests, samples or tooling";
const PACKAGING_HOLDS = "packaging or a mobile platform shell";

const hasTestScript = (scripts: Record<string, string> | undefined) => Boolean(scripts?.test && !/no test specified/.test(scripts.test));

// A folder-name hint that the project is a satellite, and the folder the hint names, whose share of
// changes decides whether the hint holds.
interface Hint {
  reason: string;
  folder: string;
}

function satelliteHint(tree: string, m: FoundManifest): Hint | null {
  const parts = m.dir.split("/");
  const upTo = (s: string) => parts.slice(0, parts.indexOf(s) + 1).join("/");
  const segment = parts.find((s) => SATELLITE_SEGMENT.test(s));
  if (segment) return { reason: `it sits under ${segment}/, which usually holds ${SATELLITE_HOLDS} rather than the product`, folder: upTo(segment) };
  // A Python manifest or a package with no tests under docs/ is the documentation build or site.
  const docsBuild = m.kind === "py" || (m.kind === "js" && !hasTestScript(readPackageJson(join(tree, m.dir))?.scripts));
  const docs = docsBuild ? parts.find((s) => DOCS_SEGMENT.test(s)) : undefined;
  if (docs) return { reason: `it sits under ${docs}/, which usually holds the documentation build rather than the product`, folder: upTo(docs) };
  const packaging = m.kind === "other" ? packagingSegment(tree, m.dir) : undefined;
  if (packaging) return { reason: `it sits under ${packaging}/, which usually holds ${PACKAGING_HOLDS} rather than the product`, folder: upTo(packaging) };
  const name = m.kind === "js" ? readPackageJson(join(tree, m.dir))?.name : undefined;
  if (name && CONFIG_PACKAGE.test(name)) return { reason: `${name} is a shared config package, not a product`, folder: m.dir };
  return null;
}

export interface LayoutOptions {
  // The share of every counted change under a folder, once the history has been read.
  shareOf?: (dir: string) => number;
  // A hint demotes only while the folder it names holds less than this share.
  hintShare?: number;
}

// A hint demotes a project to a satellite, unless the folder it names holds enough of the changes
// that the hint is wrong, as with a plugins/ folder that holds most of the work.
function satelliteReason(tree: string, m: FoundManifest, opts: LayoutOptions = {}): string | null {
  const hint = satelliteHint(tree, m);
  if (!hint) return null;
  if (opts.shareOf && opts.hintShare !== undefined && opts.shareOf(hint.folder) >= opts.hintShare) return null;
  return hint.reason;
}

// A manifest that only lists other projects, such as a Dart workspace's root pubspec.yaml.
function workspaceOnly(tree: string, manifestPath: string, language: LanguageDef): boolean {
  return Boolean(language.detect.workspaceOnly?.(manifestPath, readText(join(tree, manifestPath))));
}

// Several solution or project files in one folder: the one named after the folder or repo, else the
// shortest name, so ShareX isn't named after ShareX.ImageEditor.sln.
function pickManifest(names: string[], preferred: string): string {
  const stem = (n: string) => n.replace(/\.\w+$/, "").toLowerCase();
  const sorted = [...names].sort((a, b) => (a === "main.tf" ? -1 : b === "main.tf" ? 1 : a.length - b.length || a.localeCompare(b)));
  return sorted.find((n) => stem(n) === preferred.toLowerCase()) ?? sorted[0];
}

// Every manifest in the tree, at any depth, outside workspace members. A supported package owns
// the folders under it; one nested in an unsupported project (a web client inside a .NET project)
// is still its own component, and so is a nested project the language builds apart, such as a nested
// go.mod. Next to a root package of the same language, only nested packages with their own lockfile
// count; a Python service next to a Node root can't be part of it.
function discoverManifests(tree: string, files: string[], claimed: Claim[], hasRoot: boolean, rootPy: boolean, repoName: string, opts: LayoutOptions, seeds: FoundManifest[] = []): { found: FoundManifest[]; satellites: (FoundManifest & { reason: string })[] } {
  const byDir = new Map<string, string[]>();
  for (const [dir, names] of namesByDir(files)) if (!skipSegment(dir, LOCKFILES.some((l) => names.includes(l)))) byDir.set(dir, names);
  const found: FoundManifest[] = [];
  const satellites: (FoundManifest & { reason: string })[] = [];
  const add = (m: FoundManifest) => {
    const reason = m.dir === "." ? null : satelliteReason(tree, m, opts);
    if (reason) satellites.push({ ...m, reason });
    else found.push(m);
  };
  for (const dir of [...byDir.keys()].sort((a, b) => (a === "." ? -1 : b === "." ? 1 : a.split("/").length - b.split("/").length || a.localeCompare(b)))) {
    const names = byDir.get(dir)!;
    const has = (n: string) => names.includes(n);
    const claim = deepest(claimed, dir);
    if (claim?.path === dir) continue;
    // The deepest project holding the folder: a component already placed, or a Node or Python
    // manifest found above it. A web client inside an unsupported project is still its own.
    const package_ = deepestFound([...found, ...satellites].filter((f) => f.kind !== "other"), dir);
    const outer = [claim, package_ && { path: package_.dir, kind: package_.kind }].filter((x): x is Claim => Boolean(x)).sort((a, b) => b.path.length - a.path.length)[0];
    // A Node package with its own lockfile inside a Python project, such as a UI inside a Python
    // package, is a project of its own, and so is a locked Python project inside a Node package.
    const free = (kind: "js" | "py") => !outer || (outer.kind !== "other" && outer.kind !== kind && (kind === "js" ? NODE_LOCKFILES : PY_LOCKFILES).some(has));
    if (dir !== "." && has("package.json") && free("js") && (!hasRoot || NODE_LOCKFILES.some(has))) {
      add({ dir, kind: "js", manifest: `${dir}/package.json` });
      continue;
    }
    const py = pythonManifest(names);
    if (dir !== "." && py && free("py") && (!hasRoot || !rootPy || PY_LOCKFILES.some(has))) {
      add({ dir, kind: "py", manifest: `${dir}/${py}` });
      continue;
    }
    if (claim) continue;
    const rule = UNSUPPORTED_MANIFESTS.find((u) => names.some((n) => u.match.test(n)));
    if (!rule || (dir === "." && hasRoot)) continue;
    const enclosing = [...seeds.filter((s) => s.language === rule.language), ...found, ...satellites].filter((f) => within(dir, f.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
    const apart = enclosing && enclosing.kind === "other" && enclosing.language === rule.language && Boolean(rule.language.detect.ownUnit?.(tree, enclosing.dir, dir));
    if (enclosing && !apart) continue;
    const picked = pickManifest(names.filter((n) => rule.match.test(n)), dir === "." ? repoName : basename(dir));
    const bundle = picked.match(XCODE_BUNDLE)?.[1];
    const project = bundle ? `${picked}/${XCODE_MANIFEST[bundle]}` : picked;
    const manifest = dir === "." ? project : `${dir}/${project}`;
    if (workspaceOnly(tree, manifest, rule.language)) continue;
    add({ dir, kind: "other", manifest, stack: rule.language.detect.refine?.(manifest, readText(join(tree, manifest)), tree) ?? rule.stack, language: rule.language });
  }
  return { found, satellites };
}

// The name a root-level project gives itself, so a Go module isn't called "go". A root with no
// name of its own, such as a Terraform module, takes the repo's.
function projectName(tree: string, manifest: string, repoName: string): string {
  const text = exists(join(tree, manifest)) ? readText(join(tree, manifest)) : "";
  if (manifest === "pyproject.toml") return text.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] ?? repoName;
  for (const l of LANGUAGES) {
    const named = l.detect.projectName?.(tree, manifest, text, repoName);
    if (named) return named;
  }
  return repoName;
}

function lockfileIn(tree: string, dir: string): string | null {
  const name = LOCKFILES.find((l) => exists(join(tree, dir, l)));
  return name ? (dir === "." ? name : `${dir}/${name}`) : null;
}

export function discoverComponents(tree: string, files: string[], repoName?: string): Component[] {
  return discoverLayout(tree, files, repoName).components;
}

// A test script that runs the members' own scripts rather than a test runner over the code.
export const DELEGATES = /--workspaces?\b|(^|\s)-ws\b|(^|\s)(-r|--recursive)\b|--filter\b|\b(turbo|lerna|nx|wsrun|ultra)\b|\bworkspaces\s+(foreach|run)\b/;
const SCRIPT_CALL = /^(?:npm\s+run(?:-script)?|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun\s+run)\s+([\w:.-]+)\s*$/;

// The test runner the workspace root runs itself, following a script that only calls another one.
function rootRunsTests(scripts: Record<string, string> | undefined): boolean {
  let script = scripts?.test;
  for (let hop = 0; script && hop < 3; hop++) {
    if (/no test specified/.test(script) || DELEGATES.test(script)) return false;
    const next = script.trim().match(SCRIPT_CALL)?.[1];
    if (!next || !scripts?.[next]) return true;
    script = scripts[next];
  }
  return false;
}

// A workspace member whose test script, past the scripts it only calls, hands over to another
// language's build tool on a manifest in the same folder, such as `"test": "pnpm run rust:test"` and
// `"rust:test": "cargo test --locked"` next to Cargo.toml: a project of that language, tested its way.
function wrappedProject(tree: string, dir: string, names: string[], scripts: Record<string, string>): { manifest: string; stack: string } | null {
  let body = scripts.test;
  for (let hop = 0; body && hop < 3; hop++) {
    const next = body.trim().match(SCRIPT_CALL)?.[1];
    if (!next || !scripts[next]) break;
    body = scripts[next];
  }
  if (!body || /no test specified/.test(body)) return null;
  for (const rule of UNSUPPORTED_MANIFESTS) {
    const runners = rule.language.detect.runners;
    const name = names.filter((n) => rule.match.test(n)).sort()[0];
    if (!runners || !name || !runners.test(body) || !rule.language.replay) continue;
    const manifest = `${dir}/${name}`;
    return { manifest, stack: rule.language.detect.refine?.(manifest, readText(join(tree, manifest)), tree) ?? rule.stack };
  }
  return null;
}

const JS_TEST = /(^|\/)(__tests__\/.+|[^/]+\.(test|spec)\.[cm]?[jt]sx?)$/;

// Tests of the root's own outside its members, such as the repo's scripts with their tests. A lint
// script with no tests beside it is tooling, not a project.
function rootTests(files: string[], elsewhere: string[]): boolean {
  return files.some((f) => JS_TEST.test(f) && !f.split("/").slice(0, -1).some((s) => s.startsWith(".") || SKIP_SEGMENT.test(s)) && !elsewhere.some((p) => within(f, p)));
}

const ROOT_APP_MANIFESTS: { names: string[]; match?: RegExp; stack: string; toolchain: string; suffix: string; language?: LanguageDef }[] = [
  { names: ["pyproject.toml", "setup.py", "requirements.txt"], stack: "python-behind-root-package", toolchain: "Python", suffix: "python" },
  ...rootAppRules(),
];

// A project in a language file's stack: scored when the stack is in the supported tier and the file
// has replay hooks, otherwise listed by name and share with the reason it isn't.
function languageComponent(tree: string, base: { id: string; path: string; manifest: string | null }, stackId: string, toolchain?: string): Component {
  const comp = { ...base, scripts: {}, changes: 0, changeShare: 0, assessed: false, toolchain: toolchain ?? stack(stackId).label, stack: stackId };
  const lang = languageOfStack(stackId);
  if (lang?.replay && supported(stackId)) {
    if (!base.manifest) return { ...comp, language: "other", notAssessedReason: `${stack(stackId).label} source with no manifest of its own, so the audit has nothing to install or test it from` };
    const c = lang.replay.classify(tree, base.path, base.manifest);
    return { ...comp, language: c.language, packageManager: c.packageManager };
  }
  const notes = lang?.detect.notes?.(tree, base.path, stackId) ?? [];
  return { ...comp, language: "other", notAssessedReason: `${notSupportedReason(stackId)}${notes.length ? `. Read from its files without running anything: ${notes.join("; ")}` : ""}` };
}

// A root package.json often holds only release tooling or a frontend bundle for the real app at the
// root, such as Django, Laravel or Rails. That app is listed with its own share of changes.
function rootApps(tree: string, files: string[], repoName: string): Component[] {
  const out: Component[] = [];
  const hasPy = files.some((f) => f.endsWith(".py") && !f.split("/").some((s) => SKIP_SEGMENT.test(s)));
  const rootNames = files.filter((f) => !f.includes("/"));
  for (const r of ROOT_APP_MANIFESTS) {
    const matched = r.match ? rootNames.filter((n) => r.match!.test(n)) : [];
    const manifest = r.names.find((n) => exists(join(tree, n))) ?? (matched.length ? pickManifest(matched, repoName) : undefined);
    if (!manifest || (r.suffix === "python" && !hasPy)) continue;
    const id = sanitizeId(projectName(tree, manifest, repoName));
    if (r.suffix === "python") out.push({ id, path: ".", language: "py", manifest, scripts: {}, changes: 0, changeShare: 0, assessed: false, toolchain: r.toolchain, stack: r.stack, notAssessedReason: notSupportedReason(r.stack) });
    else out.push(languageComponent(tree, { id, path: ".", manifest }, r.language?.detect.refine?.(manifest, readText(join(tree, manifest)), tree) ?? r.stack, r.toolchain));
  }
  return out;
}

const JS_SOURCE = /\.(c|m)?[jt]sx?$/;
const JS_CONFIG = /(^|\/)[^/]*(\.config|rc)\.(c|m)?[jt]s$/;

// A root package.json next to the repo's real projects that holds only repo tooling, such as
// markdownlint: no dependencies, entry points or tests, and no source of its own. It names the tools,
// or null when the root is a package.
function toolingOnlyRoot(tree: string, files: string[], others: Component[], elsewhere: string[]): string[] | null {
  const pkg = readPackageJson(tree) as (ReturnType<typeof readPackageJson> & Record<string, unknown>) | null;
  if (!pkg || others.length === 0) return null;
  const deps = ["dependencies", "peerDependencies", "optionalDependencies"].some((k) => Object.keys((pkg[k] as Record<string, string> | undefined) ?? {}).length > 0);
  const entry = ["main", "module", "exports", "bin", "types", "browser"].some((k) => pkg[k] !== undefined);
  const test = pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test);
  if (deps || entry || test) return null;
  const ownSource = files.some((f) => JS_SOURCE.test(f) && !f.endsWith(".d.ts") && !JS_CONFIG.test(f) && !f.split("/").slice(0, -1).some((s) => s.startsWith(".") || SKIP_SEGMENT.test(s)) && ![...others.map((c) => c.path), ...elsewhere].some((p) => within(f, p)));
  const tools = Object.keys((pkg.devDependencies as Record<string, string> | undefined) ?? {});
  return ownSource || tools.length === 0 ? null : tools;
}

export interface Layout {
  components: Component[];
  satellites: Profile["satellites"];
  members: NonNullable<Profile["members"]>;
  units: Unit[];
}

const deepest = <T extends { path: string }>(xs: T[], dir: string) => xs.filter((x) => within(dir, x.path)).sort((a, b) => b.path.length - a.path.length)[0];

// Where every folder that holds a manifest ended up. Each is placed exactly once; one that nothing
// accounts for is "unplaced", which the report lists rather than dropping it.
function placeUnits(files: string[], layout: Omit<Layout, "units">, workspace: { members: Set<string>; excluded: string[] }): Unit[] {
  const { components, satellites, members } = layout;
  return inventory(files, LOCKFILES).map((e): Unit => {
    const at = { path: e.dir, manifest: e.manifest };
    const comp = components.find((c) => c.path === e.dir && c.manifest);
    if (comp) return { ...at, placement: "component", source: workspace.members.has(e.dir) ? "workspace" : "manifest", reason: comp.notAssessedReason ? `a component, not assessed: ${comp.notAssessedReason}` : "a component" };
    const member = members.find((m) => m.path === e.dir);
    if (member) return { ...at, placement: "member", of: member.of, source: "workspace", reason: member.reason };
    const sat = satellites.find((x) => x.path === e.dir);
    if (sat) return { ...at, placement: "satellite", ...(deepest(components, e.dir) ? { of: deepest(components, e.dir).path } : {}), source: "hint", reason: sat.reason };
    if (e.skippedBy) return { ...at, placement: "excluded", source: "hint", reason: `it sits under ${e.skippedBy}/, which holds vendored, generated or test files` };
    if (workspace.excluded.some((d) => within(e.dir, d))) return { ...at, placement: "excluded", source: "workspace", reason: "the workspace leaves it out" };
    const owner = deepest(components, e.dir);
    if (owner) return { ...at, placement: "member", of: owner.path, source: "manifest", reason: `it sits inside ${owner.path === "." ? "the root project" : owner.path} and isn't a project of its own` };
    const satOwner = deepest(satellites, e.dir);
    if (satOwner) return { ...at, placement: "satellite", source: "hint", reason: `it sits inside ${satOwner.path}, ${satOwner.reason.replace(/^it /, "which ")}` };
    if (e.dir === ".") return { ...at, placement: "satellite", source: "workspace", reason: "the workspace root, which lists the projects under it" };
    return { ...at, placement: "unplaced", source: "manifest", reason: "the scan couldn't place it" };
  });
}

export function discoverLayout(tree: string, files: string[], repoName = basename(tree), opts: LayoutOptions = {}): Layout {
  const comps: Component[] = [];
  const memberSatellites: Profile["satellites"] = [];
  const memberList: Layout["members"] = [];
  const members = new Set<string>();
  const patterns = workspacePatterns(tree);
  // Folders the workspace leaves out on purpose aren't components of their own either.
  const included = patterns.filter((p) => !p.trim().startsWith("!"));
  const listed = included.length ? workspaceDirs(tree, patterns) : [];
  const excludedDirs = included.length < patterns.length ? workspaceDirs(tree, included).filter((d) => !listed.includes(d)) : [];
  if (included.length) {
    const all = listed.filter((d) => exists(join(tree, d, "package.json")));
    // Workspace members under tooling/ or examples/ are satellites too, unless nothing else exists.
    const reasons = new Map(all.map((d) => [d, d === "." ? null : satelliteReason(tree, { dir: d, kind: "js", manifest: `${d}/package.json` }, opts)]));
    const product = all.filter((d) => !reasons.get(d));
    const dirs = product.length ? product : all;
    if (product.length) for (const d of all.filter((x) => reasons.get(x))) memberSatellites.push({ path: d, manifest: `${d}/package.json`, toolchain: "Node", reason: reasons.get(d)! });
    // The workspace root is a project of its own beside its members when it runs a test runner itself,
    // as an app at the root of a pnpm workspace does, or has tests of its own. Members with no test
    // script of their own are then built and tested through the root's test run.
    const rootPkg = readPackageJson(tree);
    const rootProject = Boolean(rootPkg) && !dirs.includes(".") && (rootRunsTests(rootPkg?.scripts) || rootTests(files, [...all, ...excludedDirs]));
    const rootRuns = rootProject && rootRunsTests(rootPkg?.scripts);
    const rootId = sanitizeId(rootPkg?.name ?? "root");
    if (rootProject) comps.push({ id: rootId, path: ".", language: languageOf(tree, ".", files), manifest: "package.json", scripts: rootPkg?.scripts ?? {}, changes: 0, changeShare: 0, assessed: false });
    const names = namesByDir(files);
    for (const dir of dirs) {
      const pkg = readPackageJson(join(tree, dir));
      members.add(dir);
      const wraps = dir === "." ? null : wrappedProject(tree, dir, names.get(dir) ?? [], pkg?.scripts ?? {});
      if (wraps) {
        comps.push(languageComponent(tree, { id: sanitizeId(basename(dir)), path: dir, manifest: wraps.manifest }, wraps.stack));
        continue;
      }
      if (rootRuns && dir !== "." && !hasTestScript(pkg?.scripts)) {
        memberList.push({ path: dir, manifest: `${dir}/package.json`, of: ".", reason: "it has no test script of its own, so the workspace root's test run covers it" });
        continue;
      }
      comps.push({
        id: dir === "." ? sanitizeId(pkg?.name ?? "root") : sanitizeId(basename(dir)),
        path: dir,
        language: languageOf(tree, dir, files),
        manifest: dir === "." ? "package.json" : `${dir}/package.json`,
        scripts: pkg?.scripts ?? {},
        changes: 0,
        changeShare: 0,
        assessed: false,
      });
    }
  } else if (exists(join(tree, "package.json"))) {
    const pkg = readPackageJson(tree);
    comps.push({ id: sanitizeId(pkg?.name ?? "root"), path: ".", language: languageOf(tree, ".", files), manifest: "package.json", scripts: pkg?.scripts ?? {}, changes: 0, changeShare: 0, assessed: false });
  } else if (exists(join(tree, "pyproject.toml")) || exists(join(tree, "setup.py")) || exists(join(tree, "requirements.txt"))) {
    const manifest = exists(join(tree, "pyproject.toml")) ? "pyproject.toml" : exists(join(tree, "setup.py")) ? "setup.py" : "requirements.txt";
    const pyName = exists(join(tree, "pyproject.toml")) ? readText(join(tree, "pyproject.toml")).match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] : undefined;
    comps.push({ id: sanitizeId(pyName ?? "app"), path: ".", language: "py", manifest, scripts: {}, changes: 0, changeShare: 0, assessed: false });
    const uvMembers = uvWorkspaceMembers(tree);
    // A workspace root with no [project] of its own is virtual: only its members are projects.
    if (uvMembers.length && !/^\[project\]/m.test(pyproject(tree))) comps.pop();
    // Members under dev/, scripts/ or docs/ are tooling, as in a Node workspace, unless nothing else is.
    const uvReasons = new Map(uvMembers.map((d) => [d, satelliteReason(tree, { dir: d, kind: "py", manifest: `${d}/pyproject.toml` }, opts)]));
    const uvProduct = uvMembers.some((d) => !uvReasons.get(d));
    for (const dir of uvMembers) {
      members.add(dir);
      if (uvProduct && uvReasons.get(dir)) {
        memberSatellites.push({ path: dir, manifest: `${dir}/pyproject.toml`, toolchain: "Python", reason: uvReasons.get(dir)! });
        continue;
      }
      const name = pyproject(join(tree, dir)).match(/^name\s*=\s*["']([^"']+)["']/m)?.[1];
      comps.push({ id: sanitizeId(name ?? basename(dir)), path: dir, language: "py", manifest: `${dir}/pyproject.toml`, scripts: {}, changes: 0, changeShare: 0, assessed: false });
    }
  }
  const hasRoot = comps.some((c) => c.path === ".");
  if (exists(join(tree, "package.json"))) {
    const apps = rootApps(tree, files, repoName);
    const jsRoot = comps.find((c) => c.path === "." && c.manifest === "package.json");
    // A root package without a test script of its own goes with the app at the root, such as Django or
    // Laravel: it isn't assessed apart from that app, so its missing tests never read as the repo's.
    const unscored = apps.filter((a) => a.notAssessedReason);
    if (jsRoot && unscored.length && !hasTestScript(jsRoot.scripts)) {
      jsRoot.notAssessedReason = `it goes with the ${unscored[0].toolchain} app at the root, which isn't supported yet, so it isn't assessed on its own`;
    }
    for (const app of apps) {
      if (comps.some((c) => c.id === app.id)) app.id = sanitizeId(`${app.id}-${ROOT_APP_MANIFESTS.find((r) => r.stack === app.stack)!.suffix}`);
      comps.push(app);
    }
  }
  const rootPy = comps.some((c) => c.path === "." && c.language === "py");
  // A project of another language at the root, beside the root package.json, owns its language's
  // projects under it, as it would with no package.json: a solution's .csproj files are its members.
  const seeds: FoundManifest[] = comps.filter((c) => c.path === "." && c.stack && c.manifest && c.manifest !== "package.json" && languageOfStack(c.stack)).map((c) => ({ dir: ".", kind: "other", manifest: c.manifest!, stack: c.stack, language: languageOfStack(c.stack) }));
  for (const s of seeds) {
    const comp = comps.find((c) => c.path === "." && c.manifest === s.manifest)!;
    if (comp.notAssessedReason) continue;
    for (const p of s.language?.detect.parts?.(tree, ".") ?? []) comps.push(languageComponent(tree, { id: sanitizeId(basename(p.path)), path: p.path, manifest: p.manifest }, p.stack));
  }
  const claims: Claim[] = [...comps.filter((c) => c.path !== ".").map((c) => ({ path: c.path, kind: claimKind(c) })), ...memberSatellites.map((s) => ({ path: s.path, kind: claimKind({ manifest: s.manifest, language: s.toolchain === "Python" ? "py" : undefined }) })), ...memberList.map((m) => ({ path: m.path, kind: claimKind(m) })), ...excludedDirs.map((d) => ({ path: d, kind: "other" as const }))];
  const { found, satellites } = discoverManifests(tree, files, claims, hasRoot, rootPy, repoName, opts, seeds);
  const deferred = comps.length === 0 && found.length === 0;
  for (const m of deferred ? satellites : found) {
    const pkg = m.kind === "js" ? readPackageJson(join(tree, m.dir)) : null;
    let id = sanitizeId(m.dir === "." ? projectName(tree, m.manifest, repoName) : basename(m.dir));
    if (comps.some((c) => c.id === id)) id = sanitizeId(m.dir.replace(/\//g, "-"));
    if (m.kind === "other") {
      const comp = languageComponent(tree, { id, path: m.dir, manifest: m.manifest }, m.stack!);
      comps.push(comp);
      if (comp.notAssessedReason) continue;
      for (const p of m.language?.detect.parts?.(tree, m.dir) ?? []) {
        let partId = sanitizeId(basename(p.path));
        if (comps.some((c) => c.id === partId)) partId = sanitizeId(p.path.replace(/\//g, "-"));
        comps.push(languageComponent(tree, { id: partId, path: p.path, manifest: p.manifest }, p.stack));
      }
    } else {
      comps.push({ id, path: m.dir, language: m.kind === "js" ? languageOf(tree, m.dir, files) : "py", manifest: m.manifest, scripts: pkg?.scripts ?? {}, changes: 0, changeShare: 0, assessed: false, packageManager: detectPackageManager(join(tree, m.dir)) });
    }
  }
  // A tooling-only root would take every change outside the projects and set the level with no tests.
  const roots = comps.filter((c) => c.path === ".");
  if (!included.length && roots.length === 1 && roots[0].manifest === "package.json") {
    const tools = toolingOnlyRoot(tree, files, comps.filter((c) => c.path !== "."), [...memberSatellites.map((s) => s.path), ...satellites.map((s) => s.dir)]);
    if (tools) {
      comps.splice(comps.indexOf(roots[0]), 1);
      memberSatellites.push({ path: ".", manifest: "package.json", toolchain: "Node", reason: `it holds only repo tooling (${tools.slice(0, 3).join(", ")}${tools.length > 3 ? ` and ${tools.length - 3} more` : ""}) and no product code, so the projects under it are the components` });
    }
  }
  const rootPm = detectPackageManager(tree);
  // A workspace member installs from the workspace root's lockfile.
  const rootLockfile = lockfileIn(tree, ".");
  for (const c of comps) {
    c.lockfile = lockfileIn(tree, c.path) ?? (members.has(c.path) ? rootLockfile : null);
    if (c.stack || c.language === "other") continue;
    c.stack = stackOf(tree, c, rootPm, members.has(c.path) && c.path !== ".");
    if (!supported(c.stack) && !c.notAssessedReason) c.notAssessedReason = notSupportedReason(c.stack);
  }
  const satelliteList: Profile["satellites"] = [...memberSatellites, ...(deferred ? [] : satellites.map((s) => ({ path: s.dir, manifest: s.manifest, toolchain: s.kind === "js" ? "Node" : s.kind === "py" ? "Python" : stack(s.stack!).label, reason: s.reason })))];
  // Unsupported source with no manifest, such as infra/*.tf, is listed by its top-level folder,
  // next to a root package too, so the root doesn't take its share of changes.
  const rootOnly = comps.length > 0 && comps.every((c) => c.path === ".");
  const rootStacks = new Set(comps.filter((c) => c.path === ".").map((c) => c.stack));
  const claimed = new Set([...comps.map((c) => c.path), ...satelliteList.map((s) => s.path), ...memberList.map((m) => m.path)].map((p) => p.split("/")[0]));
  const topDirs = [...new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]))].filter((d) => !d.startsWith(".") && !claimed.has(d) && !VENDORED.test(d) && !OUTPUT_SEGMENT.test(d));
  for (const dir of topDirs.sort()) {
    const inside = files.filter((f) => f.startsWith(dir + "/"));
    const hit = UNSUPPORTED.find((u) => inside.some((f) => u.ext.test(f)));
    if (!hit) continue;
    // A root project's own folders, such as a Go root's packages or a PHP app's tests/, are part of
    // it; only its examples are listed apart.
    // By language, so a root build a language file refined (a Gradle build applying the Android
    // plugin) still owns its source folders.
    if ([...rootStacks].some((s) => sameLanguage(s, hit.stack)) && !EXAMPLE_SEGMENT.test(dir)) continue;
    const holds = SATELLITE_SEGMENT.test(dir) ? SATELLITE_HOLDS : packagingSegment(tree, dir) ? PACKAGING_HOLDS : null;
    if (holds && comps.length > 0) {
      // No manifest of its own: the folder is listed, never one of its source files as if it were one.
      satelliteList.push({ path: dir, manifest: null, toolchain: stack(hit.stack).label, reason: `it sits under ${dir}/, which usually holds ${holds} rather than the product` });
      continue;
    }
    if (rootOnly && NOT_A_PROJECT.test(dir)) continue;
    comps.push({ ...languageComponent(tree, { id: sanitizeId(dir), path: dir, manifest: null }, hit.stack), lockfile: null });
  }
  const layout = { components: uniqueIds(comps), satellites: satelliteList, members: memberList };
  return { ...layout, units: placeUnits(files, layout, { members, excluded: excludedDirs }) };
}

function sameLanguage(a: string | undefined, b: string): boolean {
  const la = languageOfStack(a);
  return a === b || (la !== undefined && la === languageOfStack(b));
}

// Every support entry the scan can put a component in; tests/supported.test.ts checks each is listed.
// A language file that refines a manifest's stack can assign any of its stacks.
export const DETECTED_STACKS: string[] = [...new Set([...PACKAGE_STACKS, ...UNSUPPORTED.map((u) => u.stack), ...UNSUPPORTED_MANIFESTS.map((u) => u.stack), ...ROOT_APP_MANIFESTS.map((r) => r.stack), ...LANGUAGES.filter((l) => l.detect.refine).flatMap((l) => l.stacks.map((s) => s.id))])];

// Folders that hold a root package's own tests, docs and samples rather than another project.
const NOT_A_PROJECT = /^(tests?|spec|__tests__|examples?|samples?|docs?|fixtures?|vendor|third_party|node_modules|scripts|tools|tooling|bin)$/;

// Two folders with one name, such as apps/api and services/api, would merge into one component.
function uniqueIds(comps: Component[]): Component[] {
  const count = new Map<string, number>();
  for (const c of comps) count.set(c.id, (count.get(c.id) ?? 0) + 1);
  const taken = new Set<string>();
  for (const c of comps) {
    if ((count.get(c.id) ?? 0) > 1 && c.path !== ".") c.id = sanitizeId(c.path.replace(/\//g, "-"));
    let id = c.id;
    for (let i = 2; taken.has(id); i++) id = `${c.id}-${i}`;
    c.id = id;
    taken.add(id);
  }
  return comps;
}

function nodePins(tree: string, dir: string, pm: PackageManager | null, label: string, found: string[], missing: string[]): void {
  const pkg = readPackageJson(join(tree, dir));
  const prefix = dir === "." ? "" : `${dir}/`;
  // A Bun project runs on Bun, so the Bun version is the pin that matters.
  if (pm === "bun") {
    const bunPin = [".bun-version", ".tool-versions"].find((f) => exists(join(tree, dir, f)) || exists(join(tree, f)));
    if (/^bun@/.test(pkg?.packageManager ?? "")) found.push(`${prefix}package.json packageManager`);
    else if (pkg?.engines?.bun) found.push(`${prefix}package.json engines.bun`);
    else if (bunPin) found.push(exists(join(tree, dir, bunPin)) ? `${prefix}${bunPin}` : bunPin);
    else missing.push(`the Bun version${label} (packageManager or engines.bun in package.json)`);
    return;
  }
  const nodePin = [".nvmrc", ".node-version", ".tool-versions"].find((f) => exists(join(tree, dir, f)) || exists(join(tree, f)));
  if (nodePin) found.push(exists(join(tree, dir, nodePin)) ? `${prefix}${nodePin}` : nodePin);
  else if (pkg?.engines?.node) found.push(`${prefix}package.json engines.node`);
  else if (pkg?.volta?.node) found.push(`${prefix}package.json volta`);
  else missing.push(`the Node version${label} (.nvmrc or engines.node)`);
  if (pm === "pnpm" || pm === "yarn") {
    const path = pm === "yarn" ? yarnPath(tree, dir) : null;
    if (pkg?.packageManager) found.push(`${prefix}package.json packageManager`);
    else if (path) found.push(`${path} yarnPath`);
    else missing.push(`the ${pm} version${label} (packageManager in package.json)`);
  }
}

// Versions the repo's declared image pins, which count the same as a pin file.
function dockerfilePins(tree: string, dockerfile: string | undefined): { node: boolean; pm: Set<string>; python: boolean } {
  const out = { node: false, pm: new Set<string>(), python: false };
  if (!dockerfile || !exists(join(tree, ".cursor", dockerfile))) return out;
  let path: string;
  try {
    path = containedPath(tree, [".cursor", dockerfile], ".cursor/environment.json");
  } catch {
    return out;
  }
  const text = readText(path);
  out.node = /^\s*FROM\s+(?:\S+\/)?node:\d/im.test(text) || /^\s*(ARG|ENV)\s+NODE_(VERSION|MAJOR)[= ]\s*\d/im.test(text);
  out.python = /^\s*FROM\s+(?:\S+\/)?python:\d/im.test(text) || /^\s*(ARG|ENV)\s+PYTHON_(VERSION|MAJOR)[= ]\s*\d/im.test(text);
  for (const m of text.matchAll(/\b(?:corepack\s+(?:prepare|install\s+-g)|npm\s+(?:i|install)\s+-g)\s+(pnpm|yarn)@\d/g)) out.pm.add(m[1]);
  for (const m of text.matchAll(/^\s*(?:ARG|ENV)\s+(PNPM|YARN)_VERSION[= ]\s*\S/gim)) out.pm.add(m[1].toLowerCase());
  return out;
}

function toolchain(tree: string, files: string[], pm: PackageManager | null, components: Component[], dockerfile?: string) {
  const found: string[] = [];
  let missing: string[] = [];
  const isNode = exists(join(tree, "package.json"));
  const isPy = files.some((f) => f.endsWith(".py"));
  const nodeLang = (c: Component) => c.language === "ts" || c.language === "js";
  if (isNode) nodePins(tree, ".", pm, "", found, missing);
  for (const c of components.filter((x) => x.packageManager && x.path !== ".")) {
    if (nodeLang(c)) nodePins(tree, c.path, c.packageManager ?? null, ` for ${c.id}`, found, missing);
  }
  const nodeAnywhere = isNode || components.some((c) => c.packageManager && nodeLang(c));
  if (isPy && !nodeAnywhere) {
    if (exists(join(tree, ".python-version"))) found.push(".python-version");
    else missing.push("the Python version (.python-version)");
  }
  // A language file pins its own toolchain, such as the go line in go.mod.
  for (const c of components) {
    const lang = languageFile(c.language);
    if (!lang?.replay) continue;
    const p = lang.replay.pins(tree, c.path);
    found.push(...p.found);
    missing.push(...p.missing.map((m) => (components.length > 1 ? `${m} for ${c.id}` : m)));
  }
  const pins = dockerfilePins(tree, dockerfile);
  const image = `.cursor/${dockerfile}`;
  missing = missing.filter((m) => !(pins.node && /the Node version/.test(m)) && !(pins.python && /the Python version/.test(m)) && ![...pins.pm].some((p) => m.startsWith(`the ${p} version`)));
  if (pins.node) found.push(`${image} (Node)`);
  if (pins.python) found.push(`${image} (Python)`);
  for (const p of pins.pm) found.push(`${image} (${p})`);
  if (found.length === 0 && missing.length === 0) missing.push("a toolchain version this rubric can read (.nvmrc, engines.node, .python-version or the declared image)");
  return { pinned: missing.length === 0 && found.length > 0, files: [...new Set(found)], missing };
}

// Files written for agents: what they say is what an agent will do.
const AGENT_PATTERNS: RegExp[] = [
  /(^|\/)AGENTS\.md$/,
  /(^|\/)CLAUDE\.md$/,
  /^\.cursorrules$/,
  /^\.cursor\/rules\/.+\.(mdc|md)$/,
  /^\.github\/copilot-instructions\.md$/,
  /^\.github\/instructions\/.+\.instructions\.md$/,
  /^\.(cursor|claude|agents)\/skills\/[^/]+\/SKILL\.md$/,
];

const INSTRUCTION_PATTERNS: RegExp[] = [...AGENT_PATTERNS, /^(\.github\/|docs\/)?CONTRIBUTING\.md$/i, /^README\.md$/i];

export function agentFacing(file: string): boolean {
  return AGENT_PATTERNS.some((p) => p.test(file));
}

// Agent instructions and contributor guides come first and the README last, so a README command
// they already give is checked once, where it's written for people working on the repo.
function instructionRank(f: string): number {
  if (/^README\.md$/i.test(f)) return 2;
  if (/(^|\/)SKILL\.md$/.test(f)) return 1;
  return 0;
}

export function instructionFiles(files: string[]): string[] {
  return files
    .filter((f) => INSTRUCTION_PATTERNS.some((p) => p.test(f)) && !ownSkillPath(f))
    .map((f, i) => ({ f, i }))
    .sort((a, b) => instructionRank(a.f) - instructionRank(b.f) || a.i - b.i)
    .map((x) => x.f);
}

// Lockfiles of package managers supported after a rubric's list was written. A frozen install has
// to reproduce them too; the rubric's list still decides which commits count toward shares.
const LATER_LOCKFILES = ["bun.lock", "bun.lockb"];

export function buildProfile(repo: string, tree: string, rubric: Rubric, commit = "HEAD", maxFiles = MAX_FILES): Profile {
  const { files, cut } = listFilesScoped(tree, { includeHidden: true, maxFiles, outputDirs: true });
  const pm = detectPackageManager(tree);
  const counts: ChangeCounts = changeCounts(repo, rubric, commit);
  const hintShare = rubric.components.satelliteHintShare;
  const { components, satellites, members, units } = discoverLayout(tree, files, basename(repo), hintShare === undefined ? {} : { shareOf: (d) => shareUnder(counts, d), hintShare });
  // A folder the file cap left partly unlisted may hold projects the scan never saw. Unless a
  // component already covers it, it's listed with its own share of changes, so it can't vanish.
  for (const dir of cut.filter((d) => !components.some((c) => c.path !== "." && within(c.path, d)))) {
    let id = sanitizeId(dir);
    for (let i = 2; components.some((c) => c.id === id); i++) id = `${sanitizeId(dir)}-${i}`;
    components.push({ id, path: dir, language: "other", manifest: null, scripts: {}, changes: 0, changeShare: 0, assessed: false, lockfile: null, notAssessedReason: capCutReason(maxFiles) });
  }
  const ownership = assignShares(components, satellites, counts, rubric);
  const totalChanges = ownership.counted ? ownership.changes : components.reduce((s, c) => s + c.changes, 0);
  const supported = components.filter((c) => !c.notAssessedReason && rubric.mutation.languages.includes(c.language === "other" ? "x" : c.language));
  for (const c of components) {
    if (!c.notAssessedReason && c.language === "other") c.notAssessedReason = "no supported toolchain found";
    // A supported stack whose language an older rubric doesn't list: say so, rather than no reason.
    else if (!c.notAssessedReason && !rubric.mutation.languages.includes(c.language)) c.notAssessedReason = `${c.stack ? stack(c.stack).label : c.language} isn't scored under rubric ${rubric.version}`;
  }
  // At an equal share, a package with a test script goes before one without, so a cap that falls
  // among packages with no recent changes keeps the ones that can be tested.
  const untested = (c: Component) => (c.language === "ts" || c.language === "js") && !hasTestScript(c.scripts);
  supported.sort((a, b) => b.changeShare - a.changeShare || Number(untested(a)) - Number(untested(b)));
  supported.slice(0, rubric.components.maxAssessed).forEach((c) => (c.assessed = true));
  supported.slice(rubric.components.maxAssessed).forEach((c) => (c.notAssessedReason = `outside the ${rubric.components.maxAssessed} most active components`));
  if (rubric.attribution) for (const c of components.filter((x) => x.assessed)) c.testFiles = ownTestFiles(files, { components, satellites }, c);
  const envPath = join(tree, ".cursor", "environment.json");
  let environmentJson: Profile["environmentJson"] = null;
  if (exists(envPath)) {
    try {
      const env = readJson<{ install?: string; start?: string; build?: { dockerfile?: string; context?: string } }>(envPath);
      environmentJson = { path: ".cursor/environment.json", install: env.install, start: env.start, build: env.build?.dockerfile ? { dockerfile: env.build.dockerfile, context: env.build.context } : undefined };
    } catch {
      environmentJson = { path: ".cursor/environment.json" };
    }
  }
  return {
    ...(counts.failed ? { sharesUnread: counts.failed } : {}),
    repoType: components.filter((c) => c.manifest).length > 1 ? "monorepo" : "single",
    packageManager: pm,
    manifests: files.filter((f) => /(^|\/)(package\.json|pyproject\.toml|setup\.py|requirements[^/]*\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|Package\.swift|pubspec\.yaml|[^/]+\.(csproj|fsproj|vbproj|sln))$/.test(f) && !f.split("/").slice(0, -1).some((s) => SKIP_SEGMENT.test(s))),
    lockfiles: files.filter((f) => [...rubric.components.lockfiles, ...LATER_LOCKFILES].includes(basename(f)) && (dirname(f) === "." || components.some((c) => c.packageManager && c.path === dirname(f)))),
    ciFiles: files.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f) || f === ".gitlab-ci.yml" || f === ".circleci/config.yml" || f.startsWith(".buildkite/")),
    instructionFiles: instructionFiles(files),
    toolchain: toolchain(tree, files.filter((f) => !f.split("/").slice(0, -1).some((s) => OUTPUT_SEGMENT.test(s))), pm, components, environmentJson?.build?.dockerfile),
    environmentJson,
    components,
    satellites,
    members,
    units,
    ownership,
    historyDays: rubric.components.historyDays,
    totalChanges,
  };
}
