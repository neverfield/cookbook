import { insideString } from "../patterns.ts";
import type { Site } from "../mutate.ts";
import type { Language } from "../types.ts";

// The fault sites of JavaScript, TypeScript and Python lines, and the C-like rules a language file
// without sites or quoting of its own gets.

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
