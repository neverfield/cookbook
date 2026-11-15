import { statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { Component, Language } from "./types.ts";
import { exists, git, listFiles, readText, sha256 } from "./util.ts";

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

export function testFiles(tree: string, comp: Component): string[] {
  const lang = comp.language;
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
  for (const file of files) {
    const text = readText(join(tree, file));
    const quoted = quotedLines(text, lang);
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (quoted.has(i)) return;
      for (const s of sitesForLine(line, lang)) {
        if (s.operator === "boundary_flip" && equivalentBoundary(lines, i)) continue;
        if (s.operator === "change_constant" && equivalentConstant(lines, i, s.before, s.after)) continue;
        sites.push({ file, line: i + 1, ...s });
      }
    });
  }
  return sites;
}

// The pick depends on the component's code and on `seed`. An empty seed leaves the code alone to
// decide, so the same code always gets the same faults; an eval or a grader passes its own seed to
// get faults the code's own pick didn't plant.
export function chooseSites(repo: string, tree: string, comp: Component, seed: string, count: number): Site[] {
  const files = targetFiles(tree, comp);
  const sites = allSites(tree, files, comp.language);
  if (sites.length === 0) return [];
  const recency = new Map<string, string>();
  for (const f of files) recency.set(f, git(["log", "-1", "--format=%cI", "--", f], repo).stdout.trim());
  const sortedFiles = [...files].sort((a, b) => (recency.get(b) ?? "").localeCompare(recency.get(a) ?? "") || a.localeCompare(b));
  const recentTier = new Set(sortedFiles.slice(0, Math.max(1, Math.ceil(sortedFiles.length / 2))));
  const code = codeDigest(tree, [...files, ...testFiles(tree, comp)]);
  const rand = seededRandom(seed ? `${code}:${seed}` : code, comp.id);
  const shuffled = sites.map((s) => ({ s, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.s);
  const tiered = [...shuffled.filter((s) => recentTier.has(s.file)), ...shuffled.filter((s) => !recentTier.has(s.file))];
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

// The fault check's result from its counts: not_run when too few faults gave a clear result.
export function faultsVerdict(caught: number, counted: number, mutation: { minForPass: number; killRate?: number }): "pass" | "fail" | "not_run" {
  if (counted < mutation.minForPass) return "not_run";
  return caught >= Math.ceil(killRateOf(mutation) * counted - 1e-9) ? "pass" : "fail";
}
