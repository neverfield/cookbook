import { execFileSync, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { showFromBranch } from "./history.ts";
import { latestRubricVersion, loadRubric, rubricDigest } from "./rubric.ts";
import type { Audit, ScenarioSpec, Tier } from "./types.ts";
import { SKILL_ROOT, ensureDir, exists, fail, git, gitOrThrow, isShallow, nowIso, randomHex, readJson, readText, sha256, stableStringify, today, writeJson, writeText } from "./util.ts";

export interface Paths {
  repo: string;
  records: string;
  work: string;
  history: string;
  latest: string;
  roadmap: string;
  feedback: string;
}

export function resolveRepo(start: string): string {
  const r = git(["rev-parse", "--show-toplevel"], resolve(start));
  if (!r.ok) fail(`Not a git repository: ${start}`);
  return r.stdout.trim();
}

export function paths(repo: string): Paths {
  const records = join(repo, ".agent-readiness");
  const history = process.env.SA_READINESS_HISTORY_DIR ? resolve(process.env.SA_READINESS_HISTORY_DIR) : join(records, "history");
  return {
    repo,
    records,
    work: join(records, "work"),
    history,
    latest: join(records, "latest"),
    roadmap: join(records, "roadmap.json"),
    feedback: join(records, "feedback"),
  };
}

function skillFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  for (const sub of ["scripts", "rubric", "schema", "templates"]) walk(join(SKILL_ROOT, sub));
  // It sets the scripts' module type, so it decides whether they run at all.
  out.push(join(SKILL_ROOT, "package.json"));
  return out;
}

export function skillDigest(): string {
  const parts = skillFiles().map((f) => `${relative(SKILL_ROOT, f)}\n${sha256(readText(f))}`);
  return sha256(parts.join("\n"));
}

export interface ReleaseManifest {
  version: string;
  tag: string;
  scriptsDigest: string;
}

export function releaseManifest(): ReleaseManifest | null {
  const p = join(SKILL_ROOT, "RELEASE.json");
  return exists(p) ? readJson<ReleaseManifest>(p) : null;
}

export interface LocalInfo {
  tree: string;
  createdAt: string;
}

export interface InitOptions {
  repo: string;
  scenarios: ScenarioSpec[];
  tier: Tier;
  registryEnv: string[];
  inheritEnv: boolean;
  force: boolean;
}

function repoName(repo: string): string {
  const remote = git(["config", "--get", "remote.origin.url"], repo);
  if (remote.ok && remote.stdout.trim()) {
    const m = remote.stdout.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (m) return m[1];
  }
  return basename(repo);
}

