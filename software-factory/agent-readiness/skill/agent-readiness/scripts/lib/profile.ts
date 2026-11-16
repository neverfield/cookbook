import { basename, dirname, join } from "node:path";
import { LANGUAGES, languageOf as languageFile, languageOfStack, lockfileNames, manifestRules, rootAppRules, sourceRules } from "./languages/index.ts";
import type { LanguageDef } from "./languages/language.ts";
import { NODE_LOCKFILES, readPackageJson, yarnBerry, yarnPath, yarnPinned } from "./languages/node.ts";
import { PY_LOCKFILES, UV_WORKSPACE, pyproject, uvWorkspaceMembers } from "./languages/python.ts";
import type { Rubric } from "./rubric.ts";
import { STACKS, notSupportedReason, stack, supported } from "./support.ts";
import type { Component, Language, PackageManager, Profile } from "./types.ts";
import { capCutReason } from "./scope.ts";
import { MAX_FILES, addDays, containedPath, exists, git, listFilesScoped, readJson, readText, today, workspaceDirs } from "./util.ts";

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
const SKIP_SEGMENT = /^(\..+|node_modules|fixtures?|__fixtures__|testdata|vendor|dist|build|bin|obj|target|Pods|Carthage|DerivedData)$/;
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

// Folders that usually hold tests, samples or tooling next to the product. A manifest there is a
// satellite: it becomes a component only when the repo has nothing else to assess.
const SATELLITE_SEGMENT = /^(tests?|__tests__|specs?|e2e|samples?|examples?|demos?|bench|benchmarks?|plugins?|utils?|configs?|tooling)$/;
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

