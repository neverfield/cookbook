import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A shell hook (Cursor's beforeShellExecution) that refuses the repo's own install, build, lint and
// test commands on the host until the user's yes to host mode is recorded, and while an audit is
// open. With beforeReadFile it also refuses reads of the draft records and the planted-fault store. SKILL.md rule 2 asks for that yes; this makes the rule hold before the agent has read any
// output of the scripts. It only refuses: the scripts never depend on it, and an input it can't
// read is let through.

// Host mode's opt-in variable (`--allow-host` sets it). Defined here so the hook loads no more
// than this file.
export const ALLOW_HOST_ENV = "SA_READINESS_ALLOW_HOST";
export const HOOKS_FILE = ".cursor/hooks.json";
export const GUARD_SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), "guard.ts");
// The user's yes to running repo commands on this machine, recorded by `readiness allow-host`.
export const HOST_YES_FILE = ".agent-readiness/work/host-yes.json";
const CURRENT_FILE = ".agent-readiness/work/CURRENT";
// Each refusal, one JSON line, in the clone's own .git folder: outside the repo's files and the
// audit's records, so writing it changes neither. The eval grader reads it to tell a refused call
// from one that ran.
export const GUARD_LOG = ".git/readiness-guard.jsonl";
// How every refusal message starts, so a tool result shows the guard refused the call.
export const GUARD_MARK = "readiness guard: not run.";

