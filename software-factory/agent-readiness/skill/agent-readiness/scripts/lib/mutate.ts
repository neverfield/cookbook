import { statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { inComponent } from "./languages/coverage.ts";
import { languageOf } from "./languages/index.ts";
import type { Component, FaultEstimate, Language } from "./types.ts";
import { exists, lastChanged, listFiles, readText, sha256 } from "./util.ts";

export interface Site {
  file: string;
  line: number;
  operator: string;
  before: string;
  after: string;
}

const TEST_FILE = /(\.test\.|\.spec\.|(^|\/)tests?\/|(^|\/)__tests__\/|(^|\/)tests?\.(m?[jt]sx?|cjs|py)$|(^|\/)test_[^/]*\.py$|_test\.py$)/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

function insideString(line: string, index: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < index; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
  }
  return quote !== null;
}

function isCommentOrImport(trimmed: string, lang: Language): boolean {
  if (lang === "py") return trimmed.startsWith("#") || /^(import |from \S+ import )/.test(trimmed) || trimmed.startsWith('"""') || trimmed.startsWith("'''");
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || /^(import |export \* from|export \{[^}]*\} from)/.test(trimmed) || /require\(/.test(trimmed);
}

// A type has no behaviour to test, and a changed literal type usually stops the code compiling.
const TYPE_ONLY = /^(export\s+)?(declare\s+|type\s+\w|interface\s+\w)/;

function firstMatch(line: string, re: RegExp): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(line))) {
    if (!insideString(line, m.index)) return m;
  }
  return null;
}

const BOUNDARY: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">" };