function satelliteReason(tree: string, m: FoundManifest): string | null {
  const segment = m.dir.split("/").find((s) => SATELLITE_SEGMENT.test(s));
  if (segment) return `it sits under ${segment}/, which usually holds ${SATELLITE_HOLDS} rather than the product`;
  const docs = m.kind === "py" ? m.dir.split("/").find((s) => DOCS_SEGMENT.test(s)) : undefined;
  if (docs) return `it sits under ${docs}/, which usually holds the documentation build rather than the product`;
  const packaging = m.kind === "other" ? packagingSegment(tree, m.dir) : undefined;
  if (packaging) return `it sits under ${packaging}/, which usually holds ${PACKAGING_HOLDS} rather than the product`;
  const name = m.kind === "js" ? readPackageJson(join(tree, m.dir))?.name : undefined;
  if (name && CONFIG_PACKAGE.test(name)) return `${name} is a shared config package, not a product`;
  return null;
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
// is still its own component. Next to a root package of the same language, only nested packages
// with their own lockfile count; a Python service next to a Node root can't be part of it.
function discoverManifests(tree: string, files: string[], claimed: string[], hasRoot: boolean, rootPy: boolean, repoName: string): { found: FoundManifest[]; satellites: (FoundManifest & { reason: string })[] } {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const segments = f.split("/");
    const bundle = segments.findIndex((s) => XCODE_BUNDLE.test(s));
    const dir = bundle >= 0 ? segments.slice(0, bundle).join("/") || "." : dirname(f);
    const name = bundle >= 0 ? segments[bundle] : basename(f);
    if (dir !== "." && dir.split("/").some((s) => SKIP_SEGMENT.test(s))) continue;
    const names = byDir.get(dir) ?? [];
    if (!names.includes(name)) byDir.set(dir, [...names, name]);
  }
  const found: FoundManifest[] = [];
  const satellites: (FoundManifest & { reason: string })[] = [];
  const add = (m: FoundManifest) => {
    const reason = m.dir === "." ? null : satelliteReason(tree, m);
    if (reason) satellites.push({ ...m, reason });
    else found.push(m);
  };
  for (const dir of [...byDir.keys()].sort((a, b) => (a === "." ? -1 : b === "." ? 1 : a.split("/").length - b.split("/").length || a.localeCompare(b)))) {
    if (claimed.some((c) => within(dir, c))) continue;
    const names = byDir.get(dir)!;
    const has = (n: string) => names.includes(n);
    const insideSupported = [...found, ...satellites].some((f) => f.kind !== "other" && within(dir, f.dir));
    if (dir !== "." && !insideSupported && has("package.json") && (!hasRoot || NODE_LOCKFILES.some(has))) {
      add({ dir, kind: "js", manifest: `${dir}/package.json` });
      continue;
    }
    const py = has("pyproject.toml") ? "pyproject.toml" : has("setup.py") ? "setup.py" : has("requirements.txt") && names.some((n) => n.endsWith(".py")) ? "requirements.txt" : null;
    if (dir !== "." && !insideSupported && py && (!hasRoot || !rootPy || PY_LOCKFILES.some(has))) {
      add({ dir, kind: "py", manifest: `${dir}/${py}` });
      continue;
    }
    const rule = UNSUPPORTED_MANIFESTS.find((u) => names.some((n) => u.match.test(n)));
    if (rule && !(dir === "." && hasRoot) && ![...found, ...satellites].some((f) => within(dir, f.dir))) {
      const picked = pickManifest(names.filter((n) => rule.match.test(n)), dir === "." ? repoName : basename(dir));
      const bundle = picked.match(XCODE_BUNDLE)?.[1];
      const project = bundle ? `${picked}/${XCODE_MANIFEST[bundle]}` : picked;
      const manifest = dir === "." ? project : `${dir}/${project}`;
      if (workspaceOnly(tree, manifest, rule.language)) continue;
      add({ dir, kind: "other", manifest, stack: rule.language.detect.refine?.(manifest, readText(join(tree, manifest)), tree) ?? rule.stack, language: rule.language });
    }
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

const ROOT_APP_MANIFESTS: { names: string[]; stack: string; toolchain: string; suffix: string }[] = [
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
  for (const r of ROOT_APP_MANIFESTS) {
    const manifest = r.names.find((n) => exists(join(tree, n)));
    if (!manifest || (r.suffix === "python" && !hasPy)) continue;
    const id = sanitizeId(projectName(tree, manifest, repoName));
    if (r.suffix === "python") out.push({ id, path: ".", language: "py", manifest, scripts: {}, changes: 0, changeShare: 0, assessed: false, toolchain: r.toolchain, stack: r.stack, notAssessedReason: notSupportedReason(r.stack) });
    else out.push(languageComponent(tree, { id, path: ".", manifest }, r.stack, r.toolchain));
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

export function discoverLayout(tree: string, files: string[], repoName = basename(tree)): { components: Component[]; satellites: Profile["satellites"] } {
  const comps: Component[] = [];
  const memberSatellites: Profile["satellites"] = [];
  const members = new Set<string>();
  const patterns = workspacePatterns(tree);
  // Folders the workspace leaves out on purpose aren't components of their own either.
  const included = patterns.filter((p) => !p.trim().startsWith("!"));
  const listed = included.length ? workspaceDirs(tree, patterns) : [];
  const excludedDirs = included.length < patterns.length ? workspaceDirs(tree, included).filter((d) => !listed.includes(d)) : [];
  if (included.length) {
    const all = listed.filter((d) => exists(join(tree, d, "package.json")));
    // Workspace members under tooling/ or examples/ are satellites too, unless nothing else exists.
    const reasons = new Map(all.map((d) => [d, d === "." ? null : satelliteReason(tree, { dir: d, kind: "js", manifest: `${d}/package.json` })]));
    const product = all.filter((d) => !reasons.get(d));
    const dirs = product.length ? product : all;
    if (product.length) for (const d of all.filter((x) => reasons.get(x))) memberSatellites.push({ path: d, manifest: `${d}/package.json`, toolchain: "Node", reason: reasons.get(d)! });
    for (const dir of dirs) {
      const pkg = readPackageJson(join(tree, dir));
      members.add(dir);
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
    for (const dir of uvMembers) {
      members.add(dir);
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
    if (jsRoot && unscored.length && !(jsRoot.scripts.test && !/no test specified/.test(jsRoot.scripts.test))) {
      jsRoot.notAssessedReason = `it goes with the ${unscored[0].toolchain} app at the root, which isn't supported yet, so it isn't assessed on its own`;
    }
    for (const app of apps) {
      if (comps.some((c) => c.id === app.id)) app.id = sanitizeId(`${app.id}-${ROOT_APP_MANIFESTS.find((r) => r.stack === app.stack)!.suffix}`);
      comps.push(app);
    }
  }
  const rootPy = comps.some((c) => c.path === "." && c.language === "py");
  const { found, satellites } = discoverManifests(tree, files, [...comps.filter((c) => c.path !== ".").map((c) => c.path), ...memberSatellites.map((s) => s.path), ...excludedDirs], hasRoot, rootPy, repoName);
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
  for (const c of comps) {
    c.lockfile = lockfileIn(tree, c.path);
    if (c.stack || c.language === "other") continue;
    c.stack = stackOf(tree, c, rootPm, members.has(c.path) && c.path !== ".");
    if (!supported(c.stack) && !c.notAssessedReason) c.notAssessedReason = notSupportedReason(c.stack);
  }
  const satelliteList = [...memberSatellites, ...(deferred ? [] : satellites.map((s) => ({ path: s.dir, manifest: s.manifest, toolchain: s.kind === "js" ? "Node" : s.kind === "py" ? "Python" : stack(s.stack!).label, reason: s.reason })))];
  // Unsupported source with no manifest, such as infra/*.tf, is listed by its top-level folder,
  // next to a root package too, so the root doesn't take its share of changes.
  const rootOnly = comps.length > 0 && comps.every((c) => c.path === ".");
  const rootStacks = new Set(comps.filter((c) => c.path === ".").map((c) => c.stack));
  const claimed = new Set([...comps.map((c) => c.path), ...satelliteList.map((s) => s.path)].map((p) => p.split("/")[0]));
  const topDirs = [...new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]))].filter((d) => !d.startsWith(".") && !claimed.has(d) && !VENDORED.test(d));
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
      satelliteList.push({ path: dir, manifest: inside.find((f) => hit.ext.test(f))!, toolchain: stack(hit.stack).label, reason: `it sits under ${dir}/, which usually holds ${holds} rather than the product` });
      continue;
    }
    if (rootOnly && NOT_A_PROJECT.test(dir)) continue;
    comps.push({ ...languageComponent(tree, { id: sanitizeId(dir), path: dir, manifest: null }, hit.stack), lockfile: null });
  }
  return { components: uniqueIds(comps), satellites: satelliteList };
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

// Two components at the root split its files: the root package keeps the Node files, and the app
// next to it, such as Django or Laravel, takes its own files and the rest of the root.
function ownsByType(c: Component, file: string): boolean {
  return Boolean(c.stack && STACKS.find((s) => s.id === c.stack)?.files?.test(file));
}

const NODE_FILE = /\.(c|m)?[jt]sx?$|\.(vue|svelte|astro|css|scss|sass|less|html?)$|(^|\/)(package(-lock)?\.json|pnpm-(lock|workspace)\.yaml|yarn\.lock|bun\.lockb?|\.nvmrc|\.npmrc|tsconfig[^/]*\.json)$/;

function owningComponent(file: string, comps: Component[]): Component | null {
  let best: Component | null = null;
  let bestLen = -1;
  for (const c of comps) {
    const matches = c.path === "." || file === c.path || file.startsWith(c.path + "/");
    const len = c.path === "." ? 0 : c.path.length;
    if (matches && len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  const roots = comps.filter((c) => c.path === ".");
  if (best?.path !== "." || roots.length < 2) return best;
  const app = roots.find((c) => c !== best && STACKS.find((s) => s.id === c.stack)?.files);
  return roots.find((c) => ownsByType(c, file)) ?? (NODE_FILE.test(file) || !app ? best : app);
}

// Counted up to the audited commit, so a commit made after `init` can't move the shares.
export function computeChangeShares(repo: string, comps: Component[], rubric: Rubric, commit = "HEAD"): number {
  const since = addDays(today(), -rubric.components.historyDays);
  const r = git(["log", commit, `--since=${since}`, "--no-merges", "--name-status", "--no-renames", "--format=@@%an%x09%ae"], repo);
  const counts = new Map<string, number>();
  let author = "";
  let commitFiles: string[] = [];
  const flush = () => {
    const isBot = rubric.components.botAuthorPatterns.some((p) => author.toLowerCase().includes(p.toLowerCase()));
    const lockOnly = commitFiles.length > 0 && commitFiles.every((f) => rubric.components.lockfiles.includes(basename(f)));
    if (!isBot && !lockOnly) {
      for (const f of commitFiles) {
        // Installing this skill, or committing its records, isn't work in the repo's components.
        if (f.startsWith(".cursor/skills/agent-readiness/") || f.startsWith(".agent-readiness/")) continue;
        if (rubric.components.generatedPatterns.some((g) => f.includes(g))) continue;
        if (rubric.components.lockfiles.includes(basename(f))) continue;
        const owner = owningComponent(f, comps);
        if (owner) counts.set(owner.id, (counts.get(owner.id) ?? 0) + 1);
      }
    }
    commitFiles = [];
  };
  if (r.ok) {
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("@@")) {
        flush();
        author = line.slice(2);
      } else if (/^[AMD]\t/.test(line)) {
        commitFiles.push(line.slice(2));
      }
    }
    flush();
  }
  let total = 0;
  for (const c of comps) {
    c.changes = counts.get(c.id) ?? 0;
    total += c.changes;
  }
  for (const c of comps) c.changeShare = total > 0 ? Math.round((c.changes / total) * 1000) / 1000 : Math.round((1 / comps.length) * 1000) / 1000;
  return total;
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

const INSTRUCTION_PATTERNS: RegExp[] = [
  /(^|\/)AGENTS\.md$/,
  /(^|\/)CLAUDE\.md$/,
  /^\.cursorrules$/,
  /^\.cursor\/rules\/.+\.(mdc|md)$/,
  /^\.github\/copilot-instructions\.md$/,
  /^\.github\/instructions\/.+\.instructions\.md$/,
  /^\.(cursor|claude|agents)\/skills\/[^/]+\/SKILL\.md$/,
  /^(\.github\/|docs\/)?CONTRIBUTING\.md$/i,
  /^README\.md$/i,
];

// Agent instructions and contributor guides come first and the README last, so a README command
// they already give is checked once, where it's written for people working on the repo.
function instructionRank(f: string): number {
  if (/^README\.md$/i.test(f)) return 2;
  if (/(^|\/)SKILL\.md$/.test(f)) return 1;
  return 0;
}

export function instructionFiles(files: string[]): string[] {
  return files
    .filter((f) => INSTRUCTION_PATTERNS.some((p) => p.test(f)) && !f.startsWith(".cursor/skills/agent-readiness/"))
    .map((f, i) => ({ f, i }))
    .sort((a, b) => instructionRank(a.f) - instructionRank(b.f) || a.i - b.i)
    .map((x) => x.f);
}

// Lockfiles of package managers supported after a rubric's list was written. A frozen install has
// to reproduce them too; the rubric's list still decides which commits count toward shares.
const LATER_LOCKFILES = ["bun.lock", "bun.lockb"];

export function buildProfile(repo: string, tree: string, rubric: Rubric, commit = "HEAD", maxFiles = MAX_FILES): Profile {
  const { files, cut } = listFilesScoped(tree, { includeHidden: true, maxFiles });
  const pm = detectPackageManager(tree);
  const { components, satellites } = discoverLayout(tree, files, basename(repo));
  // A folder the file cap left partly unlisted may hold projects the scan never saw. Unless a
  // component already covers it, it's listed with its own share of changes, so it can't vanish.
  for (const dir of cut.filter((d) => !components.some((c) => c.path !== "." && within(c.path, d)))) {
    let id = sanitizeId(dir);
    for (let i = 2; components.some((c) => c.id === id); i++) id = `${sanitizeId(dir)}-${i}`;
    components.push({ id, path: dir, language: "other", manifest: null, scripts: {}, changes: 0, changeShare: 0, assessed: false, lockfile: null, notAssessedReason: capCutReason(maxFiles) });
  }
  const totalChanges = computeChangeShares(repo, components, rubric, commit);
  const supported = components.filter((c) => !c.notAssessedReason && rubric.mutation.languages.includes(c.language === "other" ? "x" : c.language));
  for (const c of components) {
    if (!c.notAssessedReason && c.language === "other") c.notAssessedReason = "no supported toolchain found";
    // A supported stack whose language an older rubric doesn't list: say so, rather than no reason.
    else if (!c.notAssessedReason && !rubric.mutation.languages.includes(c.language)) c.notAssessedReason = `${c.stack ? stack(c.stack).label : c.language} isn't scored under rubric ${rubric.version}`;
  }
  supported.sort((a, b) => b.changeShare - a.changeShare);
  supported.slice(0, rubric.components.maxAssessed).forEach((c) => (c.assessed = true));
  supported.slice(rubric.components.maxAssessed).forEach((c) => (c.notAssessedReason = `outside the ${rubric.components.maxAssessed} most active components`));
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
    repoType: components.filter((c) => c.manifest).length > 1 ? "monorepo" : "single",
    packageManager: pm,
    manifests: files.filter((f) => /(^|\/)(package\.json|pyproject\.toml|setup\.py|requirements[^/]*\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|Package\.swift|pubspec\.yaml|[^/]+\.(csproj|fsproj|vbproj|sln))$/.test(f) && !f.split("/").slice(0, -1).some((s) => SKIP_SEGMENT.test(s))),
    lockfiles: files.filter((f) => [...rubric.components.lockfiles, ...LATER_LOCKFILES].includes(basename(f)) && (dirname(f) === "." || components.some((c) => c.packageManager && c.path === dirname(f)))),
    ciFiles: files.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f) || f === ".gitlab-ci.yml" || f === ".circleci/config.yml" || f.startsWith(".buildkite/")),
    instructionFiles: instructionFiles(files),
    toolchain: toolchain(tree, files, pm, components, environmentJson?.build?.dockerfile),
    environmentJson,
    components,
    satellites,
    historyDays: rubric.components.historyDays,
    totalChanges,
  };
}
