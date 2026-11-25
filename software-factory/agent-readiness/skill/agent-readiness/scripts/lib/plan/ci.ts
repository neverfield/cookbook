import { join, normalize } from "node:path";
import { exists, readText } from "../util.ts";

// The commands a repo's CI runs, read from the run steps of its GitHub workflows line by line. The
// skill has no YAML parser, so only `run:` steps are read, each with its working directory and the
// line it starts on, and a step whose directory is a workflow expression is left out.

export interface CiCommand {
  file: string;
  line: number;
  cwd: string;
  command: string;
}

const RUN = /^(\s*)(-\s+)?run:\s*(.*)$/;
const WORKDIR = /^\s*(?:-\s+)?working-directory:\s*(.+?)\s*$/;

const indentOf = (l: string) => l.length - l.trimStart().length;
const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, "$2").trim();

function cleanDir(dir: string): string | null {
  const d = unquote(dir.replace(/\s+#.*$/, ""));
  if (!d || d.includes("${{") || d.includes("$")) return null;
  const n = normalize(d).replace(/\/+$/, "");
  return n === "" || n === "." || n === "./" ? "." : n.replace(/^\.\//, "");
}

// The run step's working directory: its own, or its job's `defaults.run.working-directory`.
function stepDir(lines: string[], at: number, keyCol: number): string | null {
  let start = at;
  const dashCol = keyCol - 2;
  while (start > 0 && !(indentOf(lines[start]) === dashCol && /^\s*-\s/.test(lines[start]))) start--;
  for (let j = start; j < lines.length; j++) {
    if (j > start && lines[j].trim() && indentOf(lines[j]) <= dashCol) break;
    const m = lines[j].match(WORKDIR);
    if (m && (indentOf(lines[j]) === keyCol || (j === start && /^\s*-\s+working-directory:/.test(lines[j])))) return cleanDir(m[1]);
  }
  let job = start;
  while (job > 0 && !/^ {2}[\w-]+:\s*$/.test(lines[job])) job--;
  for (let j = job; j < start; j++) {
    const m = lines[j].match(WORKDIR);
    if (m && /^\s*run:\s*$/.test(lines[j - 1] ?? "") && /^\s*defaults:\s*$/.test(lines[j - 2] ?? "")) return cleanDir(m[1]);
  }
  return ".";
}

// The commands of one run step: a one-line value, or a block's lines with continuations joined.
function stepCommands(lines: string[], at: number, keyCol: number, value: string): { line: number; text: string }[] {
  if (!/^[|>][-+]?\s*$/.test(value)) return value.trim() ? [{ line: at + 1, text: unquote(value) }] : [];
  const out: { line: number; text: string }[] = [];
  let pending: { line: number; text: string } | null = null;
  for (let j = at + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() && indentOf(l) <= keyCol) break;
    const t = l.trim();
    if (!t || t.startsWith("#")) continue;
    if (pending) pending.text += ` ${t.replace(/\\$/, "").trim()}`;
    else pending = { line: j + 1, text: t.replace(/\\$/, "").trim() };
    if (!t.endsWith("\\")) {
      out.push(pending);
      pending = null;
    }
  }
  if (pending) out.push(pending);
  return out;
}

// Every command the workflows' run steps run, split at `&&` and `;`, with a leading `cd dir` applied.
export function ciCommands(tree: string, ciFiles: string[]): CiCommand[] {
  const out: CiCommand[] = [];
  for (const file of [...ciFiles].filter((f) => f.startsWith(".github/workflows/")).sort()) {
    const path = join(tree, file);
    if (!exists(path)) continue;
    const lines = readText(path).split("\n");
    lines.forEach((l, i) => {
      const m = l.match(RUN);
      if (!m) return;
      const keyCol = m[1].length + (m[2]?.length ?? 0);
      const dir = stepDir(lines, i, keyCol);
      if (dir === null) return;
      for (const c of stepCommands(lines, i, keyCol, m[3])) {
        let cwd = dir;
        for (const part of c.text.split(/\s*(?:&&|;)\s*/).filter(Boolean)) {
          const cd = part.match(/^cd\s+(\S+)$/);
          if (cd) {
            const next = cleanDir(join(cwd, unquote(cd[1])));
            if (next === null) break;
            cwd = next;
            continue;
          }
          out.push({ file, line: c.line, cwd, command: part });
        }
      }
    });
  }
  return out;
}

// A test runner run directly, rather than through a package script.
const DIRECT_RUNNER = /\b(pytest|vitest|jest|mocha|ava|tap|tox|nox|phpunit|rspec|uvu|jasmine|karma)\b|\b(go|cargo|dotnet|mix)\s+test\b|\bnode\s+--test\b|\bpython3?\s+-m\s+(pytest|unittest)\b/;
const SCRIPT_CALL = /^(?:corepack\s+)?(?:npm\s+(?:run(?:-script)?\s+)?|pnpm\s+(?:run\s+)?|yarn\s+(?:run\s+)?|bun\s+run\s+)([\w:.-]+)(?:\s|$)/;
const NOT_SCRIPTS = new Set(["install", "i", "ci", "add", "exec", "dlx", "x", "run", "publish", "pack", "link", "version", "audit", "outdated", "why", "list", "ls"]);
const LINKS = /\s*(?:&&|;|\|\|)\s*/;

// The package script a command calls, as `npm test`, `pnpm run test:unit` or `yarn lint` do.
export function scriptCalled(command: string): string | null {
  const m = command.trim().match(SCRIPT_CALL);
  if (!m || NOT_SCRIPTS.has(m[1])) return null;
  return m[1] === "t" ? "test" : m[1];
}

// The script of `scripts` that runs the component's own tests when `name` is called: `name` itself
// when one of its steps runs a test runner, or the one script it calls that does, so a CI step that
// runs format checks, lint and tests in a chain is narrowed to its tests. A step that runs the
// workspace members' scripts (delegates) is never the component's own run. Null when none does.
export function testScriptOf(scripts: Record<string, string>, name: string, delegates: RegExp, depth = 0): string | null {
  const body = scripts[name];
  if (!body || depth > 4 || /no test specified/.test(body)) return null;
  const links = body.split(LINKS).filter((l) => l && !delegates.test(l));
  const own = (l: string) => {
    const s = scriptCalled(l);
    return s !== null && s !== name && scripts[s] !== undefined ? s : null;
  };
  if (links.some((l) => DIRECT_RUNNER.test(l) && !own(l))) return name;
  const reached = [...new Set(links.map(own).filter((s): s is string => s !== null).map((s) => testScriptOf(scripts, s, delegates, depth + 1)).filter((s): s is string => s !== null))];
  return reached.length === 1 ? reached[0] : null;
}

// The test script CI runs for a component in its folder, with the line that runs it. Steps that call
// a script named test come first, then the workflows' order.
export function ciTestScript(ci: CiCommand[], path: string, scripts: Record<string, string>, delegates: RegExp): { script: string; called: string; source: string } | null {
  const found = ci
    .filter((c) => c.cwd === path)
    .flatMap((c) => {
      const called = scriptCalled(c.command);
      const script = called && scripts[called] ? testScriptOf(scripts, called, delegates) : null;
      return script ? [{ script, called: called!, source: `${c.file}:${c.line}` }] : [];
    });
  return found.find((f) => /^test(?:$|[:.-])/.test(f.script)) ?? found[0] ?? null;
}