// Styling values no reasonable test checks, such as `margin: 0` in an inline style or a JSX
// `strokeWidth={2}`. A changed constant there is noise, not a gap in the tests.
const CSS_KEY = /\b(margin\w*|padding\w*|width|height|min(Width|Height)|max(Width|Height)|top|left|right|bottom|inset|gap|rowGap|columnGap|font(Size|Weight)|lineHeight|letterSpacing|opacity|zIndex|flex(Grow|Shrink|Basis)?|order|border\w*|outline\w*|grid(Column|Row)\w*|elevation|transition\w*|animation\w*)\s*:\s*['"]?-?\d/;
const JSX_PRESENTATION = /\b(style|sx|className|width|height|size|strokeWidth|spacing|elevation|tabIndex|rows|cols)=\{\s*\{?[^}]*\d/;

export function cosmetic(line: string): boolean {
  return CSS_KEY.test(line) || JSX_PRESENTATION.test(line) || /\bstyle=\{\{/.test(line);
}

// A delay, timeout or cache lifetime one unit longer behaves the same to any test that isn't timing
// the code, so the mutant is equivalent in practice and can only survive.
const TIMING = /(setTimeout|setInterval|\bsleep|delay|timeout|debounce|throttle|interval|backoff|\bttl\b|maxAge|max_age|\bexpires?\b)/i;

export function sitesForLine(line: string, lang: Language): Omit<Site, "file" | "line">[] {
  const trimmed = line.trim();
  if (!trimmed || isCommentOrImport(trimmed, lang)) return [];
  if (lang !== "py" && TYPE_ONLY.test(trimmed)) return [];
  const out: Omit<Site, "file" | "line">[] = [];
  const b = firstMatch(line, / (<=|>=|<|>) /);
  if (b) out.push({ operator: "boundary_flip", before: line, after: line.slice(0, b.index) + ` ${BOUNDARY[b[1]]} ` + line.slice(b.index + b[0].length) });
  if (lang === "py") {
    const m = line.match(/^(\s*)(if|elif|while) (.+):\s*$/);
    if (m) out.push({ operator: "negate_condition", before: line, after: `${m[1]}${m[2]} not (${m[3]}):` });
  } else {
    const m = firstMatch(line, /\b(if|while) \(/);
    if (m) {
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      for (; i < line.length && depth > 0; i++) {
        if (line[i] === "(") depth++;
        else if (line[i] === ")") depth--;
      }
      if (depth === 0) {
        const cond = line.slice(start, i - 1);
        out.push({ operator: "negate_condition", before: line, after: line.slice(0, start) + `!(${cond})` + line.slice(i - 1) });
      }
    }
  }
  const s = firstMatch(line, / ([+-]) 1(?![\d.])/);
  if (s) out.push({ operator: "shift_by_one", before: line, after: line.slice(0, s.index) + ` ${s[1] === "+" ? "-" : "+"} 1` + line.slice(s.index + s[0].length) });
  const r = lang === "py" ? firstMatch(line, /\breturn (True|False)\b/) : firstMatch(line, /\breturn (true|false)\b/);
  if (r) {
    const swapped = { true: "false", false: "true", True: "False", False: "True" }[r[1]] as string;
    out.push({ operator: "swap_return", before: line, after: line.slice(0, r.index) + `return ${swapped}` + line.slice(r.index + r[0].length) });
  }
  const indent = line.match(/^\s*/)?.[0] ?? "";
  if (lang === "py") {
    if (/^raise\b/.test(trimmed)) out.push({ operator: "drop_throw_or_return", before: line, after: `${indent}pass` });
  } else if (/^throw\b.*;\s*$/.test(trimmed) || /^return;\s*$/.test(trimmed)) {
    out.push({ operator: "drop_throw_or_return", before: line, after: `${indent}void 0;` });
  }
  const c = firstMatch(line, /(?<![\w.$])(\d+)(?![\w.])/);
  if (c && !/^\s*(case |default)/.test(line) && !cosmetic(line) && !TIMING.test(line)) {
    const n = Number(c[1]);
    if (Number.isSafeInteger(n)) out.push({ operator: "change_constant", before: line, after: line.slice(0, c.index) + String(n + 1) + line.slice(c.index + c[0].length) });
  }
  return out.filter((x) => x.after !== x.before);
}

// The 0-based lines a fault must never land on because some of the line is text, not code: a
// block comment, docstring, triple-quoted string or template literal that spans lines. Strings
// and comments that open and close on one line are left to sitesForLine.
export function quotedLines(text: string, lang: Language): Set<number> {
  const out = new Set<number>();
  let line = 0;
  let opened = -1;
  const span = (from: number, to: number) => {
    if (to > from) for (let l = from; l <= to; l++) out.add(l);
  };
  const n = text.length;
  if (lang === "py") {
    for (let i = 0; i < n; i++) {
      const ch = text[i];
      if (ch === "\n") line++;
      else if (ch === "#") {
        while (i + 1 < n && text[i + 1] !== "\n") i++;
      } else if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
        const q = text.slice(i, i + 3);
        opened = line;
        for (i += 3; i < n && !text.startsWith(q, i); i++) {
          if (text[i] === "\\") i++;
          if (text[i] === "\n") line++;
        }
        i += 2;
        span(opened, line);
      } else if (ch === "'" || ch === '"') {
        for (i++; i < n && text[i] !== ch && text[i] !== "\n"; i++) if (text[i] === "\\") i++;
        if (text[i] === "\n") line++;
      }
    }
    return out;
  }
  // JS and TS. A stack of the template literals still open; each entry counts the braces of the
  // `${...}` it is in, so a backtick inside an interpolation opens a nested template.
  const templates: { start: number; braces: number; inExpr: boolean }[] = [];
  let prev = "";
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    const top = templates.at(-1);
    if (ch === "\n") {
      line++;
      continue;
    }
    if (top && !top.inExpr) {
      if (ch === "\\") i++;
      else if (ch === "`") {
        templates.pop();
        span(top.start, line);
        prev = "`";
      } else if (ch === "$" && text[i + 1] === "{") {
        top.inExpr = true;
        top.braces = 0;
        i++;
      }
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") continue;
    if (ch === "/" && text[i + 1] === "/") {
      while (i + 1 < n && text[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      opened = line;
      for (i += 2; i < n && !text.startsWith("*/", i); i++) if (text[i] === "\n") line++;
      i++;
      span(opened, line);
      continue;
    }
    if (ch === "'" || ch === '"') {
      for (i++; i < n && text[i] !== ch && text[i] !== "\n"; i++) if (text[i] === "\\") i++;
      if (text[i] === "\n") line++;
      prev = ch;
      continue;
    }
    // A regex literal can hold quotes and backticks; it starts where an operand is expected.
    if (ch === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev))) {
      let inClass = false;
      for (i++; i < n && text[i] !== "\n"; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
        else if (text[i] === "/" && !inClass) break;
      }
      if (text[i] === "\n") line++;
      prev = "/";
      continue;
    }
    if (ch === "`") {
      templates.push({ start: line, braces: 0, inExpr: false });
      continue;
    }
    if (top?.inExpr) {
      if (ch === "{") top.braces++;
      else if (ch === "}") {
        if (top.braces === 0) {
          top.inExpr = false;
          continue;
        }
        top.braces--;
      }
    }
    prev = ch;
  }
  for (const t of templates) span(t.start, line);
  return out;
}

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

const plantable = (f: string) => !isTestFile(f) && !f.includes("node_modules") && !/\.d\.[mc]?ts$|\.min\.js$/.test(f);

// A language file's fault hooks, for a language Node's and Python's rules don't cover.
function hooksFor(lang: Language) {
  return languageOf(lang)?.replay?.mutation;
}

export function testFiles(tree: string, comp: Component): string[] {
  const lang = comp.language;
  const hooks = hooksFor(lang);
  if (hooks) return inComponent(listFiles(tree), comp.path).filter((f) => hooks.isTest(f));
  return listFiles(tree)
    .filter((f) => comp.path === "." || f.startsWith(comp.path + "/"))
    .filter((f) => isTestFile(f) && (lang === "py" ? f.endsWith(".py") : /\.(ts|tsx|js|mjs|cjs|mts|cts)$/.test(f)));
}

const JS_IMPORT = /(?:from\s*|import\s*\(\s*|require\(\s*|import\s+)['"]([^'"]+)['"]/g;
const JS_REEXPORT = /^\s*export\s+(?:\*(?:\s+as\s+\w+)?|(?:type\s+)?\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm;
const PY_IMPORT = /^\s*(?:from\s+(\S+)\s+import|import\s+([\w.]+))/gm;

// The files the component's tests import, directly, through path aliases, or through barrel files
// (an index.ts of `export * from` lines, an __init__.py of relative imports) that re-export them.
export function targetFiles(tree: string, comp: Component): string[] {
  const lang = comp.language;
  const hooks = hooksFor(lang);
  if (hooks) return [...new Set(hooks.covered(tree, comp, testFiles(tree, comp), inComponent(listFiles(tree), comp.path)))].filter((f) => hooks.isSource(f) && !hooks.isTest(f)).sort();
  const aliases = lang === "py" ? { aliases: [], baseUrl: null } : jsAliases(tree, comp);
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
  for (const t of testFiles(tree, comp)) {
    const text = readText(join(tree, t));
    if (lang === "py") for (const m of text.matchAll(PY_IMPORT)) add(resolvePy(tree, comp, t, m[1] ?? m[2]));
    else for (const m of text.matchAll(JS_IMPORT)) add(jsSpec(t, m[1]));
  }
  for (let i = 0; i < queue.length && i < 500; i++) {
    const f = queue[i];
    const text = readText(join(tree, f));
    if (lang === "py") {
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
// The whole index is null for a language this file doesn't read imports of.
export function testsReaching(tree: string, comp: Component): ((file: string) => string[] | null) | null {
  const lang = comp.language;
  if (hooksFor(lang) || (lang !== "py" && lang !== "ts" && lang !== "js")) return null;
  const aliases = lang === "py" ? { aliases: [], baseUrl: null } : jsAliases(tree, comp);
  const tests = new Set(testFiles(tree, comp));
  const roots = [...tests, ...inComponent(listFiles(tree), comp.path).filter((f) => SHARED_SETUP.test(f))];
  const importedBy = new Map<string, Set<string>>();
  const seen = new Set<string>(roots);
  const queue = [...roots];
  for (let i = 0; i < queue.length && i < 5000; i++) {
    const from = queue[i];
    const text = readText(join(tree, from));
    const specs = lang === "py" ? [...text.matchAll(PY_IMPORT)].map((m) => resolvePy(tree, comp, from, m[1] ?? m[2])) : [...text.matchAll(JS_IMPORT)].map((m) => (m[1].startsWith(".") ? resolveJs(tree, from, m[1]) : resolveAlias(tree, m[1], aliases)));
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

// pytest and `node --test` options that take the next word as their value.
const RUNNER_VALUE_FLAGS = new Set(["-k", "-m", "-c", "-p", "-n", "-o", "-W", "-r", "--rootdir", "--config-file", "--deselect", "--ignore", "--ignore-glob", "--junitxml", "--cov", "--cov-report", "--import-mode", "--maxfail", "--tb", "--dist", "--test-reporter", "--test-reporter-destination", "--test-name-pattern", "--test-concurrency", "--import", "--require", "-r"]);

// The test command narrowed to the given test files, or null when it can't be done safely: only a
// direct pytest or `node --test` run that names no paths of its own, and test files inside the
// folder it runs in.
export function scopedCommand(command: string, cwd: string, tests: string[]): string | null {
  const words = command.trim().split(/\s+/);
  if (words.some((w) => /[|&;<>()$`"'\\*?]/.test(w))) return null;
  let at = -1;
  for (let i = 0; i < words.length && at < 0; i++) {
    if (/(^|\/)pytest$/.test(words[i])) at = i;
    else if (/(^|\/)python3?$/.test(words[i]) && words[i + 1] === "-m" && words[i + 2] === "pytest") at = i + 2;
  }
  if (at < 0 && /(^|\/)node$/.test(words[0] ?? "") && words.includes("--test")) at = 0;
  if (at < 0) return null;
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i];
    if (w === "--test" || w.startsWith("-")) {
      if (RUNNER_VALUE_FLAGS.has(w)) i++;
      continue;
    }
    return null;
  }
  const base = normalize(cwd).replace(/\/$/, "");
  const rel = tests.map((t) => (base === "." ? t : t.startsWith(base + "/") ? t.slice(base.length + 1) : null));
  if (rel.some((r) => r === null || !/^[\w./@+-]+$/.test(r))) return null;
  return `${command.trim()} ${rel.join(" ")}`;
}

// What the planted faults are chosen from: the files the tests import, and the tests. The same code
// gives the same faults, so a fault result changes only when the code does. Line endings don't count.
export function codeDigest(tree: string, files: string[]): string {
  return sha256([...new Set(files)].sort().map((f) => `${f}\n${sha256(readText(join(tree, f)).replace(/\r\n/g, "\n"))}`).join("\n"));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRandom(seed: string, salt: string): () => number {
  return mulberry32(parseInt(sha256(seed + ":" + salt).slice(0, 8), 16));
}

// A clamp guard such as `if (n < 0) return 0;` or `if n > 100: n = 100` behaves the same with its
// boundary flipped: at the bound, the branch gives the value the code would have kept anyway. Such a
// mutant is equivalent, so no test can catch it.
export function equivalentBoundary(lines: string[], i: number): boolean {
  const line = lines[i];
  const m = line.match(/\b(?:if|elif|while)\s*\(?\s*([\w.$]+)\s*(?:<=|>=|<|>)\s*(-?[\w.$]+)\s*(:|\)?\s*\{?)\s*(.*)$/);
  if (!m) return false;
  const [, left, bound, , rest] = m;
  let body = rest.replace(/[;}]\s*$/, "").trim();
  for (let j = i + 1; !body && j < lines.length && j <= i + 2; j++) body = lines[j].trim().replace(/^\{\s*/, "").replace(/;?\s*\}?\s*$/, "").trim();
  const ret = body.match(/^return\s+(-?[\w.$]+)$/);
  if (ret) return ret[1] === bound;
  const set = body.match(/^([\w.$]+)\s*=\s*(-?[\w.$]+)$/);
  return Boolean(set && set[1] === left && set[2] === bound);
}

const COMPARE: Record<string, (a: number, b: number) => boolean> = { "<": (a, b) => a < b, "<=": (a, b) => a <= b, ">": (a, b) => a > b, ">=": (a, b) => a >= b, "==": (a, b) => a === b, "===": (a, b) => a === b, "!=": (a, b) => a !== b, "!==": (a, b) => a !== b };
const FLIPPED: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

// A constant changed from C to C + 1 where it is a variable's whole value in one branch (the
// variable itself, a `|| C`, `?? C` or `or C` fallback, or an arm of a conditional), and every other
// mention of the variable in the file compares it with a number that C and C + 1 fall on the same
// side of. `const seen = counts.get(key) || 0` used only as `seen > 2` is one: no test can tell 0
// from 1 there. Any other use, a reassignment or a mention in a comment, keeps the fault.
export function equivalentConstant(lines: string[], i: number, before: string, after: string): boolean {
  const decl = before.match(/^\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=(?![=>])\s*(.*)$/);
  if (!decl) return false;
  const [, name, rhs] = decl;
  let at = 0;
  while (at < before.length && before[at] === after[at]) at++;
  const num = before.slice(at).match(/^\d+/);
  if (!num || at < before.length - rhs.length) return false;
  const c = Number(num[0]);
  const pre = before.slice(before.length - rhs.length, at).trimEnd();
  const post = before.slice(at + num[0].length).trim().replace(/;$/, "").trim();
  if (!(pre === "" || /(\|\||\?\?|\bor|\?|:|\belse)$/.test(pre)) || !(post === "" || /^(:|if\b|else\b)/.test(post))) return false;
  const esc = name.replace(/\$/g, "\\$");
  const mention = new RegExp(`(?<![\\w$.])${esc}(?![\\w$])`, "g");
  const cmp = new RegExp(`^(?:(?<![\\w$.])${esc}\\s*(===|!==|==|!=|<=|>=|<|>)\\s*(-?\\d+(?:\\.\\d+)?)(?![\\w.])|(-?\\d+(?:\\.\\d+)?)\\s*(===|!==|==|!=|<=|>=|<|>)\\s*${esc}(?![\\w$]))`);
  let uses = 0;
  for (let j = 0; j < lines.length; j++) {
    if (j === i) continue;
    for (const m of lines[j].matchAll(mention)) {
      const from = lines[j].slice(m.index!);
      const back = lines[j].slice(0, m.index!).match(/(-?\d+(?:\.\d+)?)\s*(===|!==|==|!=|<=|>=|<|>)\s*$/);
      const fwd = from.match(cmp);
      let op: string;
      let k: number;
      if (fwd?.[1]) [op, k] = [fwd[1], Number(fwd[2])];
      else if (back) [op, k] = [FLIPPED[back[2]] ?? back[2], Number(back[1])];
      else return false;
      if (COMPARE[op](c, k) !== COMPARE[op](c + 1, k)) return false;
      uses++;
    }
  }
  return uses > 0;
}

export function allSites(tree: string, files: string[], lang: Language): Site[] {
  const sites: Site[] = [];
  // A language without hooks of its own for sites or quoting gets the C-like rules.
  const hooks = hooksFor(lang);
  const quote = (text: string) => (hooks ? (hooks.quoted?.(text) ?? quotedLines(text, "ts")) : quotedLines(text, lang));
  const onLine = (line: string) => (hooks ? (hooks.sites?.(line) ?? sitesForLine(line, "ts")) : sitesForLine(line, lang));
  for (const file of files) {
    const text = readText(join(tree, file));
    const quoted = quote(text);
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (quoted.has(i)) return;
      for (const s of onLine(line)) {
        if (s.operator === "boundary_flip" && equivalentBoundary(lines, i)) continue;
        if (s.operator === "change_constant" && equivalentConstant(lines, i, s.before, s.after)) continue;
        sites.push({ file, line: i + 1, ...s });
      }
    });
  }
  return sites;
}

// A fault's identity: its file, its line with whitespace normalised, and its operator. The line's
// number isn't part of it, so a fault keeps its identity when code above it moves.
export function faultId(site: Pick<Site, "file" | "before" | "operator">): string {
  return sha256(`${site.file}\n${site.before.trim().replace(/\s+/g, " ")}\n${site.operator}`).slice(0, 16);
}

export interface PickOptions {
  // "fault" (from 2026-12-beta): each fault is ranked by its own identity, so editing a test, or code
  // in another file, never redraws it. Without it, the whole pick is keyed on every file's digest.
  identity?: "fault";
  // Fault ids an earlier sealed audit planted, replanted first where the same fault still exists.
  prior?: string[];
}

// The pick depends on the component's code and on `seed`. An empty seed leaves the code alone to
// decide, so the same code always gets the same faults; an eval or a grader passes its own seed to
// get faults the code's own pick didn't plant.
export function chooseSites(repo: string, tree: string, comp: Component, seed: string, count: number, commit = "HEAD", opts: PickOptions = {}): Site[] {
  const files = targetFiles(tree, comp);
  const sites = allSites(tree, files, comp.language);
  if (sites.length === 0) return [];
  const recency = lastChanged(repo, files, { commit });
  const sortedFiles = [...files].sort((a, b) => (recency.get(b) ?? "").localeCompare(recency.get(a) ?? "") || a.localeCompare(b));
  const recentTier = new Set(sortedFiles.slice(0, Math.max(1, Math.ceil(sortedFiles.length / 2))));
  let shuffled: Site[];
  if (opts.identity === "fault") {
    const rank = (s: Site) => sha256(`${seed}:${comp.id}:${faultId(s)}`);
    shuffled = sites.map((s) => ({ s, k: rank(s) })).sort((a, b) => a.k.localeCompare(b.k) || a.s.line - b.s.line).map((x) => x.s);
  } else {
    const code = codeDigest(tree, [...files, ...testFiles(tree, comp)]);
    const rand = seededRandom(seed ? `${code}:${seed}` : code, comp.id);
    shuffled = sites.map((s) => ({ s, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.s);
  }
  const tiered = [...shuffled.filter((s) => recentTier.has(s.file)), ...shuffled.filter((s) => !recentTier.has(s.file))];
  if (opts.prior?.length) {
    const order = new Map(opts.prior.map((id, i) => [id, i]));
    const again = tiered.filter((s) => order.has(faultId(s))).sort((a, b) => order.get(faultId(a))! - order.get(faultId(b))!);
    tiered.splice(0, tiered.length, ...again, ...tiered.filter((s) => !order.has(faultId(s))));
  }
  const picked: Site[] = [];
  const usedLines = new Set<string>();
  for (const s of tiered) {
    if (picked.length >= count) break;
    const key = `${s.file}:${s.line}`;
    if (usedLines.has(key)) continue;
    usedLines.add(key);
    picked.push(s);
  }
  for (const s of tiered) {
    if (picked.length >= count) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked;
}

// A type error every checker of the language reports at any strictness: a string assigned to a
// variable annotated as a number, appended at the end of a file the component's tests import.
// Languages without a line here get no canary, so their type-check counts on its exit code alone.
export const TYPE_CANARIES: { label: string; ext: RegExp; line: string }[] = [
  { label: "TypeScript", ext: /\.(tsx?|mts|cts)$/, line: 'const __readinessTypeCanary: number = "agent-readiness";' },
  { label: "Python", ext: /\.py$/, line: '__readiness_type_canary: int = "agent-readiness"' },
];

// The most recently changed file the tests import that a canary line can go in, so the error lands
// in code agents change. The same commit always gets the same file.
export function typeCanarySite(repo: string, tree: string, comp: Component, commit = "HEAD"): { file: string; line: string } | null {
  const lineFor = (f: string) => (/\.d\.[mc]?ts$/.test(f) ? undefined : TYPE_CANARIES.find((c) => c.ext.test(f))?.line);
  const files = targetFiles(tree, comp).filter((f) => lineFor(f));
  if (files.length === 0) return null;
  const recency = lastChanged(repo, files, { commit });
  const file = [...files].sort((a, b) => (recency.get(b) ?? "").localeCompare(recency.get(a) ?? "") || a.localeCompare(b))[0];
  return { file, line: lineFor(file)! };
}

// Keeps the file's own line endings, so a CRLF checkout on Windows gets a CRLF line.
export function withCanary(text: string, line: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return `${text}${text === "" || text.endsWith("\n") ? "" : eol}${line}${eol}`;
}

// Writes a planted fault, or the original back, with a modification time in whole seconds later than
// any this audit gave before and later than now. Caches that trust a file whose time and size are
// unchanged, such as Python's .pyc files (which compare whole seconds), can't then run one version as
// the other when a run takes under a second, and a build that compares times with its outputs sees
// each write as newer than anything built from the one before.
let lastStamp = 0;
export function writeStamped(path: string, text: string): void {
  writeFileSync(path, text);
  lastStamp = Math.max(Math.floor(Date.now() / 1000) + 1, lastStamp + 1);
  utimesSync(path, lastStamp, lastStamp);
}

export function applySite(text: string, site: Site): string {
  const lines = text.split("\n");
  if (lines[site.line - 1] !== site.before) throw new Error(`Line ${site.line} of ${site.file} changed since the site was chosen`);
  lines[site.line - 1] = site.after;
  return lines.join("\n");
}

// The share of planted faults with a clear result (caught or survived) the tests must catch. The
// 2026 rubrics need every one; a rubric that sets `mutation.killRate` replaces it.
export const DEFAULT_KILL_RATE = 1;

export function killRateOf(mutation: { minForPass?: number; killRate?: number }): number {
  const k = mutation.killRate;
  return typeof k === "number" && k > 0 && k <= 1 ? k : DEFAULT_KILL_RATE;
}

// The sequential estimate (from 2026-12-beta). Faults are planted in batches until the share caught is
// decided either way, or a cap is reached:
// strong: the one-sided `strongConfidence` Wilson lower bound is at least `strongLow`, and the share
//   caught at least `strongRate`;
// weak: the one-sided `weakConfidence` Wilson upper bound is below `weakHigh`;
// inconclusive otherwise, which leaves the faults condition undetermined, never not met.
export interface EstimateRule {
  batch: number;
  maxDecided: number;
  maxPlanted: number;
  strongConfidence: number;
  strongLow: number;
  strongRate: number;
  weakConfidence: number;
  weakHigh: number;
}

export function estimateRule(mutation: { estimate?: EstimateRule }): EstimateRule | null {
  return mutation.estimate ?? null;
}

// The standard normal quantile (Acklam's rational approximation, relative error below 1.2e-9).
export function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.928510446969, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// One side of the Wilson score interval for k successes in n, at a one-sided confidence.
export function wilsonBound(k: number, n: number, confidence: number, side: "low" | "high"): number {
  if (n === 0) return side === "low" ? 0 : 1;
  const z = normalQuantile(confidence);
  const p = k / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const bound = (side === "low" ? centre - half : centre + half) / (1 + (z * z) / n);
  return Math.min(1, Math.max(0, bound));
}

export function faultEstimate(caught: number, decided: number, rule: EstimateRule, minForPass: number, planted = decided, carried = 0): FaultEstimate {
  const low = wilsonBound(caught, decided, rule.strongConfidence, "low");
  const high = wilsonBound(caught, decided, rule.weakConfidence, "high");
  const rate = decided ? caught / decided : 0;
  const verdict = decided < minForPass ? "inconclusive" : low >= rule.strongLow - 1e-12 && rate >= rule.strongRate - 1e-12 ? "strong" : high < rule.weakHigh ? "weak" : "inconclusive";
  return { planted, decided, caught, rate, low, high, verdict, carried };
}

// Whether to plant another batch: the estimate is still open and neither cap is reached.
export function keepPlanting(est: FaultEstimate, rule: EstimateRule): boolean {
  return est.verdict === "inconclusive" && est.decided < rule.maxDecided && est.planted < rule.maxPlanted;
}

// The looks fall at whole batches of decided faults, the points the rule's error rates were set at.
// When earlier faults were planted again, none is taken before a whole batch of faults no sealed
// report has named, so tests written against the named ones can't decide the estimate alone.
export function atLook(decided: number, rule: EstimateRule, carriedDecided = 0): boolean {
  return decided > 0 && decided % rule.batch === 0 && (carriedDecided === 0 || decided - carriedDecided >= rule.batch);
}

// How many earlier faults may be planted again: enough room is always left for one fresh batch.
export function carriedCap(rule: EstimateRule): number {
  return Math.max(0, rule.maxDecided - rule.batch);
}

// The fault check's result from its counts: not_run when too few faults gave a clear result.
export function faultsVerdict(caught: number, counted: number, mutation: { minForPass: number; killRate?: number }): "pass" | "fail" | "not_run" {
  if (counted < mutation.minForPass) return "not_run";
  return caught >= Math.ceil(killRateOf(mutation) * counted - 1e-9) ? "pass" : "fail";
}