// Where faults will be planted lives outside the repo until the seal: mutants.json and seed.txt
// next to the audit tree in $TMPDIR/readiness-aud-*/, with the draft's digest. Naming that folder
// (other than its tree/) or a file in it is a read of the fault locations.
export const FAULT_STORE = /(^|[\s/"'=])mutants?[^\s/"']*\.json\b|readiness-aud-[^\s"'/]*\/(?!tree(\/|\b))[^\s"']*|readiness-(aud-)?\*|readiness-aud-[^\s"'/]*\/?(?=[\s"';|&)]|$)|(^|[\s/"'])(seed\.txt|draft\.digest)\b/;
// The draft audit's own files: CURRENT, and each draft's audit.json and local.json. The scripts
// read them; an agent reading them before the seal sees records the report hasn't vetted.
export const DRAFT_RECORDS = /\.agent-readiness\/work\/(CURRENT\b|[^\s"'\/*]+\/[^\s"'\/*]+)/;

// Why a command or a file read touches records the agent must leave to the scripts, or null.
export function recordsRead(target: string): string | null {
  if (FAULT_STORE.test(target)) return "names where the audit plants its faults, which stays hidden until the seal";
  if (DRAFT_RECORDS.test(target)) return "reads the draft audit's own records under .agent-readiness/work/, which the report hasn't vetted; `readiness status` shows the draft";
  return null;
}

const WRAPPERS = new Set(["time", "nohup", "command", "exec", "builtin", "nice", "sudo", "doas", "xargs", "stdbuf", "caffeinate"]);
const NPM_RUNS = new Set(["test", "t", "tst", "run", "run-script", "rum", "urn", "start", "stop", "restart", "ci", "clean-install", "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isntal", "isntall", "add", "it", "cit", "install-test", "install-ci-test", "clean-install-test", "exec", "x", "rebuild", "rb", "explore", "pack", "publish"]);
const PM_HARMLESS = new Set(["--version", "-v", "-V", "--help", "-h", "help", "info", "view", "why", "list", "ls", "config", "outdated", "audit", "store", "bin", "root", "licenses", "env"]);
const RUNNERS = new Set(["npx", "pnpx", "bunx", "pytest", "py.test", "tox", "nox", "make", "gmake", "tsc", "vitest", "jest", "mocha", "ava", "tap", "playwright", "cypress", "eslint", "biome", "prettier", "ruff", "mypy", "pyright", "flake8", "black", "rspec", "phpunit", "rake", "gradle", "gradlew", "mvn", "mvnw", "turbo", "nx", "lerna", "tsx", "ts-node", "jasmine", "karma", "nodemon"]);
const BUILD_TOOLS = new Set(["cargo", "go", "dotnet", "swift", "uv", "poetry", "pipenv", "pdm", "hatch", "rye", "composer", "bundle", "mix"]);
const BUILD_SUBS = new Set(["test", "run", "build", "bench", "generate", "vet", "check", "exec", "task", "install", "sync", "compile"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const PYTHON = /^python(\d+(\.\d+)*)?$/;

// Splits a command line into simple commands, each as its words, with the contents of $(...) and
// backticks as commands of their own. Quotes group words; nothing is expanded.
export function simpleCommands(line: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" || ch === '"') {
      const close = line.indexOf(ch, i + 1);
      const end = close < 0 ? line.length : close;
      const body = line.slice(i + 1, end);
      if (ch === '"') for (const m of body.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) out.push(...simpleCommands(m[1] ?? m[2]));
      word += body;
      inWord = true;
      i = end;
    } else if (ch === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (ch === "$" && line[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < line.length && depth; j++) depth += line[j] === "(" ? 1 : line[j] === ")" ? -1 : 0;
      out.push(...simpleCommands(line.slice(i + 2, j - 1)));
      word += "$()";
      inWord = true;
      i = j - 1;
    } else if (ch === "`") {
      const close = line.indexOf("`", i + 1);
      const end = close < 0 ? line.length : close;
      out.push(...simpleCommands(line.slice(i + 1, end)));
      i = end;
    } else if (/[;&|\n(){}]/.test(ch)) endCommand();
    else if (/\s/.test(ch)) endWord();
    else if (ch === "#" && !inWord) {
      while (i < line.length && line[i] !== "\n") i++;
      endCommand();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endCommand();
  return out;
}

// The program a simple command runs, past variable assignments, redirections and wrappers.
export function programOf(words: string[]): string[] {
  let w = words.filter((x) => !/^\d*[<>]/.test(x));
  for (;;) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    if (!w.length) return w;
    const p = basename(w[0]);
    if (p === "env") {
      w = w.slice(1);
      while (w.length && (w[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]))) w = w.slice(w[0] === "-u" || w[0] === "-C" ? 2 : 1);
    } else if (p === "timeout") {
      w = w.slice(1);
      while (w.length && w[0].startsWith("-")) w = w.slice(/^-(s|k)$|^--(signal|kill-after)$/.test(w[0]) ? 2 : 1);
      w = w.slice(1);
    } else if (WRAPPERS.has(p)) {
      w = w.slice(1);
      while (w.length && w[0].startsWith("-")) w = w.slice(1);
    } else return w;
  }
}

const firstArg = (w: string[], from = 1) => w.slice(from).find((x) => !x.startsWith("-"));

// Python -c code that runs repo code, with string literals blanked first: a word count of a
// headline that says "tests" runs nothing.
export function pythonRunsRepo(code: string, repo: string): boolean {
  if (code.includes(repo)) return true;
  const bare = code.replace(/("""|''')[\s\S]*?\1|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  return /\bsys\.path\b|\bsrc\b|\btests?\b|\brunpy\b|\bexec\s*\(|\beval\s*\(|\bsubprocess\b|\bos\.(system|popen|exec\w*|spawn\w*)\b|__import__|\bimportlib\b/.test(bare);
}

// Whether one simple command runs repo code outside the readiness scripts, by the eval grader's
// rules (support/evals/lib/shell.ts repoEvidence) without its tracking of functions and variables.
export function runsRepoCode(words: string[], cwd: string, repo: string): boolean {
  const w = programOf(words);
  if (!w.length) return false;
  if (w.some((x) => /(^|\/)scripts\/readiness\.ts$/.test(x))) return false;
  const p = basename(w[0]);
  const inRepo = (path: string) => !/^\$/.test(path) && !relative(repo, resolve(cwd, path)).startsWith("..") && !isAbsolute(relative(repo, resolve(cwd, path)));
  if (/^node(js)?$/.test(p)) {
    for (let i = 1; i < w.length; i++) {
      const a = w[i];
      if (a === "--test" || a.startsWith("--test=")) return true;
      if (["-e", "--eval", "-p", "--print"].includes(a)) return false;
      if (["--import", "--require", "-r", "--loader", "--experimental-loader"].includes(a)) {
        if (w[i + 1] && inRepo(w[i + 1])) return true;
        i++;
        continue;
      }
      if (a.startsWith("-")) continue;
      return inRepo(a);
    }
    return false;
  }
  if (p === "npm") {
    const sub = firstArg(w);
    return Boolean(sub && NPM_RUNS.has(sub));
  }
  if (p === "pnpm" || p === "yarn" || p === "bun") return w[1] === undefined ? p === "yarn" : !PM_HARMLESS.has(w[1]);
  if (p === "deno") return ["test", "run", "task", "bench", "compile", "install"].includes(w[1] ?? "");
  if (RUNNERS.has(p)) return true;
  if (BUILD_TOOLS.has(p)) {
    const sub = firstArg(w);
    return Boolean(sub && (BUILD_SUBS.has(sub) || (p === "uv" && sub === "pip")));
  }
  if (p === "pip" || p === "pip3") return firstArg(w) === "install";
  if (p === "docker" || p === "podman" || p === "docker-compose") {
    const rest = p === "docker-compose" ? w.slice(1) : w[1] === "compose" ? w.slice(2) : w.slice(1);
    return ["up", "run", "start", "build", "exec", "create"].includes(firstArg(rest, 0) ?? "");
  }
  if (PYTHON.test(p)) {
    for (let i = 1; i < w.length; i++) {
      const a = w[i];
      if (a === "-m") return w[i + 1] !== "json.tool";
      if (a === "-c") return pythonRunsRepo(w[i + 1] ?? "", repo);
      if (a.startsWith("-")) continue;
      return inRepo(a);
    }
    return false;
  }
  if (SHELLS.has(p)) {
    const c = w.indexOf("-c");
    if (c > 0 && w[c + 1] !== undefined) return repoCommands(w[c + 1], cwd, repo).length > 0;
    const script = firstArg(w);
    return Boolean(script && inRepo(script));
  }
  if (p === "eval") return repoCommands(w.slice(1).join(" "), cwd, repo).length > 0;
  return w[0].includes("/") && inRepo(w[0]);
}

// The simple commands in a command line that run repo code, following `cd` between them.
export function repoCommands(line: string, cwd: string, repo: string): string[] {
  const out: string[] = [];
  let at = cwd;
  for (const words of simpleCommands(line)) {
    const w = programOf(words);
    if (w[0] === "cd" || w[0] === "pushd") {
      if (w[1] && !w[1].startsWith("-") && !/^[$~]/.test(w[1])) at = resolve(at, w[1]);
      continue;
    }
    if (runsRepoCode(words, at, repo)) out.push(w.join(" "));
  }
  return out;
}

export function repoRoot(from: string): string | null {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

export interface GuardInput {
  command?: string;
  // Set instead of command for a file read (beforeReadFile).
  file_path?: string;
  cwd?: string;
  workspace_roots?: string[];
}

export interface GuardDecision {
  permission: "allow" | "deny";
  user_message?: string;
  agent_message?: string;
}

export function hostYesRecorded(repo: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ALLOW_HOST_ENV] === "1" || existsSync(join(repo, HOST_YES_FILE));
}

function logRefusal(repo: string, kind: "shell" | "read", target: string): void {
  try {
    if (existsSync(join(repo, ".git", "HEAD"))) appendFileSync(join(repo, GUARD_LOG), JSON.stringify({ at: Date.now(), kind, target }) + "\n");
  } catch {
    return;
  }
}

function refuse(repo: string, kind: "shell" | "read", target: string, why: string): GuardDecision {
  logRefusal(repo, kind, target);
  const msg = `${GUARD_MARK} ${why}`;
  return { permission: "deny", user_message: msg, agent_message: msg };
}

export function guardDecision(input: GuardInput, env: NodeJS.ProcessEnv = process.env): GuardDecision {
  const cwd = input.cwd || input.workspace_roots?.[0] || process.cwd();
  const repo = repoRoot(cwd) ?? input.workspace_roots?.[0] ?? cwd;
  if (typeof input.file_path === "string" && input.command === undefined) {
    const why = recordsRead(input.file_path);
    return why ? refuse(repo, "read", input.file_path, `This read ${why}.`) : { permission: "allow" };
  }
  const read = recordsRead(input.command ?? "");
  if (read) return refuse(repo, "shell", input.command ?? "", `This command ${read}.`);
  const found = repoCommands(input.command ?? "", cwd, repo);
  if (!found.length) return { permission: "allow" };
  const shown = found.slice(0, 2).map((c) => `\`${c.length > 80 ? c.slice(0, 77) + "..." : c}\``).join(" and ");
  let why: string;
  if (existsSync(join(repo, CURRENT_FILE))) {
    why = `${shown} runs the repo's own code outside the readiness scripts while an audit is open. Until it is sealed, only the scripts run repo code: \`readiness replay\` in a clean container, or \`readiness run --component <id> --allow-host\` after the user's yes.`;
  } else if (!hostYesRecorded(repo, env)) {
    why = `${shown} runs the repo's own code on this machine, outside a container, and the user's yes to that isn't recorded (SKILL.md rule 2). To see what the repo's commands do, run the audit: its scripts run them in a clean container. If the user says yes to running them here, record it with \`readiness allow-host --note "<their words>"\` and run the command again.`;
  } else return { permission: "allow" };
  return refuse(repo, "shell", input.command ?? "", why);
}

function tracked(repo: string, rel: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", rel], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// The hook steps the guard answers: shell commands and file reads.
export const GUARD_STEPS = ["beforeShellExecution", "beforeReadFile"];

export function guardCommand(script = GUARD_SCRIPT): string {
  return `node --experimental-strip-types --no-warnings ${JSON.stringify(script)}`;
}

interface HooksFile {
  version?: number;
  hooks?: Record<string, { command?: string }[]>;
}

// Adds the guard to the repo's .cursor/hooks.json, kept out of git through .git/info/exclude so
// the audit, which reads the committed tree, never sees it as an agent asset. A hooks.json the repo
// commits is left alone: the team decides what goes in it.
export function installGuard(repo: string, script = GUARD_SCRIPT): { status: "installed" | "present" | "tracked"; file: string } {
  const file = join(repo, HOOKS_FILE);
  if (tracked(repo, HOOKS_FILE)) return { status: "tracked", file };
  const cfg: HooksFile = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as HooksFile) : { version: 1, hooks: {} };
  const hooks = (cfg.hooks ??= {});
  const command = guardCommand(script);
  const lists = GUARD_STEPS.map((step) => (hooks[step] ??= []));
  const present = lists.every((list) => list.some((h) => h.command === command));
  if (!present) {
    for (const list of lists) if (!list.some((h) => h.command === command)) list.push({ command });
    cfg.version ??= 1;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  }
  const exclude = join(repo, ".git", "info", "exclude");
  if (existsSync(join(repo, ".git")) && !(existsSync(exclude) && readFileSync(exclude, "utf8").split("\n").includes(`/${HOOKS_FILE}`))) {
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${existsSync(exclude) && !readFileSync(exclude, "utf8").endsWith("\n") ? "\n" : ""}/${HOOKS_FILE}\n`);
  }
  return { status: present ? "present" : "installed", file };
}

export function recordHostYes(repo: string, note: string, at: string): string {
  const file = join(repo, HOST_YES_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ at, note }, null, 2) + "\n");
  return file;
}
