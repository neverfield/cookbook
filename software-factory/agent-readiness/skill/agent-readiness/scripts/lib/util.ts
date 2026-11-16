import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A repo-controlled path, refused when it or a symlink along it leaves the tree. The repo's own
// files decide these paths, and tar and git keep symlinks, so the check follows links.
export function containedPath(root: string, parts: string[], what: string): string {
  const base = existsSync(root) ? realpathSync(root) : resolve(root);
  const lexical = resolve(base, ...parts);
  const real = existsSync(lexical) ? realpathSync(lexical) : lexical;
  const out = (p: string) => {
    const rel = relative(base, p);
    return rel.startsWith("..") || isAbsolute(rel);
  };
  if (parts.some((x) => isAbsolute(x)) || out(lexical) || out(real)) fail(`${what} points outside the repository (${join(...parts)}), which the audit refuses.`);
  return real;
}

// Emoji, flags and the variation selector that turns a symbol into one. Reports, narration and
// CLI output show status in words or SVG shapes instead.
export const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{20E3}]/u;

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function writeText(path: string, text: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, text);
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function exists(path: string): boolean {
  return existsSync(path);
}

// Whether a path the repo names exists under root, spelled exactly as it is. A Mac's default
// filesystem ignores case, so a plain exists() would pass `LinqShuffler.cs` for `LINQShuffler.cs`
// there and fail it on Linux; this checks each segment against its folder's listing, the same on
// every machine. A path that leaves root is checked as it is.
export function existsExact(root: string, rel: string): boolean {
  const n = normalize(rel);
  if (isAbsolute(n) || n === ".." || n.startsWith(`..${sep}`) || n.startsWith("../")) return existsSync(join(root, n));
  let dir = root;
  for (const seg of n.split(/[\\/]/).filter((x) => x && x !== ".")) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return false;
    }
    if (!names.includes(seg)) return false;
    dir = join(dir, seg);
  }
  return existsSync(dir);
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function nowIso(): string {
  const fixed = process.env.SA_READINESS_NOW;
  if (fixed) return new Date(fixed).toISOString();
  return new Date().toISOString();
}

export function today(): string {
  return nowIso().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate.length === 10 ? isoDate + "T00:00:00Z" : isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

export function fmtShortDate(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 100);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// Near V8's string limit, so a long `git log` on a large repo fails loudly instead of quietly
// returning nothing at 64 MB.
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

export function git(args: string[], cwd: string, timeoutMs?: number): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, ...(timeoutMs ? { timeout: Math.max(1, timeoutMs) } : {}) });
  const stderr = r.error && (r.error as NodeJS.ErrnoException).code === "ENOBUFS" ? `git ${args[0]} printed more than ${GIT_MAX_BUFFER / 1024 / 1024} MB` : (r.stderr ?? "");
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? "", stderr };
}

export function isShallow(repo: string): boolean {
  return git(["rev-parse", "--is-shallow-repository"], repo).stdout.trim() === "true";
}

// The last commit date of each file, from one `git log` walk instead of one process per file.
// Files the walk didn't reach within maxCommits (or the time bound) are left out.
export function lastChanged(repo: string, files: string[], opts: { commit?: string; under?: string; maxCommits?: number; timeoutMs?: number } = {}): Map<string, string> {
  const want = new Set(files);
  const out = new Map<string, string>();
  if (!want.size) return out;
  const args = ["log", opts.commit ?? "HEAD", "--no-renames", "--name-only", "--format=@@%cI", "-n", String(opts.maxCommits ?? 5000)];
  if (opts.under && opts.under !== ".") args.push("--", opts.under);
  const r = git(args, repo, opts.timeoutMs);
  let date = "";
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("@@")) date = line.slice(2);
    else if (line && want.has(line) && !out.has(line)) {
      out.set(line, date);
      if (out.size === want.size) break;
    }
  }
  return out;
}

