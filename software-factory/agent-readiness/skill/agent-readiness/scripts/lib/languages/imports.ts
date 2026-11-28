import { statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { Component } from "../types.ts";
import { listFiles, readText } from "../util.ts";
import { inComponent } from "./coverage.ts";
import { isTestFile } from "./test-paths.ts";

// Which files JavaScript, TypeScript and Python tests reach through their imports, for node.ts and
// python.ts. `kind` picks the import syntax.
export type ImportKind = "js" | "py";

const JS_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// A path relative to the tree, with or without its extension, or a folder with an index file.
function resolveJsPath(tree: string, base: string): string | null {
  const b = normalize(base).replace(/\/$/, "");
  if (b.startsWith("..")) return null;
  const candidates = [b, ...JS_EXT.map((e) => b + e), b.replace(/\.js$/, ".ts"), b.replace(/\.js$/, ".tsx"), b.replace(/\.mjs$/, ".mts"), b.replace(/\.cjs$/, ".cts"), ...JS_EXT.map((e) => `${b}/index${e}`)];
  for (const c of candidates) if (isFile(join(tree, c))) return c;
  return null;
}

// `import "../store"` can name a folder, which resolves to its index file.
export function resolveJs(tree: string, fromFile: string, spec: string): string | null {
  return resolveJsPath(tree, join(dirname(fromFile), spec));
}

function resolvePy(tree: string, comp: Component, fromFile: string, mod: string): string | null {
  const rel = mod.startsWith(".") ? normalize(join(dirname(fromFile), mod.replace(/^\.+/, "").replace(/\./g, "/"))) : mod.replace(/\./g, "/");
  const roots = mod.startsWith(".") ? [""] : [comp.path === "." ? "" : comp.path, join(comp.path === "." ? "" : comp.path, "src")];
  for (const root of roots) {
    for (const cand of [join(root, rel + ".py"), join(root, rel, "__init__.py")]) if (isFile(join(tree, cand))) return cand;
  }
  return null;
}

// tsconfig.json and jsconfig.json allow comments and trailing commas.
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) if (text[j] === "\\") j++;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

interface Alias {
  // A tsconfig `paths` key or a package.json `imports` key, with at most one `*`.
  pattern: string;
  // Tree-relative targets, each with at most one `*`.
  targets: string[];
}

function readConfig(tree: string, file: string, depth = 0): { baseUrl?: string; paths?: Record<string, string[]>; dir: string } | null {
  if (!isFile(join(tree, file)) || depth > 3) return null;
  let cfg: { extends?: unknown; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    cfg = parseJsonc(readText(join(tree, file))) as typeof cfg;
  } catch {
    return null;
  }
  const dir = dirname(file);
  const parent = typeof cfg.extends === "string" && cfg.extends.startsWith(".") ? readConfig(tree, normalize(join(dir, cfg.extends.endsWith(".json") ? cfg.extends : `${cfg.extends}.json`)), depth + 1) : null;
  const own = cfg.compilerOptions ?? {};
  return {
    baseUrl: own.baseUrl !== undefined ? join(dir, own.baseUrl) : parent?.baseUrl,
    paths: own.paths ?? parent?.paths,
    dir: own.paths ? dir : (parent?.dir ?? dir),
  };
}

// Path aliases a test can import code through: tsconfig or jsconfig `paths` and `baseUrl`, and
// package.json `imports` (`#name`). The component's own config wins over the repo root's.
export function jsAliases(tree: string, comp: Component): { aliases: Alias[]; baseUrl: string | null } {
  const root = comp.path === "." ? "" : comp.path;
  const aliases: Alias[] = [];
  let baseUrl: string | null = null;
  for (const dir of [...new Set([root, ""])]) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const cfg = readConfig(tree, join(dir, name));
      if (!cfg) continue;
      if (baseUrl === null && cfg.baseUrl !== undefined) baseUrl = normalize(cfg.baseUrl);
      const from = cfg.baseUrl ?? cfg.dir;
      for (const [pattern, targets] of Object.entries(cfg.paths ?? {})) {
        if (Array.isArray(targets)) aliases.push({ pattern, targets: targets.filter((t) => typeof t === "string").map((t) => normalize(join(from, t))) });
      }
    }
    const pkg = join(dir, "package.json");
    if (isFile(join(tree, pkg))) {
      try {
        const imports = (JSON.parse(readText(join(tree, pkg))) as { imports?: Record<string, unknown> }).imports ?? {};
        for (const [pattern, target] of Object.entries(imports)) {
          const t = pickImportTarget(target);
          if (t) aliases.push({ pattern, targets: [normalize(join(dir, t))] });
        }
      } catch {}
    }
  }
  return { aliases, baseUrl };
}

// A package.json `imports` value: a path, or conditions whose first source-like path wins.
function pickImportTarget(v: unknown): string | null {
  if (typeof v === "string") return v.startsWith("./") ? v : null;
  if (v && typeof v === "object") {
    for (const k of ["source", "development", "import", "node", "require", "default"]) {
      const t = pickImportTarget((v as Record<string, unknown>)[k]);
      if (t) return t;
    }
  }
  return null;
}