// The audit's own records and an uncommitted copy of this skill, wherever in the repo it was
// copied, don't make the tree dirty.
export function isDirty(repo: string): boolean {
  const r = git(["status", "--porcelain", "--untracked-files=all"], repo);
  const own = relative(realpathSync(repo), realpathSync(SKILL_ROOT)).split(sep).join("/");
  const installed = own && !own.startsWith("..") && !isAbsolute(own) ? `${own}/` : null;
  return r.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.slice(3).replace(/^"/, ""))
    .some((f) => !/^(\.agent-readiness\/|\.cursor\/skills\/agent-readiness\/)/.test(f) && !(installed && (f.startsWith(installed) || installed.startsWith(f))));
}

export interface TreeInfo {
  // The tree is a one-commit clone with its own .git, as a CI checkout is; false when it fell back to git archive.
  git: boolean;
  // Submodules the host checkout didn't have at the recorded commit, so the tree lacks them.
  submodulesMissing: string[];
  // Git LFS files still holding pointers, because git-lfs or the objects weren't on this machine.
  lfsPointers: string[];
}

const LFS_POINTER = "version https://git-lfs.github.com/spec/v1";

// The repo's and the user's git settings never run code here: no hooks, no fsmonitor, no LFS
// download, and nothing inherited from a calling git process.
function treeGit(args: string[], cwd: string, hooks: string): { ok: boolean; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) delete env[k];
  const r = spawnSync("git", ["-c", `core.hooksPath=${hooks}`, "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "advice.detachedHead=false", ...args], { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function cloneCommit(repo: string, commit: string, dest: string, hooks: string): boolean {
  if (!treeGit(["init", "-q", dest], repo, hooks).ok) return false;
  if (treeGit(["fetch", "-q", "--depth", "1", "--no-tags", repo, commit], dest, hooks).ok && treeGit(["checkout", "-q", "-f", "--detach", commit], dest, hooks).ok) return true;
  rmSync(dest, { recursive: true, force: true });
  ensureDir(dest);
  return false;
}

// Streamed through a file on disk, so a large repo never sits in memory.
function archiveCommit(repo: string, commit: string, dest: string): void {
  const dir = mkdtempSync(join(tmpdir(), "readiness-archive-"));
  try {
    const tar = join(dir, "tree.tar");
    execFileSync("git", ["archive", "--format=tar", "-o", tar, commit], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    execFileSync("tar", ["-x", "-f", tar, "-C", dest], { stdio: ["ignore", "ignore", "pipe"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gitlinks(repo: string, commit: string): { path: string; sha: string }[] {
  const r = git(["ls-tree", "-r", "-z", "--full-tree", commit], repo);
  return r.stdout
    .split("\0")
    .map((e) => e.match(/^160000 commit ([0-9a-f]{40})\t(.+)$/s))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ sha: m[1], path: m[2] }));
}

// A submodule comes from the host's own checkout of it, never from its remote.
function copySubmodules(repo: string, commit: string, dest: string, info: TreeInfo, prefix: string): void {
  for (const { path, sha } of gitlinks(repo, commit)) {
    const src = join(repo, path);
    const top = exists(src) ? git(["rev-parse", "--show-toplevel"], src).stdout.trim() : "";
    const own = top && exists(top) && realpathSync(top) === realpathSync(src);
    if (!own || !git(["cat-file", "-e", `${sha}^{commit}`], src).ok) {
      info.submodulesMissing.push(prefix + path);
      continue;
    }
    const target = join(dest, path);
    rmSync(target, { recursive: true, force: true });
    const sub = exportTree(src, sha, target);
    info.submodulesMissing.push(...sub.submodulesMissing.map((s) => `${prefix}${path}/${s}`));
    info.lfsPointers.push(...sub.lfsPointers.map((s) => `${prefix}${path}/${s}`));
  }
}

// LFS content from the host's own LFS store; files whose objects aren't there stay pointers.
function fillLfs(repo: string, dest: string, hooks: string, info: TreeInfo): void {
  const tracked = treeGit(["ls-files", "-z", ":(attr:filter=lfs)"], dest, hooks).stdout.split("\0").filter(Boolean);
  const pointers = () => tracked.filter((f) => {
    try {
      return readText(join(dest, f)).startsWith(LFS_POINTER);
    } catch {
      return false;
    }
  });
  if (!pointers().length) return;
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo).stdout.trim();
  if (common && treeGit(["lfs", "version"], dest, hooks).ok) treeGit(["-c", `lfs.storage=${join(common, "lfs")}`, "lfs", "checkout"], dest, hooks);
  info.lfsPointers.push(...pointers());
}

// The commit comes from the draft, so it must be a full object id and never reaches a shell.
// The tree is a clean checkout of that one commit with its .git, submodules and LFS files, as CI
// would check it out, so tools and tests that read git see a repository.
export function exportTree(repo: string, commit: string, dest: string): TreeInfo {
  if (!/^[0-9a-f]{40}$/.test(commit)) fail(`Not a commit id: ${commit}`);
  ensureDir(dest);
  const hooks = mkdtempSync(join(tmpdir(), "readiness-nohooks-"));
  try {
    const info: TreeInfo = { git: cloneCommit(repo, commit, dest, hooks), submodulesMissing: [], lfsPointers: [] };
    if (!info.git) archiveCommit(repo, commit, dest);
    copySubmodules(repo, commit, dest, info, "");
    if (info.git) fillLfs(repo, dest, hooks, info);
    return info;
  } finally {
    rmSync(hooks, { recursive: true, force: true });
  }
}

// The audit tree's path is printed and anything can write to it, so every step that reads or
// runs the repo starts again from the recorded commit.
export function refreshTree(repo: string, commit: string, dest: string): string {
  rmSync(dest, { recursive: true, force: true });
  exportTree(repo, commit, dest);
  return dest;
}

// Files as the audited commit has them, so a citation can't point at something written later.
export function commitReader(repo: string, commit: string): (path: string) => string | null {
  return (path) => {
    const r = git(["show", `${commit}:${path.replace(/^\.\//, "")}`], repo);
    return r.ok ? r.stdout : null;
  };
}

export function scratchTree(repo: string, commit: string): { dir: string; dispose: () => void } {
  const parent = mkdtempSync(join(tmpdir(), "readiness-scratch-"));
  const dir = join(parent, "tree");
  exportTree(repo, commit, dir);
  return { dir, dispose: () => rmSync(parent, { recursive: true, force: true }) };
}

export function writeRecordsIgnore(p: Paths): void {
  const ignore = join(p.records, ".gitignore");
  if (!exists(ignore)) writeText(ignore, "work/\nhistory/\nfeedback/\ncli.log\n");
}

function priorAudits(p: Paths): number {
  const local = join(p.history, "history.jsonl");
  const text = exists(local) ? readText(local) : (showFromBranch(p.repo, "history.jsonl") ?? "");
  return text.split("\n").filter((l) => l.includes('"kind":"audit"')).length;
}

export function initAudit(opts: InitOptions): { audit: Audit; local: LocalInfo; paths: Paths } {
  const p = paths(opts.repo);
  const current = currentDraftId(p);
  if (current && !opts.force) fail(`A draft audit is already open: ${current}. Seal it, or pass --force to abandon it.`);
  const commit = gitOrThrow(["rev-parse", "HEAD"], opts.repo).trim();
  const seedEnv = process.env.SA_READINESS_EVAL_SEED;
  const id = `aud-${today()}-${commit.slice(0, 7)}-${seedEnv ? sha256(`${seedEnv}:${commit}:${nowIso()}`).slice(0, 4) : randomHex(2)}`;
  const tree = join(mkdtempSync(join(tmpdir(), `readiness-${id}-`)), "tree");
  const info = exportTree(opts.repo, commit, tree);
  const rubric = latestRubricVersion();
  const seed = seedFromCode(rubric) ? codeSeed(opts.repo, commit, seedEnv) : seedEnv ? sha256(`${seedEnv}:${priorAudits(p)}`).slice(0, 32) : randomHex(16);
  writeText(join(dirname(tree), "seed.txt"), seed + "\n");
  const manifest = releaseManifest();
  const audit: Audit = {
    schema: "agent-readiness/audit@1",
    id,
    kind: "audit",
    createdAt: nowIso(),
    state: "draft",
    repo: {
      name: repoName(opts.repo),
      commit,
      dirtyTree: isDirty(opts.repo),
      ...(isShallow(opts.repo) ? { shallow: true } : {}),
      ...(info.submodulesMissing.length ? { submodulesMissing: info.submodulesMissing } : {}),
      ...(info.lfsPointers.length ? { lfsPointers: info.lfsPointers.length } : {}),
    },
    scenarios: opts.scenarios,
    tier: opts.tier,
    rubric,
    skill: { version: manifest?.version ?? "0.0.0", scriptsDigest: skillDigest(), rubricDigest: rubricDigest(rubric), release: manifest?.tag ?? null },
    // The draft holds only a digest of the seed, so nothing in the repo lets anyone work out where
    // faults will be planted; the seal records the seed itself.
    seed: { value: seedDigest(seed), pinned: Boolean(seedEnv) },
    environment: { containerRuntime: null, image: null, registryEnv: opts.registryEnv, inheritEnv: opts.inheritEnv },
    profile: null,
    assets: [],
    contract: [],
    instructions: [],
    safety: [],
    evidence: [],
    mutants: [],
    outcomes: null,
    narration: null,
  };
  const local: LocalInfo = { tree, createdAt: audit.createdAt };
  writeRecordsIgnore(p);
  writeJson(join(p.work, id, "local.json"), local);
  saveDraft(p, audit);
  writeText(join(p.work, "CURRENT"), id + "\n");
  return { audit, local, paths: p };
}

// Rubrics up to 2026-11-alpha promise fresh faults each audit; a rubric that sets
// mutation.seedFrom to "code" keeps the faults, and so the level, fixed until the code changes.
function seedFromCode(rubricVersion: string): boolean {
  return (loadRubric(rubricVersion).mutation as { seedFrom?: string }).seedFrom === "code";
}

// Keyed by the eval pin or the seal key when there is one, so only the commit's code moves it.
// Without either it is a digest of the code alone: stable, but anyone with the code can work it out.
export function codeSeed(repo: string, commit: string, seedEnv?: string): string {
  const tree = gitOrThrow(["rev-parse", `${commit}^{tree}`], repo).trim();
  const key = seedEnv ?? process.env.SA_READINESS_SEAL_KEY ?? "";
  return createHmac("sha256", `readiness-seed:${key}`).update(tree).digest("hex").slice(0, 32);
}

// A component's own seed, which changes only when files under its folder change, tests included.
export function componentSeed(seed: string, repo: string, commit: string, path: string): string {
  const r = git(["rev-parse", path === "." ? `${commit}^{tree}` : `${commit}:${path}`], repo);
  return sha256(`${seed}:${r.ok ? r.stdout.trim() : path}`).slice(0, 32);
}

export function seedDigest(seed: string): string {
  return sha256(`readiness-seed:${seed}`).slice(0, 32);
}

// The seed planted faults are chosen from, kept next to the audit tree outside the repository.
export function realSeed(audit: Audit, local: LocalInfo): string {
  const f = join(dirname(local.tree), "seed.txt");
  const seed = exists(f) ? readText(f).trim() : "";
  return seed && seedDigest(seed) === audit.seed.value ? seed : audit.seed.value;
}

// Every write the scripts make to the draft leaves its digest outside the repository, keyed when
// SA_READINESS_SEAL_KEY is set, so an edit to audit.json by hand is caught at the next step.
function draftDigest(audit: Audit): string {
  const text = stableStringify(audit);
  const key = process.env.SA_READINESS_SEAL_KEY;
  return key ? `keyed:${createHmac("sha256", key).update(text).digest("hex")}` : `plain:${sha256(text)}`;
}

function checkDraft(p: Paths, id: string, audit: Audit): void {
  const f = digestFile(p, id);
  if (!f || !exists(dirname(f))) return;
  if (!exists(f)) fail(`${id}'s draft digest is missing, so edits to audit.json can't be ruled out. Start again with \`readiness init --force\`.`);
  const stored = readText(f).trim();
  const now = draftDigest(audit);
  if (stored === now) return;
  if (stored.split(":")[0] !== now.split(":")[0]) fail(`SA_READINESS_SEAL_KEY was ${stored.startsWith("keyed:") ? "set" : "unset"} when ${id} started and is ${now.startsWith("keyed:") ? "set" : "unset"} now. Run every step of an audit with the same setting, or start again with \`readiness init --force\`.`);
  fail(`${id}'s audit.json was edited outside the scripts. Start again with \`readiness init --force\`.`);
}

function digestFile(p: Paths, id: string): string | null {
  const f = join(p.work, id, "local.json");
  return exists(f) ? join(dirname(readJson<LocalInfo>(f).tree), "draft.digest") : null;
}

export function currentDraftId(p: Paths): string | null {
  const f = join(p.work, "CURRENT");
  if (!exists(f)) return null;
  const id = readText(f).trim();
  return id && exists(join(p.work, id, "audit.json")) ? id : null;
}

export function loadDraft(repo: string, id?: string): { audit: Audit; local: LocalInfo; paths: Paths } {
  const p = paths(repo);
  const draftId = id ?? currentDraftId(p);
  if (!draftId) fail("No draft audit is open. Run `readiness init` first.");
  const audit = readJson<Audit>(join(p.work, draftId, "audit.json"));
  const local = readJson<LocalInfo>(join(p.work, draftId, "local.json"));
  checkDraft(p, draftId, audit);
  return { audit, local, paths: p };
}

export function assertDraft(audit: Audit): void {
  if (audit.state !== "draft") fail(`Audit ${audit.id} is sealed and refuses further writes.`);
}

export function saveDraft(p: Paths, audit: Audit): void {
  assertDraft(audit);
  writeJson(join(p.work, audit.id, "audit.json"), audit);
  const f = digestFile(p, audit.id);
  if (f && exists(dirname(f))) writeText(f, draftDigest(audit) + "\n");
}

export function clearCurrent(p: Paths): void {
  writeText(join(p.work, "CURRENT"), "");
}