const GLOB_CHARS = /[*?{[]/;

const escapeRe = (s: string) => s.replace(/[.+^$()|[\]\\{}]/g, "\\$&");

function segmentRegex(seg: string): string {
  let s = "";
  for (let j = 0; j < seg.length; j++) {
    const ch = seg[j];
    const end = ch === "{" ? seg.indexOf("}", j) : -1;
    if (ch === "*") s += "[^/]*";
    else if (ch === "?") s += "[^/]";
    else if (end > j) {
      s += `(?:${seg.slice(j + 1, end).split(",").map(segmentRegex).join("|")})`;
      j = end;
    } else s += escapeRe(ch);
  }
  return s;
}

// `**` is zero or more folders, so `packages/**` also matches `packages` and `**/app` matches `app`.
function globRegex(pattern: string): RegExp {
  const segs = pattern.split("/");
  if (segs.length === 1 && segs[0] === "**") return /^.*$/;
  let re = "";
  segs.forEach((seg, i) => {
    if (seg === "**") re += i === 0 ? "(?:[^/]+/)*" : "(?:/[^/]+)*";
    else re += (i === 0 || (i === 1 && segs[0] === "**") ? "" : "/") + segmentRegex(seg);
  });
  return new RegExp(`^${re}$`);
}

// Workspace folders an npm, Yarn or pnpm `workspaces` list names: `*`, `**` at any depth, `?`,
// `{a,b}`, and `!` exclusions, which apply whatever their position in the list. `accept` filters
// the folders a glob reaches, such as to those with a package.json.
export function workspaceDirs(tree: string, patterns: string[], accept: (dir: string) => boolean = () => true): string[] {
  const clean = (p: string) => p.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  const include = patterns.filter((p) => !p.trim().startsWith("!")).map(clean).filter(Boolean);
  const exclude = patterns.filter((p) => p.trim().startsWith("!")).map((p) => globRegex(clean(p.trim().slice(1))));
  const found = new Set<string>();
  const dirs: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 12) return;
    let names: string[];
    try {
      names = readdirSync(rel ? join(tree, rel) : tree).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const child = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(join(tree, child));
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      dirs.push(child);
      walk(child, depth + 1);
    }
  };
  let walked = false;
  for (const p of include) {
    if (!GLOB_CHARS.test(p)) {
      if (existsSync(join(tree, p)) && statSync(join(tree, p)).isDirectory()) found.add(p);
      continue;
    }
    if (!walked) {
      walk("", 0);
      walked = true;
    }
    const re = globRegex(p);
    for (const d of dirs) if (re.test(d)) found.add(d);
  }
  return [...found].filter((d) => !exclude.some((re) => re.test(d)) && accept(d)).sort();
}

export function gitOrThrow(args: string[], cwd: string): string {
  const r = git(args, cwd);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".agent-readiness", ".venv", "venv", "__pycache__", "dist", "build", "coverage"]);

export const MAX_FILES = 50000;

export function listFiles(root: string, opts: { includeHidden?: boolean; maxFiles?: number } = {}): string[] {
  return listFilesScoped(root, opts).files;
}

// Folder by folder, shallowest first, so a file cap drops the deepest files of every top-level folder
// rather than whole folders that sort late, such as fs/, kernel/ and mm/ after drivers/. The files
// come back in a depth-first walk's order. `cut` names the top-level folders the cap left partly unlisted.
export function listFilesScoped(root: string, opts: { includeHidden?: boolean; maxFiles?: number } = {}): { files: string[]; cut: string[] } {
  const out: string[] = [];
  const max = opts.maxFiles ?? MAX_FILES;
  const cut = new Set<string>();
  const top = (rel: string) => rel.split(sep)[0];
  const queue: string[] = [""];
  for (let q = 0; q < queue.length; q++) {
    const rel = queue[q];
    let entries: string[];
    try {
      entries = readdirSync(rel ? join(root, rel) : root).sort();
    } catch {
      continue;
    }
    for (let i = 0; i < entries.length; i++) {
      const name = entries[i];
      if (SKIP_DIRS.has(name)) continue;
      const child = rel ? join(rel, name) : name;
      let st;
      if (out.length >= max) {
        if (rel) cut.add(top(child));
        else if ((st = statOrNull(join(root, child)))?.isDirectory()) cut.add(child);
        continue;
      }
      st = statOrNull(join(root, child));
      if (!st) continue;
      if (st.isDirectory()) queue.push(child);
      else if (st.isFile()) out.push(child);
    }
  }
  const files = out.map((f) => f.split(sep).join("/"));
  const segs = new Map(files.map((f) => [f, f.split("/")]));
  files.sort((a, b) => {
    const x = segs.get(a)!;
    const y = segs.get(b)!;
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return x.length - y.length;
  });
  return { files: files.map((f) => f.split("/").join(sep)), cut: [...cut].sort() };
}

function statOrNull(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

// A repo-wide step names "the repo" in prose, and its commands take no --component.
export function fill(template: string, vars: Record<string, string | number>): string {
  const out = template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
  return vars.component === "the repo" ? out.replace(/ --component the repo\b/g, "") : out;
}

export function fail(message: string, code = 1): never {
  const err = new Error(message) as Error & { exitCode: number };
  err.exitCode = code;
  throw err;
}

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// The file's path with every symlink resolved, relative to the tree, or null when it leaves the tree.
export function inTreePath(tree: string, file: string): string | null {
  try {
    const rel = relative(realpathSync(tree), realpathSync(join(tree, file)));
    return rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(sep).join("/");
  } catch {
    return null;
  }
}