function resolveAlias(tree: string, spec: string, a: { aliases: Alias[]; baseUrl: string | null }): string | null {
  for (const { pattern, targets } of a.aliases) {
    const star = pattern.indexOf("*");
    let hole: string | null = null;
    if (star < 0) hole = spec === pattern ? "" : null;
    else if (spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) && spec.length >= pattern.length - 1) hole = spec.slice(star, spec.length - (pattern.length - star - 1));
    if (hole === null) continue;
    for (const t of targets) {
      const f = resolveJsPath(tree, t.replace("*", hole));
      if (f) return f;
    }
  }
  if (a.baseUrl !== null && /^[\w@][\w@./-]*$/.test(spec)) return resolveJsPath(tree, join(a.baseUrl, spec));
  return null;
}

// Built output such as dist/ is a copy of the source, often stale, and a test command that rebuilds
// it overwrites the fault. A fault goes in the source the build comes from, or nowhere.
const BUILD_OUTPUT = /(^|\/)(dist|build)\//;

function sourceOf(tree: string, file: string): string | null {
  if (!BUILD_OUTPUT.test(file)) return file;
  const src = file.replace(BUILD_OUTPUT, "$1src/").replace(/\.(m|c)?js$/, "");
  return resolveJsPath(tree, src);
}

export const plantable = (f: string) => !isTestFile(f) && !f.includes("node_modules") && !/\.d\.[mc]?ts$|\.min\.js$/.test(f);

const JS_IMPORT = /(?:from\s*|import\s*\(\s*|require\(\s*|import\s+)['"]([^'"]+)['"]/g;
const JS_REEXPORT = /^\s*export\s+(?:\*(?:\s+as\s+\w+)?|(?:type\s+)?\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm;
const PY_IMPORT = /^\s*(?:from\s+(\S+)\s+import|import\s+([\w.]+))/gm;

// The files the component's tests import, directly, through path aliases, or through barrel files
// (an index.ts of `export * from` lines, an __init__.py of relative imports) that re-export them.
export function importedFiles(tree: string, comp: Component, tests: string[], kind: ImportKind): string[] {
  const aliases = kind === "py" ? { aliases: [], baseUrl: null } : jsAliases(tree, comp);
  const targets = new Set<string>();
  const queue: string[] = [];
  const add = (f: string | null) => {
    const src = f ? sourceOf(tree, f) : null;
    if (src && plantable(src) && !targets.has(src)) {
      targets.add(src);
      queue.push(src);
    }
  };
  const jsSpec = (from: string, spec: string) => (spec.startsWith(".") ? resolveJs(tree, from, spec) : resolveAlias(tree, spec, aliases));
  for (const t of tests) {
    const text = readText(join(tree, t));
    if (kind === "py") for (const m of text.matchAll(PY_IMPORT)) add(resolvePy(tree, comp, t, m[1] ?? m[2]));
    else for (const m of text.matchAll(JS_IMPORT)) add(jsSpec(t, m[1]));
  }
  for (let i = 0; i < queue.length && i < 500; i++) {
    const f = queue[i];
    const text = readText(join(tree, f));
    if (kind === "py") {
      if (!f.endsWith("__init__.py")) continue;
      for (const m of text.matchAll(/^\s*from\s+(\.\S*)\s+import/gm)) add(resolvePy(tree, comp, f, m[1]));
    } else for (const m of text.matchAll(JS_REEXPORT)) add(jsSpec(f, m[1]));
  }
  return [...targets].sort();
}
// Files every test loads without importing them: pytest's conftest.py and the setup files Jest and
// Vitest name in their config. A fault reached through one can be caught by any test.
const SHARED_SETUP = /(^|\/)conftest\.py$|(^|\/)(jest|vitest)\.(setup|config)\.[mc]?[jt]s$|(^|\/)setup(Tests|-tests)?\.[mc]?[jt]s$/;

// For each file, the test files that import it, directly or through other files of the component;
// null for a file the run can't be narrowed for: a shared setup file reaches it, or no test does.
export function reachingTests(tree: string, comp: Component, testList: string[], kind: ImportKind): (file: string) => string[] | null {
  const aliases = kind === "py" ? { aliases: [], baseUrl: null } : jsAliases(tree, comp);
  const tests = new Set(testList);
  const roots = [...tests, ...inComponent(listFiles(tree), comp.path).filter((f) => SHARED_SETUP.test(f))];
  const importedBy = new Map<string, Set<string>>();
  const seen = new Set<string>(roots);
  const queue = [...roots];
  for (let i = 0; i < queue.length && i < 5000; i++) {
    const from = queue[i];
    const text = readText(join(tree, from));
    const specs = kind === "py" ? [...text.matchAll(PY_IMPORT)].map((m) => resolvePy(tree, comp, from, m[1] ?? m[2])) : [...text.matchAll(JS_IMPORT)].map((m) => (m[1].startsWith(".") ? resolveJs(tree, from, m[1]) : resolveAlias(tree, m[1], aliases)));
    for (const to of specs) {
      if (!to || to.includes("node_modules")) continue;
      if (!importedBy.has(to)) importedBy.set(to, new Set());
      importedBy.get(to)!.add(from);
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return (file: string) => {
    const reached = new Set<string>([file]);
    const back = [file];
    for (let i = 0; i < back.length; i++) {
      for (const from of importedBy.get(back[i]) ?? []) {
        if (reached.has(from)) continue;
        reached.add(from);
        back.push(from);
      }
    }
    if ([...reached].some((f) => SHARED_SETUP.test(f))) return null;
    const out = [...reached].filter((f) => tests.has(f)).sort();
    return out.length ? out : null;
  };
}
