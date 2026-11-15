import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { checkOnly } from "./contract.ts";
import { pyproject, readPackageJson } from "./profile.ts";
import { scanText } from "./redact.ts";
import type { InstructionItem, Profile, SafetyFinding, ScanBound } from "./types.ts";
import { MAX_FILES, exists, inTreePath, listFiles, readText, sha256 } from "./util.ts";

const COMMAND_START = /^(npm|pnpm|yarn|npx|pnpx|bunx|uvx|corepack|make|python3?|pip3?|pytest|uv|poetry|node|bun|cargo|go|tsc|eslint|ruff|cd\s+\S+\s*&&|\.\/[\w./-]+)(\s|$)/;
const SHELL_LANGS = new Set(["", "sh", "bash", "shell", "console", "zsh", "terminal"]);
const PATH_LIKE = /^(?:\.{1,2}\/)[\w./-]+$|^[\w.-]+(?:\/[\w.-]+)*\/$|^(?:[\w.-]+\/)*[\w.-]+\.(md|mdc|ts|tsx|js|mjs|cjs|json|py|ya?ml|sh|toml|txt|sql)$/;

const INSTALL = /^(npm (ci|install|i)\b|pnpm (install|i)\b|yarn( install)?\s*$|yarn install\b|corepack \w+ install\b|bun (install|i)\b|pip3? install\b|python3? -m pip install\b|uv sync\b|poetry (install|sync)\b)/;
const LONG_RUNNING = /\b(run )?(dev|start|serve|watch)(\s|$)|--watch\b|compose up\b|docker run\b/;
const NETWORK_PIPED = /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b/;
const DESTRUCTIVE = /rm -rf\s+(\/|~|\*|\$HOME)|\bdrop (database|table)\b|db:(reset|drop)|migrate(:| )reset|\btruncate\b|prisma migrate reset/i;
const DEPLOY = /\b(npm|pnpm|yarn) publish\b|\bdeploy\b|vercel --prod|firebase deploy|terraform (apply|destroy)|kubectl (apply|delete)|helm (upgrade|install)|gh release create|fly deploy|seed-prod/i;
const ENV_READ = /(?:process\.env\.|process\.env\[['"]|os\.environ(?:\.get)?\(?\[?['"]|getenv\(['"]|ENV\.fetch\(['"]|ENV\[['"])([A-Z][A-Z0-9_]*)/g;

// Every instruction result names the rule that produced it, and the report prints the rule's text.
export const INSTRUCTION_RULES: Record<string, string> = {
  "path-exists": "A file or folder the instructions name must exist in the repo, next to the instruction file, at the root or inside the package that owns it.",
  "script-exists": "A package-manager script the instructions run must be in the package.json of the folder it runs in.",
  "make-target": "A Make target the instructions run must be in the Makefile.",
  "package-manager": "Install and add commands must use the repo's package manager, and only npm, which every Node install has, may run scripts in a repo that uses another one.",
  "file-exists": "A file the instructions run, such as `node x.js` or `./script.sh`, must exist in the repo.",
  "folder-exists": "A folder the instructions change into, or pass with --directory, must exist in the repo.",
  "install-static": "Install commands are checked statically; the clean replay runs the frozen install instead.",
  replay: "A command that passes the static checks runs in a copy of the repo and must exit 0.",
  "replay-environment": "A replayed command that fails only because of the machine, such as a missing tool, the network or a credential, isn't counted against the repo.",
  "replay-budget": "No instruction starts once the audit's time budget is spent.",
  "replay-install": "Instructions replay only after the clean install succeeds.",
  "same-as-check": "An instruction that runs the same command as a check the audit already ran takes that check's result, and a failure counts once, under the check, not again as a wrong instruction.",
  consumer: "Usage for the package's users in a README, outside a section about developing the repo, isn't a step for working on this repo, unless it runs one of the repo's own scripts or Make targets.",
  "own-package": "A command that installs or runs this repo's own package, as its users would, isn't a step for working on this repo.",
  mention: "A command named in prose, as an example or inside a link, isn't given as a step to run.",
  negated: "A command the instructions say not to run isn't replayed.",
  elsewhere: "Steps written for another checkout or repository aren't checked against this one.",
  duplicate: "A README command that an earlier agent instruction file already gives is checked once, there.",
  vendored: "A third-party skill copied into the repo documents its own tool, not this repo.",
  placeholder: "A command with a placeholder to fill in can't be run as written.",
  interactive: "A command that asks questions as it runs can't be replayed unattended.",
  "adds-packages": "A command that adds or removes packages changes the dependencies, so it isn't replayed.",
  rewrites: "A lint or format command that rewrites files is run check-only by the commands check, not replayed as written.",
  links: "A command that links packages into the machine's global folder isn't replayed.",
  "built-program": "A program a build or a download makes first, such as `./app serve`, isn't in a clean checkout, so it isn't checked or replayed.",
  "unassessed-stack": "A command for a toolchain this audit doesn't assess, such as Go, isn't replayed.",
  downloads: "A runner command that downloads a package the repo doesn't depend on needs the network, which the replay doesn't provide.",
  risky: "A command that deploys, publishes, deletes data or pipes a download into a shell is never replayed.",
  "long-running": "A command that starts a long-running process, such as a dev server, isn't replayed.",
  sudo: "A command that uses sudo isn't replayed.",
  "machine-path": "A command that refers to a path on the author's machine isn't replayed.",
  "future-path": "A path the docs say will exist later isn't counted as stale.",
  waived: "A committed waiver marks this finding as a false positive; it no longer counts, and the report lists it.",
};

// A production credential: PROD, PRODUCTION or LIVE as a word of the name, next to a word that
// holds a secret or a connection string. PRODUCT_DATABASE_URL and MEDUSA_PRODUCTION_VERSION aren't.
export function prodCredential(name: string): boolean {
  const words = name.split("_");
  return words.some((w) => /^(PROD|PRODUCTION|LIVE)$/.test(w)) && words.some((w) => /^(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH|DSN|URL|URI|CONNECTION)$/.test(w));
}

export function isRisky(cmd: string): boolean {
  return NETWORK_PIPED.test(cmd) || DESTRUCTIVE.test(cmd) || DEPLOY.test(cmd);
}

export type Cue = "example" | "negated" | "link_text" | "deleted";

interface Extracted {
  kind: "command" | "path";
  text: string;
  line: number;
  via: "fence" | "code" | "link";
  // The headings the item sits under, outermost first.
  headings: string[];
  cue?: Cue;
  // A checkout or repository the steps around it are written for, when it isn't this one.
  elsewhere?: string;
  // The folder of this repo the section says to work in.
  within?: string;
}

const EXAMPLE_CUE = /\b(like|such as|e\.g\.|eg\.|for example|for instance|i\.e\.|say|as in)[\s,:]*[("'`]*$/i;
const NEGATED_CUE = /\b(never|don't|do not|doesn't|does not|must not|mustn't|should not|shouldn't|avoid|instead of|rather than|not with|not by|nor)\b/i;
const DELETED_CUE = /\b(is|are|was|were|has been|have been|got)\s+(now\s+)?(gone|deleted|removed|retired|dropped)\b|\((deleted|removed|gone|retired)\)|\bno longer (exists?|used|there)\b|\bused to (be|live)\b/i;
const ELSEWHERE_CUE = /\b(inside|within|in|navigate to|go to|switch to|cd into)\s+(the\s+)?`([^`]+)`\s*(directory|folder|repo|repository|checkout|clone|project)?/i;

// The prose right before an inline span, cut at the last clause break, so "don't run `a`, run `b`"
// reads `b` as a step.
function clauseBefore(before: string): string {
  return before.split(/[.!?;,]\s+|\s+(?:but|then|and then)\s+/).pop() ?? before;
}

// The sentence or table cell around a position, so "`a` is gone" says nothing about `b` next to it.
function sentenceAt(raw: string, index: number): string {
  const breaks = /[.!?](?=\s)|\|/g;
  let start = 0;
  let end = raw.length;
  for (const m of raw.matchAll(breaks)) {
    if (m.index! < index) start = m.index! + 1;
    else {
      end = m.index!;
      break;
    }
  }
  return raw.slice(start, end);
}

function inLinkText(raw: string, start: number, end: number): boolean {
  const open = raw.lastIndexOf("[", start);
  return open >= 0 && raw.indexOf("]", open) >= end && /^[^[]*\]\(/.test(raw.slice(end));
}

function indentOf(raw: string): number {
  return raw.match(/^\s*(?:(?:[-*+]|\d+[.)])\s+)?/)?.[0].length ?? 0;
}

export function extractFromMarkdown(text: string, opts: { exists?: (p: string) => boolean } = {}): Extracted[] {
  const out: Extracted[] = [];
  const lines = text.split("\n");
  let inFence = false;
  let fenceLang = "";
  let inFrontmatter = lines[0]?.trim() === "---";
  let pending: { text: string; line: number } | null = null;
  const headings: { level: number; text: string }[] = [];
  let away: { target: string; indent: number } | null = null;
  // A folder of this repo the section's steps say to work in, such as "Navigate to the `ui` directory".
  let within: string | null = null;
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (inFrontmatter) {
      if (i > 0 && raw.trim() === "---") inFrontmatter = false;
      return;
    }
    const fence = raw.match(/^\s*```(\w*)/);
    if (!inFence && away && raw.trim() && indentOf(raw) <= away.indent && !fence) away = null;
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLang = fence[1].toLowerCase();
      } else inFence = false;
      pending = null;
      return;
    }
    const where = { headings: headings.map((h) => h.text), ...(away ? { elsewhere: away.target } : {}), ...(within ? { within } : {}) };
    if (inFence) {
      if (!SHELL_LANGS.has(fenceLang)) return;
      const part = raw.trim().replace(/^\$\s+/, "");
      const joined: { text: string; line: number } = pending ? { text: `${pending.text} ${part}`, line: pending.line } : { text: part, line: lineNo };
      if (part.endsWith("\\")) {
        pending = { text: joined.text.slice(0, -1).trim(), line: joined.line };
        return;
      }
      pending = null;
      const cmd = joined.text.replace(/\s+#(\s.*)?$/, "").trim();
      if (cmd && !cmd.startsWith("#") && COMMAND_START.test(cmd)) out.push({ kind: "command", text: cmd, line: joined.line, via: "fence", ...where });
      return;
    }
    const heading = raw.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      headings.push({ level, text: heading[2].replace(/`/g, "") });
      away = null;
      within = null;
    }
    const scope = raw.match(ELSEWHERE_CUE);
    if (scope && opts.exists) {
      const target = scope[3].replace(/\/$/, "");
      const named = Boolean(scope[4]) || /^(navigate|go|switch|cd)/i.test(scope[1]);
      if (!opts.exists(target) && (target.includes("/") || scope[4])) away = { target: scope[3], indent: indentOf(raw) };
      else if (opts.exists(target) && named && !/\.\w+$/.test(target)) within = target;
    }
    for (const m of raw.matchAll(/`([^`]+)`/g)) {
      const span = m[1].trim();
      const before = clauseBefore(raw.slice(0, m.index));
      const cue: Cue | undefined = inLinkText(raw, m.index!, m.index! + m[0].length) ? "link_text" : EXAMPLE_CUE.test(before) ? "example" : NEGATED_CUE.test(before) ? "negated" : DELETED_CUE.test(sentenceAt(raw, m.index!)) ? "deleted" : undefined;
      const base = { line: lineNo, via: "code" as const, ...where, ...(cue ? { cue } : {}) };
      if (COMMAND_START.test(span) && span.includes(" ")) out.push({ kind: "command", text: span, ...base });
      else if (PATH_LIKE.test(span) && !span.startsWith("http") && !span.includes("<")) out.push({ kind: "path", text: span, ...base });
    }
    for (const m of raw.matchAll(/\[[^\]]*\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^([a-z][\w+.-]*:|#)/i.test(target) || target.includes("<")) continue;
      out.push({ kind: "path", text: target, line: lineNo, via: "link", ...where });
    }
  });
  const seen = new Set<string>();
  return out.filter((e) => {
    const key = `${e.kind}:${e.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scriptsAt(tree: string, dir: string): { scripts: Record<string, string>; at: string } | null {
  let d = dir;
  while (true) {
    const pkg = readPackageJson(join(tree, d));
    if (pkg) return { scripts: pkg.scripts ?? {}, at: d };
    if (d === "." || d === "") return null;
    d = dirname(d);
  }
}

function makeTargets(tree: string, dir: string): string[] | null {
  for (const d of [dir, "."]) {
    const f = join(tree, d, "Makefile");
    if (exists(f)) return [...readText(f).matchAll(/^([A-Za-z0-9_.-]+)\s*:/gm)].map((m) => m[1]);
  }
  return null;
}

const OTHER_STACK_RECIPES: Record<string, RegExp> = { go: /^\s*(go|golangci-lint|gofmt)\s/m, rust: /^\s*(cargo|rustc)\s/m };

// The commands a Make target runs, without the @ and - prefixes.
function makeRecipe(tree: string, dir: string, target: string): string {
  for (const d of [dir, "."]) {
    const f = join(tree, d, "Makefile");
    if (!exists(f)) continue;
    const lines = readText(f).split("\n");
    const at = lines.findIndex((l) => new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(l));
    if (at < 0) continue;
    const body: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (!/^\t/.test(l)) break;
      body.push(l.replace(/^\t[@-]*/, ""));
    }
    return body.join("\n");
  }
  return "";
}

// The folder a command from an instruction file runs in: the nearest folder at or above the file
// with a package manifest, so a skill under .claude/skills/ runs at the root and a package's own
// AGENTS.md runs in that package.
export function packageDirOf(tree: string, file: string): string {
  let d = dirname(file) === "" ? "." : dirname(file);
  while (d !== "." && d !== "") {
    if (["package.json", "pyproject.toml", "setup.py"].some((m) => exists(join(tree, d, m)))) return d;
    d = dirname(d);
  }
  return ".";
}

// The shell pieces of a command line: split on &&, ||, ;, | and &, outside quotes.
export function shellSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"') cur += cmd[++i] ?? "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\\") {
      cur += ch + (cmd[++i] ?? "");
      continue;
    }
    if (cmd.startsWith("&&", i) || cmd.startsWith("||", i)) {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function argv(segment: string): string[] {
  const words = segment.split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ""));
  while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  if (words[0] === "env" || words[0] === "time") words.shift();
  return words.filter(Boolean);
}

// Names this repo publishes, as packages or commands: what its users install and run.
interface RepoNames {
  own: Set<string>;
  deps: Set<string>;
}

const KNOWN_BINS: Record<string, string> = { tsc: "typescript", tsserver: "typescript", playwright: "@playwright/test", biome: "@biomejs/biome", "ts-node": "ts-node", tsx: "tsx", vite: "vite", vitest: "vitest", jest: "jest", eslint: "eslint", prettier: "prettier", next: "next", turbo: "turbo", changeset: "@changesets/cli", "lint-staged": "lint-staged", husky: "husky", rimraf: "rimraf", tsup: "tsup", tsdown: "tsdown", attw: "@arethetypeswrong/cli" };

function repoNames(tree: string, profile: Profile): RepoNames {
  const own = new Set<string>();
  const deps = new Set<string>();
  for (const m of profile.manifests) {
    const dir = dirname(m);
    if (m.endsWith("package.json")) {
      const pkg = readPackageJson(join(tree, dir)) as (ReturnType<typeof readPackageJson> & { bin?: string | Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }) | null;
      if (!pkg) continue;
      if (pkg.name) own.add(pkg.name);
      if (pkg.name && typeof pkg.bin === "string") own.add(pkg.name.replace(/^@[^/]+\//, ""));
      if (pkg.bin && typeof pkg.bin === "object") for (const b of Object.keys(pkg.bin)) own.add(b);
      for (const group of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies]) for (const d of Object.keys(group ?? {})) deps.add(d);
    } else if (m.endsWith("pyproject.toml")) {
      const text = pyproject(join(tree, dir));
      const name = text.match(/^\[project\][\s\S]*?^name\s*=\s*["']([^"']+)["']/m)?.[1];
      if (name) own.add(name);
      const scripts = text.match(/^\[project\.scripts\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
      for (const s of scripts.matchAll(/^["']?([\w.-]+)["']?\s*=/gm)) own.add(s[1]);
    }
  }
  return { own, deps };
}

function packageName(spec: string): string {
  return spec.startsWith("@") ? spec.replace(/^(@[^/@]+\/[^@]+)@.*$/, "$1") : spec.replace(/@.*$/, "");
}

function localTool(names: RepoNames, pkg: string): boolean {
  if (names.deps.has(pkg) || names.own.has(pkg)) return true;
  if (KNOWN_BINS[pkg] && names.deps.has(KNOWN_BINS[pkg])) return true;
  return [...names.deps].some((d) => d.replace(/^@[^/]+\//, "") === pkg);
}

const BUILTIN_RUN = new Set(["test", "start", "stop", "restart"]);
const PM_COMMANDS = new Set(["install", "i", "ci", "add", "remove", "rm", "uninstall", "exec", "dlx", "x", "init", "create", "why", "list", "ls", "outdated", "update", "up", "upgrade", "audit", "link", "unlink", "pack", "publish", "version", "config", "help", "workspace", "workspaces", "set", "plugin", "constraints", "dedupe", "npm", "info", "cache", "bin", "patch", "unplug", "rebuild", "node", "global", "import", "licenses", "store", "env", "setup", "prune", "root", "fetch", "deploy", "recursive", "-r", "whoami", "login", "logout", "deprecate", "dist-tag", "owner", "search", "view", "doctor", "explain", "run", "run-script"]);
const WORKSPACE_FLAG = /^(-w|--workspace|--filter|-F|--dir|-C|--prefix|--cwd)(=(.*))?$/;
const RUNNERS = new Set(["npx", "pnpx", "bunx", "uvx"]);
const BUILD_OUTPUT = /(^|\/)(dist|build|out|\.next|coverage|target|node_modules)\//;
const OTHER_STACKS: Record<string, string> = { go: "go", cargo: "rust" };

interface CheckCtx {
  tree: string;
  profile: Profile;
  fileDir: string;
  names: RepoNames;
  via: Extracted["via"];
}

// A static check's verdict on one command. skip and access name why it isn't replayed; repo says
// it runs one of the repo's own scripts or targets, so it is about this repo wherever it's written.
interface Check {
  result: "pass" | "fail";
  rule: string;
  reason?: string;
  skip?: string;
  access?: string;
  repo?: boolean;
}

const PASS: Check = { result: "pass", rule: "replay" };

function pathIn(ctx: CheckCtx, dir: string, p: string): boolean {
  return [dir, ctx.fileDir, "."].some((d) => exists(join(ctx.tree, normalize(join(d, p)))));
}

function pmAt(ctx: CheckCtx, dir: string): string | null {
  const owner = ctx.profile.components.filter((c) => c.packageManager && (c.path === "." || dir === c.path || dir.startsWith(c.path + "/"))).sort((a, b) => b.path.length - a.path.length)[0];
  return owner?.packageManager ?? ctx.profile.packageManager;
}

function checkRunner(ctx: CheckCtx, dir: string, words: string[]): Check {
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) i += /^(-p|--package)$/.test(words[i]) ? 2 : 1;
  const spec = words[i];
  if (!spec) return PASS;
  if (/^\.{1,2}\//.test(spec)) return pathIn(ctx, dir, spec) ? PASS : { result: "fail", rule: "file-exists", reason: `${spec} doesn't exist` };
  const pkg = packageName(spec);
  if (ctx.names.own.has(pkg) && !ctx.names.deps.has(pkg)) return { ...PASS, rule: "own-package", skip: `not replayed: it runs ${pkg}, this repo's own package, as its users would` };
  if (localTool(ctx.names, pkg)) return PASS;
  return { ...PASS, rule: "downloads", access: `not replayed: it downloads ${pkg} from the registry, which the replay doesn't provide` };
}

function checkPackageManager(ctx: CheckCtx, dir: string, all: string[]): Check {
  // Folder and workspace flags, with their values, come out first: `pnpm --dir web test` runs web's test.
  const folders: string[] = [];
  const words: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const m = all[i].match(WORKSPACE_FLAG);
    if (!m || i === 0) {
      words.push(all[i]);
      continue;
    }
    // pnpm's -w means the workspace root and takes no value.
    if (all[0] === "pnpm" && m[1] === "-w" && !m[3]) continue;
    const value = m[3] ?? all[++i];
    if (value !== undefined) folders.push(value);
  }
  const tool = words[0];
  const sub = words[1];
  if (tool !== "npm" && sub && ["dlx", "x"].includes(sub)) return checkRunner(ctx, dir, words.slice(1));
  if (sub && !/^(-|[a-z@])[\w:.@/=-]*$/i.test(sub)) return { ...PASS, rule: "mention", skip: "not replayed: it is output quoted in the instructions, not a command" };
  if (sub === "link" || sub === "unlink") return { ...PASS, rule: "links", skip: "not replayed: it links packages into the machine's global folder" };
  const pm = pmAt(ctx, dir);
  const nodeRepo = pm === "npm" || pm === "pnpm" || pm === "yarn" || pm === "bun";
  const otherPm = nodeRepo && tool !== pm;
  const args = words.slice(2).filter((w) => !w.startsWith("-"));
  const installs = !sub ? tool === "yarn" : ["install", "i", "ci", "add"].includes(sub);
  if (installs) {
    const pkgs = sub === "ci" ? [] : args.map(packageName);
    const mine = pkgs.find((p) => ctx.names.own.has(p) && !ctx.names.deps.has(p));
    if (mine) return { ...PASS, rule: "own-package", skip: `not replayed: it installs ${mine}, this repo's own package, as its users would` };
    if (otherPm) return { result: "fail", rule: "package-manager", reason: `uses ${tool}, but the repo uses ${pm}` };
    return { ...PASS, rule: "install-static", repo: pkgs.length === 0 };
  }
  let scriptDir = dir;
  for (const value of folders) {
    if (!value || MACHINE_PATH.test(` ${value}`)) continue;
    if (/^\.{0,2}\//.test(value) || (value.includes("/") && !value.startsWith("@") && !/[*{]/.test(value))) {
      if (!pathIn(ctx, dir, value)) return { result: "fail", rule: "folder-exists", reason: `there is no ${value} folder` };
      scriptDir = normalize(join(dir, value));
      if (!exists(join(ctx.tree, scriptDir))) scriptDir = normalize(value);
    } else return otherPm && tool !== "npm" ? { result: "fail", rule: "package-manager", reason: `uses ${tool}, but the repo uses ${pm}` } : PASS;
  }
  let script: string | null = null;
  if (sub === "run" || sub === "run-script") script = words.slice(2).find((w) => !w.startsWith("-")) ?? null;
  else if (sub && BUILTIN_RUN.has(sub)) script = sub;
  else if (tool !== "npm" && sub && !PM_COMMANDS.has(sub) && !sub.startsWith("-")) script = sub;
  if (!script) return PASS;
  if (otherPm && tool !== "npm") return { result: "fail", rule: "package-manager", reason: `uses ${tool}, but the repo uses ${pm}` };
  const found = scriptsAt(ctx.tree, scriptDir) ?? scriptsAt(ctx.tree, ".");
  if (!found || !(script in found.scripts)) return { result: "fail", rule: "script-exists", reason: `no "${script}" script in ${found ? (found.at === "." ? "" : found.at + "/") + "package.json" : "package.json"}` };
  return { ...PASS, repo: true };
}

// The file a node or python command runs, past the options that take a value; null for -e, -c or -m.
function scriptArg(words: string[]): string | null | undefined {
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (/^(-e|--eval|-p|--print|-c|-m)$/.test(w)) return null;
    if (/^(-r|--require|--import|--loader|--experimental-loader|--env-file|-W|-X)$/.test(w)) {
      i++;
      continue;
    }
    if (w.startsWith("-")) continue;
    return w;
  }
  return undefined;
}

function checkOne(ctx: CheckCtx, dir: string, words: string[]): Check {
  const tool = words[0];
  if (RUNNERS.has(tool)) return checkRunner(ctx, dir, words);
  if (tool === "npm" || tool === "pnpm" || tool === "yarn" || tool === "bun") {
    if (tool === "bun" && words[1] && !["run", "install", "i", "add", "remove", "x", "link", "unlink"].includes(words[1]) && /\.\w+$/.test(words[1])) return checkOne(ctx, dir, ["node", ...words.slice(1)]);
    return checkPackageManager(ctx, dir, words);
  }
  if (tool === "make") {
    const cIdx = words.indexOf("-C");
    const mdir = cIdx > 0 && words[cIdx + 1] ? normalize(join(dir, words[cIdx + 1])) : ctx.fileDir;
    const targets = makeTargets(ctx.tree, mdir);
    const target = words.slice(1).find((w, i) => !w.startsWith("-") && !w.includes("=") && words[i] !== "-C");
    if (!targets) return { result: "fail", rule: "make-target", reason: "there is no Makefile" };
    if (target && !targets.includes(target)) return { result: "fail", rule: "make-target", reason: `the Makefile has no "${target}" target` };
    const recipe = target ? makeRecipe(ctx.tree, mdir, target) : "";
    const stack = Object.entries(OTHER_STACK_RECIPES).find(([, re]) => re.test(recipe))?.[0];
    if (stack && !ctx.profile.components.some((c) => c.assessed && c.stack === stack)) {
      return { ...PASS, rule: "unassessed-stack", skip: `not replayed: the "${target}" target runs ${stack === "go" ? "Go" : "Rust"}, and this audit doesn't assess that part of the repo` };
    }
    return { ...PASS, rule: "make-target", repo: true };
  }
  if (OTHER_STACKS[tool] && !ctx.profile.components.some((c) => c.assessed && c.stack === OTHER_STACKS[tool])) {
    return { ...PASS, rule: "unassessed-stack", skip: `not replayed: it's a ${tool === "go" ? "Go" : "Rust"} command, and this audit doesn't assess that part of the repo` };
  }
  if (/^\.{1,2}\//.test(tool)) {
    if (pathIn(ctx, dir, tool)) return { ...PASS, rule: "file-exists" };
    if (!/\.\w+$/.test(basename(tool)) && !tool.slice(2).includes("/")) return { ...PASS, rule: "built-program", skip: `not replayed: it runs ${tool}, a program a build or a download makes first` };
    return { result: "fail", rule: "file-exists", reason: `${tool} doesn't exist` };
  }
  if (tool === "uv") {
    for (let i = 1; i < words.length; i++) {
      const m = words[i].match(/^--(directory|project)(=(.*))?$/);
      const value = m ? (m[3] ?? words[i + 1]) : undefined;
      if (value && !pathIn(ctx, dir, value)) return { result: "fail", rule: "folder-exists", reason: `there is no ${value} folder` };
    }
    return PASS;
  }
  if (/^(node|python3?|tsx|ts-node)$/.test(tool)) {
    const file = scriptArg(words);
    if (file === undefined && ctx.via === "code" && !words.includes("--test")) return { ...PASS, rule: "mention", skip: `not replayed: it names ${tool}'s options, not a step to run` };
    if (!file || file.startsWith("$") || BUILD_OUTPUT.test(normalize(file))) return PASS;
    if (!/[./]/.test(file) && tool !== "node") return PASS;
    const variants = tool === "node" && !/\.\w+$/.test(file) ? [file, `${file}.js`, `${file}.mjs`, `${file}.cjs`, `${file}/index.js`] : [file];
    return variants.some((v) => pathIn(ctx, dir, v)) ? { ...PASS, rule: "file-exists" } : { result: "fail", rule: "file-exists", reason: `${file} doesn't exist` };
  }
  return PASS;
}

// Every piece of a command line is checked in order, following `cd`, so `cd web && npm test` checks web's scripts.
function checkCommand(cmd: string, ctx: CheckCtx, start: string): Check {
  let dir = start;
  let repo = false;
  let last: Check = PASS;
  for (const seg of shellSegments(cmd)) {
    const words = argv(seg);
    if (!words.length) continue;
    if (words[0] === "cd") {
      const target = words[1];
      if (!target || target === "-" || target.startsWith("$") || MACHINE_PATH.test(` ${target}`)) continue;
      const next = normalize(join(dir, target));
      if (next.startsWith("..")) continue;
      if (exists(join(ctx.tree, next))) dir = next;
      else if (exists(join(ctx.tree, normalize(target)))) dir = normalize(target);
      else return { result: "fail", rule: "folder-exists", reason: `there is no ${target} folder to cd into` };
      continue;
    }
    if (!COMMAND_START.test(words.join(" "))) continue;
    const r = checkOne(ctx, dir, words);
    if (r.result === "fail" || r.skip || r.access) return r;
    repo ||= Boolean(r.repo);
    last = r;
  }
  return { ...last, repo };
}

const MACHINE_PATH = /(^|\s|=)(~\/|\$HOME\b|\/Users\/|\/home\/[a-z])/;

export const ELEVATED = /(^|[\s;&|(`]|\$\()sudo(\s|$)/;

function categorize(cmd: string): InstructionItem["category"] {
  if (isRisky(cmd)) return "risky";
  if (ELEVATED.test(cmd)) return "needs_access";
  if (INSTALL.test(cmd)) return "install";
  if (LONG_RUNNING.test(cmd)) return "long_running";
  if (MACHINE_PATH.test(cmd)) return "needs_access";
  return "replay";
}

const FUTURE = /\b(will (be )?(add|creat|live|hold|contain)\w*|(to be|not yet) (added|created|written)|(added|created|written|coming) (later|as|when|once)|later on|planned|upcoming|in the future|doesn't exist yet|does not exist yet|TODO)\b/i;

// Commands an instruction shows as a template, asks questions, or changes the dependencies with.
// None of them can be replayed as written, so they are listed as skipped instead.
const PLACEHOLDER = /<[A-Za-z][\w.:/-]*>|\{\{[^}]+\}\}|…|(^|\s)\.\.\.(\s|$)/;
const RUNNER = String.raw`(npx|bunx|pnpx|(corepack\s+)?(pnpm|yarn)\s+dlx)\s+(-\S+\s+)*`;
const INTERACTIVE = new RegExp(String.raw`^(corepack\s+)?(npm|pnpm|yarn|bun)\s+(init|create|login|adduser)\b|^${RUNNER}(create-[\w-]+|\S+\s+init)\b|(^|\s)(auth\s+)?login(\s|$)|\s(-i|--interactive)(\s|$)|^(node|python3?)\s*$`);
const ADDS_PACKAGES = new RegExp(String.raw`^(corepack\s+)?(pnpm|yarn|bun)\s+(add|remove|rm|uninstall)\b|^npm\s+(i|install|add|uninstall|rm|remove)\b(\s+-\S+)*\s+[^-\s]|^(python3?\s+-m\s+)?pip3?\s+install\s+(?!.*(\s|^)(-r|-e|--requirement|--editable|\.)(\s|$))|^(uv|poetry|pdm)\s+(add|remove)\b|^${RUNNER}\S+\s+add\b`);

function skippedReason(cmd: string): { reason: string; rule: string } | null {
  if (PLACEHOLDER.test(cmd)) return { reason: "not replayed: it has a placeholder to fill in", rule: "placeholder" };
  if (INTERACTIVE.test(cmd)) return { reason: "not replayed: it asks questions as it runs", rule: "interactive" };
  if (ADDS_PACKAGES.test(cmd)) return { reason: "not replayed: it adds or removes packages", rule: "adds-packages" };
  return null;
}

// A documented lint or format command that rewrites files, directly or through the script it calls.
// The commands check runs its check-only form; replaying it as written would rewrite the copy.
function writesFiles(cmd: string, tree: string, fileDir: string, profile: Profile): string | null {
  const scripts = (scriptsAt(tree, fileDir) ?? scriptsAt(tree, "."))?.scripts ?? {};
  const { changes } = checkOnly(cmd, scripts, profile.packageManager);
  return changes.length ? `not replayed: it rewrites files as written; the commands check runs it check-only (${changes.join(", ")})` : null;
}

const SKILL_FILE = /^\.(cursor|claude|agents)\/skills\/([^/]+)\/SKILL\.md$/;

// A third-party skill copied into the repo documents its own tool, not this repo, so its commands
// aren't replayed. It is vendored when skills-lock.json lists it, a license ships with it, or its
// frontmatter names where it came from.
export function vendoredSkills(tree: string, files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let lock: Record<string, { source?: string }> = {};
  try {
    lock = exists(join(tree, "skills-lock.json")) ? ((JSON.parse(readText(join(tree, "skills-lock.json"))) as { skills?: typeof lock }).skills ?? {}) : {};
  } catch {
    lock = {};
  }
  for (const file of files) {
    const m = file.match(SKILL_FILE);
    if (!m) continue;
    const name = m[2];
    const dir = join(tree, dirname(file));
    const front = readText(join(tree, file)).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const from = front.match(/^(source|repository|upstream):\s*(.+)$/m)?.[2]?.trim();
    if (name in lock) out.set(file, `${lock[name].source ? `${lock[name].source}, ` : ""}listed in skills-lock.json`);
    else if (from) out.set(file, `from ${from}`);
    else if (/^license:/m.test(front) || listFiles(dir).some((f) => /^LICEN[CS]E(\.\w+)?$/i.test(f))) out.set(file, "it ships its own license");
  }
  return out;
}

// The same instruction file reached twice, through a symlink or as an identical copy, is checked once.
function duplicateOf(tree: string, file: string, seen: Map<string, string>): string | null {
  let key: string;
  try {
    key = `${realpathSync(join(tree, file))}`;
  } catch {
    return null;
  }
  const digest = `sha:${sha256(readText(join(tree, file)))}`;
  const first = seen.get(key) ?? (SKILL_FILE.test(file) ? seen.get(digest) : undefined);
  if (first) return first;
  seen.set(key, file);
  if (SKILL_FILE.test(file)) seen.set(digest, file);
  return null;
}

const README = /(^|\/)readme\.md$/i;
const DEV_HEADING = /contribut|develop|hacking|local (dev|setup|install)|from source|build(ing)? (it |the [\w ]+ )?locally|running (the )?tests|run(ning)? (it )?locally|\btesting\b|set ?up for|working on|maintain/i;

// Tracked paths that end in the given one, for a package-relative path written from the root:
// `server/index.ts` in a monorepo skill means src/everything/server/index.ts.
function packageRelative(files: string[], scope: string, rel: string): boolean {
  const tail = "/" + rel.replace(/\/$/, "");
  return files.some((f) => (scope === "." || f.startsWith(scope + "/")) && (f.endsWith(tail) || f.includes(tail + "/")));
}

const CUE_SKIP: Record<Cue, { reason: string; rule: string }> = {
  example: { reason: "not replayed: it's mentioned as an example, not given as a step", rule: "mention" },
  link_text: { reason: "not replayed: it's the text of a link, not a step", rule: "mention" },
  negated: { reason: "not replayed: the instructions say not to run it", rule: "negated" },
  deleted: { reason: "", rule: "path-exists" },
};

export function instructionItems(tree: string, profile: Profile): InstructionItem[] {
  const items: InstructionItem[] = [];
  let n = 1;
  let files: string[] | null = null;
  let basenames: Set<string> | null = null;
  const tracked = () => (files ??= listFiles(tree, { includeHidden: true }));
  const vendored = vendoredSkills(tree, profile.instructionFiles);
  const seen = new Map<string, string>();
  const listed = new Set(profile.instructionFiles);
  const names = repoNames(tree, profile);
  const earlier = new Map<string, string>();
  for (const file of profile.instructionFiles) {
    // Reached through a symlink to a file the scan also lists: check it once, at its tracked path.
    const real = inTreePath(tree, file);
    if (real && real !== file && listed.has(real)) continue;
    if (duplicateOf(tree, file, seen)) continue;
    const fileDir = dirname(file) === "" ? "." : dirname(file);
    const pkgDir = packageDirOf(tree, file);
    const text = readText(join(tree, file));
    const lines = text.split("\n");
    const thirdParty = vendored.get(file);
    const readme = README.test(file);
    const ctx: CheckCtx = { tree, profile, fileDir, names, via: "fence" };
    const fromHere = (p: string) => exists(join(tree, normalize(join(fileDir, p)))) || exists(join(tree, p));
    for (const e of extractFromMarkdown(text, { exists: fromHere })) {
      // A vendored skill's paths belong to its own workflow, such as the plans it writes, not this repo.
      if (e.kind === "path" && thirdParty) continue;
      if (e.kind === "path") {
        const rel = e.text.replace(/\/$/, "");
        const fromFile = normalize(join(fileDir, rel));
        if (fromFile.startsWith("..") && normalize(rel).startsWith("..")) continue;
        const found = exists(join(tree, fromFile)) || (!normalize(rel).startsWith("..") && (exists(join(tree, rel)) || exists(join(tree, normalize(join(pkgDir, rel))))));
        if (!found) {
          // A path the docs say comes later, or say is gone, can't mislead an agent into using it now.
          if (FUTURE.test(lines[e.line - 1] ?? "") || e.cue === "deleted") continue;
          if (e.elsewhere || e.cue === "example" || e.cue === "negated") continue;
          // Written in prose, ../x is relative to the reader's working directory, such as a sibling worktree.
          if (e.via !== "link" && normalize(rel).startsWith("..")) continue;
          if (e.via === "code" && BUILD_OUTPUT.test(normalize(rel))) continue;
          if (e.via === "code" && !rel.includes("/")) {
            basenames ??= new Set(tracked().map((f) => f.split("/").pop()!));
            if (!basenames.has(rel)) continue;
          }
        }
        const ok = found || (e.via === "code" && !rel.includes("/")) || (e.via === "code" && packageRelative(tracked(), pkgDir === "." ? "." : pkgDir, rel));
        const id = `ins-${String(n++).padStart(3, "0")}`;
        items.push({ id, source: file, line: e.line, kind: "path", text: e.text, category: "path", staticResult: ok ? "pass" : "fail", staticReason: ok ? undefined : `${e.text} doesn't exist`, result: ok ? "pass" : "fail", reason: ok ? undefined : `${e.text} doesn't exist`, rule: "path-exists" });
        continue;
      }
      const id = `ins-${String(n++).padStart(3, "0")}`;
      const start = e.within ? (exists(join(tree, normalize(join(fileDir, e.within)))) ? normalize(join(fileDir, e.within)) : normalize(e.within)) : pkgDir;
      const base = { id, source: file, line: e.line, kind: "command" as const, text: e.text, cwd: start };
      const skipped = (reason: string, rule: string, staticResult: "pass" | "fail" = "pass", staticReason?: string) => items.push({ ...base, category: "skipped", staticResult, ...(staticReason ? { staticReason } : {}), result: "not_run", reason, rule });
      // A template or a third-party skill's command isn't checked against this repo at all; a real
      // command that asks questions or adds packages still is, statically, before it's skipped.
      if (thirdParty) {
        skipped(`not replayed: it comes from a vendored skill (${thirdParty}), so it documents that tool, not this repo`, "vendored");
        continue;
      }
      if (e.elsewhere) {
        skipped(`not checked: it's a step for ${e.elsewhere}, not this repo`, "elsewhere");
        continue;
      }
      if (e.cue && e.cue !== "deleted") {
        skipped(CUE_SKIP[e.cue].reason, CUE_SKIP[e.cue].rule);
        continue;
      }
      if (PLACEHOLDER.test(e.text)) {
        const s = skippedReason(e.text)!;
        skipped(s.reason, s.rule);
        continue;
      }
      const s = checkCommand(e.text, { ...ctx, via: e.via }, start);
      const key = `${start}\u0000${e.text}`;
      if (readme && earlier.has(key)) {
        skipped(`not checked again: ${earlier.get(key)} gives the same command`, "duplicate");
        continue;
      }
      if (!readme && !earlier.has(key)) earlier.set(key, `${file}:${e.line}`);
      const section = e.headings.length ? `"${e.headings[e.headings.length - 1]}"` : "its opening section";
      if (readme && !e.headings.some((h) => DEV_HEADING.test(h)) && !s.repo) {
        skipped(`not checked: it reads as usage for the package's users (README.md, under ${section}), not a step for working on this repo`, "consumer", "pass");
        continue;
      }
      if (s.skip) {
        skipped(s.skip, s.rule);
        continue;
      }
      if (s.access) {
        items.push({ ...base, category: "needs_access", staticResult: "pass", result: "not_run", reason: s.access, rule: s.rule });
        continue;
      }
      const skip = isRisky(e.text) ? null : (skippedReason(e.text) ?? (() => {
        const w = writesFiles(e.text, tree, fileDir, profile);
        return w ? { reason: w, rule: "rewrites" } : null;
      })());
      const category = skip ? "skipped" : categorize(e.text);
      let result: InstructionItem["result"];
      let reason: string | undefined;
      let rule = s.rule;
      if (s.result === "fail") {
        result = "fail";
        reason = s.reason;
      } else if (skip) {
        result = "not_run";
        reason = skip.reason;
        rule = skip.rule;
      } else if (category === "install") {
        result = "pass";
        reason = "install commands are checked statically; the clean replay runs the frozen install";
        rule = "install-static";
      } else if (category === "risky" || category === "long_running" || category === "needs_access") {
        result = "not_run";
        reason = category === "risky" ? "not replayed: it deploys, publishes, deletes or pipes the network into a shell" : category === "long_running" ? "not replayed: it starts a long-running process" : ELEVATED.test(e.text) ? "not replayed: it uses sudo" : "not replayed: it refers to a path on the author's machine";
        rule = category === "risky" ? "risky" : category === "long_running" ? "long-running" : ELEVATED.test(e.text) ? "sudo" : "machine-path";
      } else {
        result = "not_run";
        reason = "waiting for replay";
        rule = "replay";
      }
      items.push({ ...base, category, staticResult: s.result, staticReason: s.reason, result, reason, rule });
    }
  }
  return items;
}

function isText(path: string): boolean {
  try {
    const st = statSync(path);
    if (st.size > 1024 * 1024) return false;
  } catch {
    return false;
  }
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|mov|wasm|so|dylib|exe|jar)$/i.test(path);
}

// Tests, fixtures, docs, examples and generated code are full of dummy keys, so a hit there is
// listed for review instead of holding every component below Level 2.
const NOT_SHIPPED: { re: RegExp; where: string }[] = [
  { re: /(^|\/)(tests?|__tests__|specs?|e2e|evals?|fixtures?|__fixtures__|testdata|__mocks__|mocks?|(integration|unit|functional|acceptance|api|e2e)[-_]tests?|tests?[-_](utils?|helpers?|support|setup)|testing)\/|\.(test|spec)\.[\w]+$|_(test|spec)\.\w+$|(^|\/)test_[^/]+$|(^|\/)conftest\.py$/, where: "test" },
  { re: /(^|\/)(generated|__generated__|dist|build|coverage)\/|\.generated\.|\.min\.js$/, where: "generated" },
  { re: /(^|\/)(docs?|examples?|samples?)\/|\.(md|mdx|rst|adoc)$|(^|\/)\.env\.(example|sample|template)$|\.example$/, where: "docs or example" },
];

export function notShipped(file: string): string | null {
  return NOT_SHIPPED.find((n) => n.re.test(file))?.where ?? null;
}

export const SAFETY_RULES: Record<string, string> = {
  secret: "A key or token committed to shipped code blocks Level 2.",
  "secret-not-shipped": "A key or token in tests, fixtures, evals, docs, examples or generated code is listed for review and doesn't block.",
  "secret-example": "A value the vendor documents as an example, such as the access key in AWS's documentation, is listed for review and doesn't block.",
  "secret-no-key": "A private key header with no key after it, as in a comment or a placeholder, is listed for review and doesn't block.",
  "credential-needed": "Tests that read a production credential block Level 2, since agents can't run them without production access.",
  "credential-fixture": "A production credential read in a test fixture, which is test data for the repo's own tests, is listed for review and doesn't block.",
  "network-piped": "An install hook that pipes a download into a shell blocks Level 2; in another script it's listed for review.",
  "lifecycle-hook": "A script that runs on every install is listed for review.",
  destructive: "A script that deletes data is listed for review.",
  "deploy-publish": "A script that deploys or publishes is listed for review.",
  elevated: "A setup step or script that uses sudo is listed for review; the audit runs it only inside a container.",
  waived: INSTRUCTION_RULES.waived,
};

// Values vendors publish in their docs as examples; they appear in many repos and grant nothing.
// Built from parts so this file never holds a value the secret scan matches.
const DOCUMENTED_EXAMPLES = new RegExp(["AKIA" + "IOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCY" + "EXAMPLEKEY"].join("|"));

// A PEM header counts as a key only with a base64 body after it, before its END line.
function pemHasKey(lines: string[], index: number): boolean {
  const after = lines[index].split(/-----BEGIN [A-Z ]*PRIVATE KEY-----/)[1] ?? "";
  const body = [after, ...lines.slice(index + 1, index + 4)].join("\n").split(/-----END/)[0];
  return /[A-Za-z0-9+/]{40,}/.test(body.replace(/\\n/g, "\n"));
}

// An environment read written inside a string, such as test data for the scanner itself, reads nothing.
function insideString(line: string, index: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < index; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
  }
  return quote !== null;
}

// Past the scan's time bound, the secret scan stops and records how many files it read; the
// manifest and script checks after it are cheap and always run.
export function safetyScan(tree: string, profile: Profile, bound?: ScanBound): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  let n = 1;
  const add = (f: Omit<SafetyFinding, "id">) => findings.push({ id: `saf-${String(n++).padStart(3, "0")}`, ...f });
  const files = listFiles(tree, { includeHidden: true });
  if (bound) {
    bound.scope.files = files.length;
    bound.scope.fileCap = files.length >= MAX_FILES ? MAX_FILES : null;
    bound.scope.secrets = { scanned: 0, total: files.length };
  }
  for (const file of files) {
    if (bound && Date.now() > bound.until) break;
    if (bound) bound.scope.secrets.scanned++;
    if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|bun\.lock)$/.test(file)) continue;
    const full = join(tree, file);
    if (!isText(full)) continue;
    const text = readText(full);
    const where = notShipped(file);
    const lines = text.split("\n");
    for (const hit of scanText(text)) {
      const line = lines[hit.line - 1] ?? "";
      if (where) add({ kind: "secret", file, line: hit.line, detail: `${hit.type} in a ${where} file, listed for review`, blocking: false, rule: "secret-not-shipped" });
      else if (DOCUMENTED_EXAMPLES.test(line)) add({ kind: "secret", file, line: hit.line, detail: `${hit.type}: a documented example value, listed for review`, blocking: false, rule: "secret-example" });
      else if (hit.type === "Private key" && !pemHasKey(lines, hit.line - 1)) add({ kind: "secret", file, line: hit.line, detail: "a private key header with no key after it, listed for review", blocking: false, rule: "secret-no-key" });
      else add({ kind: "secret", file, line: hit.line, detail: hit.type, blocking: true, rule: "secret" });
    }
    if (where === "test") {
      const fixture = /(^|\/)(fixtures?|__fixtures__|testdata)\//.test(file);
      lines.forEach((l, i) => {
        const name = [...l.matchAll(ENV_READ)].filter((m) => !insideString(l, m.index!)).map((m) => m[1]).find(prodCredential);
        if (name) add({ kind: "credential_needed", file, line: i + 1, detail: fixture ? `a test fixture reads ${name}, listed for review` : `tests read ${name}`, blocking: !fixture, rule: fixture ? "credential-fixture" : "credential-needed" });
      });
    }
  }
  const env = profile.environmentJson;
  for (const [field, cmd] of [["install", env?.install], ["start", env?.start]] as const) {
    if (cmd && ELEVATED.test(cmd)) add({ kind: "elevated", file: env!.path, detail: `${field} runs sudo (\`${cmd}\`); the audit runs it only inside a container, never on the host`, blocking: false, rule: "elevated" });
  }
  for (const manifest of profile.manifests.filter((m) => m.endsWith("package.json"))) {
    const pkg = readPackageJson(join(tree, dirname(manifest)));
    for (const [name, cmd] of Object.entries(pkg?.scripts ?? {})) {
      const hook = /^(pre|post)?install$|^prepare$|^prepublish$/.test(name);
      if (ELEVATED.test(cmd)) add({ kind: "elevated", file: manifest, detail: `scripts.${name} runs sudo; the audit runs it only inside a container, never on the host`, blocking: false, rule: "elevated" });
      if (NETWORK_PIPED.test(cmd)) add({ kind: "network_piped", file: manifest, detail: `scripts.${name} pipes a download into a shell`, blocking: hook, rule: "network-piped" });
      else if (hook) add({ kind: "lifecycle_hook", file: manifest, detail: `scripts.${name} runs on every install`, blocking: false, rule: "lifecycle-hook" });
      if (DESTRUCTIVE.test(cmd)) add({ kind: "destructive", file: manifest, detail: `scripts.${name} deletes data`, blocking: false, rule: "destructive" });
      if (DEPLOY.test(cmd) || /^(deploy|publish|release)/.test(name)) add({ kind: "deploy_publish", file: manifest, detail: `scripts.${name} deploys or publishes`, blocking: false, rule: "deploy-publish" });
    }
  }
  for (const file of files.filter((f) => /(^|\/)Makefile$/.test(f) || /^(scripts|\.cursor)\/[^/]+\.sh$/.test(f))) {
    if (readText(join(tree, file)).split("\n").some((l) => !l.trim().startsWith("#") && ELEVATED.test(l))) add({ kind: "elevated", file, detail: "runs sudo; the audit runs it only inside a container, never on the host", blocking: false, rule: "elevated" });
  }
  for (const file of files.filter((f) => /(^|\/)Makefile$/.test(f) || /^scripts\/.+\.sh$/.test(f))) {
    const text = readText(join(tree, file));
    if (DESTRUCTIVE.test(text)) add({ kind: "destructive", file, detail: "contains a command that deletes data", blocking: false, rule: "destructive" });
    if (DEPLOY.test(text) || /deploy|prod/i.test(file)) add({ kind: "deploy_publish", file, detail: "deploys or reaches production", blocking: false, rule: "deploy-publish" });
  }
  return findings;
}
