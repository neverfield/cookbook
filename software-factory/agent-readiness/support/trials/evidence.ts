import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

// Evidence replay for the trials. A base-branch run records every call the audit makes to its
// container runtime (each command's raw result, the session's state after it and when it ran) and
// the report.json the audit sealed. A pull request whose executor files and trial inputs match the
// base's replays those calls through its own scoring, levels and report code, and its report.json
// is compared whole with the base's. Any call the recording doesn't have, or a recorded call the
// replay never makes, abandons the replay and the trial runs live.
//
// This lives only in the trial runner. The shipped CLI has no flag, variable or path that reads a
// recording, so recorded evidence can never become a sealed audit outside a trial.

export const STORE_VERSION = 1;

// The base branches whose push runs may write the store. A pull request's run never does.
export const BASE_REFS = ["refs/heads/cursor/agent-readiness-0.2", "refs/heads/main"];

// What runs the repo's commands, and the machinery of the replay itself. When any of these differs
// from the recording's, the trial runs live: a replay can't see an executor or container change.
// Repo-relative; a folder covers everything under it.
export const EXECUTOR_PATHS = [
  ".github/workflows/agent-readiness.yml",
  "software-factory/agent-readiness/.nvmrc",
  "software-factory/agent-readiness/skill/agent-readiness/scripts/lib/container.ts",
  "software-factory/agent-readiness/skill/agent-readiness/scripts/lib/run.ts",
  "software-factory/agent-readiness/skill/agent-readiness/scripts/lib/images.ts",
  "software-factory/agent-readiness/skill/agent-readiness/scripts/lib/proofenv.ts",
  "software-factory/agent-readiness/skill/agent-readiness/scripts/lib/teardown.ts",
  "software-factory/agent-readiness/skill/agent-readiness/scripts/lib/cleanup.ts",
  "software-factory/agent-readiness/support/tools/fixture.ts",
  "software-factory/agent-readiness/support/trials/evidence.ts",
  "software-factory/agent-readiness/support/trials/evidence-hook.ts",
  "software-factory/agent-readiness/support/trials/trials.test.ts",
];

export const HOOK_MODE_ENV = "SA_TRIALS_EVIDENCE_HOOK";
export const HOOK_CALLS_ENV = "SA_TRIALS_EVIDENCE_CALLS";
export const HOOK_MISS_ENV = "SA_TRIALS_EVIDENCE_MISS";
export const HOOK_SCRIPTS_ENV = "SA_TRIALS_EVIDENCE_SCRIPTS";
// Exit code of an audit whose replay met a call the recording doesn't have.
export const MISS_EXIT = 97;
export const HOOK = new URL("./evidence-hook.ts", import.meta.url).pathname;

export interface RecordedCall {
  key: string;
  result: unknown;
  // The container session's fields after the call, which the replay sets back.
  state?: Record<string, unknown>;
  // Milliseconds from the audit's start, so the replay's clock reads as the recording's did.
  start: number;
  end: number;
  // An exec's time limit, which a recorded timeout holds only under.
  timeoutSec?: number;
}

export interface Provenance {
  event: string;
  ref: string;
  sha: string;
  runId: string | null;
  // Recorded outside GitHub Actions: usable for a local replay only, never in CI.
  local: boolean;
}

export interface TrialEvidence {
  version: number;
  trial: string;
  // The network key the live run was compared under ("any", "open", "restricted").
  key: string;
  inputs: string;
  executor: string;
  plan: string;
  calls: RecordedCall[];
  report: unknown;
  // Whether replaying these calls with the recording's own code gave back its report.json exactly.
  replayable: boolean;
  why?: string;
  provenance: Provenance;
}

export interface Manifest {
  version: number;
  provenance: Provenance;
  files: Record<string, string>;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

// One digest over the executor files' paths and contents. A missing file counts as missing, so
// deleting one changes the digest too.
export function executorDigest(repoRoot: string, paths: string[] = EXECUTOR_PATHS): string {
  const h = createHash("sha256");
  for (const rel of paths) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) {
      h.update(`${rel}\0missing\0`);
      continue;
    }
    const files: string[] = [];
    if (statSync(abs).isDirectory()) walk(abs, files);
    else files.push(abs);
    for (const f of files) h.update(`${relative(repoRoot, f)}\0${sha256(readFileSync(f))}\0`);
  }
  return h.digest("hex");
}

// The calls an audit made, in order: equal digests mean the same commands with the same inputs.
export function planDigest(keys: string[]): string {
  return sha256(keys.join("\n"));
}

// Which of a diff's paths force a live run.
export function executorChanges(changed: string[], paths: string[] = EXECUTOR_PATHS): string[] {
  return changed.filter((f) => paths.some((p) => f === p || f.startsWith(`${p}/`)));
}

type Env = Record<string, string | undefined>;

export type EvidenceMode = { mode: "live"; why: string } | { mode: "record"; provenance: Provenance } | { mode: "replay"; why: string };

// SA_TRIALS_EVIDENCE=record writes the store, =replay reads it; unset, every trial runs live.
// Recording in GitHub Actions is only for a push to a base branch, and replaying only for a pull
// request: a scheduled (nightly) run, a dispatched one (the final head) and a base push stay live.
export function evidenceMode(env: Env, sha: string): EvidenceMode {
  const asked = env.SA_TRIALS_EVIDENCE ?? "";
  if (!asked) return { mode: "live", why: "SA_TRIALS_EVIDENCE is unset" };
  if (asked !== "record" && asked !== "replay") throw new Error(`SA_TRIALS_EVIDENCE takes record or replay; got ${asked}`);
  const actions = env.GITHUB_ACTIONS === "true";
  const event = actions ? (env.GITHUB_EVENT_NAME ?? "") : "local";
  const ref = actions ? (env.GITHUB_REF ?? "") : "";
  if (asked === "record") {
    if (actions && !(event === "push" && BASE_REFS.includes(ref))) throw new Error(`only a push to a base branch (${BASE_REFS.join(", ")}) records trial evidence; this is a ${event} run on ${ref || "no ref"}`);
    return { mode: "record", provenance: { event, ref, sha, runId: actions ? (env.GITHUB_RUN_ID ?? null) : null, local: !actions } };
  }
  if (actions && event !== "pull_request") return { mode: "live", why: `a ${event} run stays live; only pull requests replay` };
  return { mode: "replay", why: actions ? "pull request" : "local replay, which counts for nothing in CI" };
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function real(p: string): string {
  return existsSync(p) ? realpathSync(p) : resolve(p);
}

export function evidenceFile(dir: string, trial: string): string {
  return join(dir, `${trial}.json.gz`);
}

export function writeEvidence(dir: string, ev: TrialEvidence): string {
  mkdirSync(dir, { recursive: true });
  const file = evidenceFile(dir, ev.trial);
  writeFileSync(file, gzipSync(JSON.stringify(ev)));
  return file;
}

// Each recording shard writes its own manifest of the files it wrote, with their digests.
export function writeManifest(dir: string, label: string, provenance: Provenance): string {
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json.gz")).sort()) {
    const ev = readEvidenceFile(join(dir, name));
    if (ev.provenance.sha === provenance.sha && ev.provenance.runId === provenance.runId) files[name] = sha256(readFileSync(join(dir, name)));
  }
  const file = join(dir, `manifest-${label}.json`);
  writeFileSync(file, JSON.stringify({ version: STORE_VERSION, provenance, files } satisfies Manifest, null, 2) + "\n");
  return file;
}

function readEvidenceFile(file: string): TrialEvidence {
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as TrialEvidence;
}

export interface Store {
  dir: string;
  provenance: Provenance;
  trials: Map<string, TrialEvidence>;
}

// The store a replay may read, or why none. Refused: a folder inside the repo being tested, so a pull
// request can't ship its own; a manifest from anything but a base-branch push in CI; a file whose
// digest differs from its manifest's or whose provenance differs from it; and, in CI, a local one.
export function loadStore(dir: string, repoRoot: string, env: Env): Store | { refused: string } {
  if (!dir) return { refused: "no store: SA_TRIALS_EVIDENCE_DIR is unset" };
  if (inside(real(dir), real(repoRoot))) return { refused: `the store ${dir} is inside the repository under test, where a pull request could supply its own evidence` };
  if (!existsSync(dir)) return { refused: `no store at ${dir}` };
  const manifests = readdirSync(dir).filter((n) => /^manifest-.+\.json$/.test(n)).sort();
  if (!manifests.length) return { refused: `no manifest in ${dir}` };
  const actions = env.GITHUB_ACTIONS === "true";
  const trials = new Map<string, TrialEvidence>();
  let provenance: Provenance | null = null;
  for (const name of manifests) {
    const m = JSON.parse(readFileSync(join(dir, name), "utf8")) as Manifest;
    if (m.version !== STORE_VERSION) return { refused: `${name} is store version ${m.version}, not ${STORE_VERSION}` };
    const p = m.provenance;
    if (actions && (p.local || p.event !== "push" || !BASE_REFS.includes(p.ref))) return { refused: `${name} wasn't written by a push to a base branch (${p.local ? "local" : `${p.event} on ${p.ref}`})` };
    if (provenance && (provenance.sha !== p.sha || provenance.runId !== p.runId)) return { refused: `${name} comes from another run (${p.sha.slice(0, 7)}, run ${p.runId}) than the other manifests` };
    provenance = p;
    for (const [file, digest] of Object.entries(m.files)) {
      const abs = join(dir, file);
      if (file.includes("/") || !existsSync(abs)) return { refused: `${name} lists ${file}, which isn't in the store` };
      if (sha256(readFileSync(abs)) !== digest) return { refused: `${file} doesn't match its digest in ${name}` };
      const ev = readEvidenceFile(abs);
      if (ev.version !== STORE_VERSION || ev.provenance.sha !== p.sha || ev.provenance.runId !== p.runId || evidenceFile(dir, ev.trial) !== abs) return { refused: `${file} doesn't belong to the run its manifest names` };
      trials.set(ev.trial, ev);
    }
  }
  return { dir, provenance: provenance!, trials };
}

// Why a trial's recording can't be replayed here, or null when it can.
export function notReplayable(ev: TrialEvidence | undefined, inputs: string, executor: string): string | null {
  if (!ev) return "no recording for this trial in the store";
  if (!ev.replayable) return `its recording didn't replay faithfully on the base (${ev.why ?? "no reason recorded"})`;
  if (ev.inputs !== inputs) return "the trial's pinned inputs (commit, runtime, tier, budgets, date or seed) changed";
  if (ev.executor !== executor) return `an executor or replay file changed (${EXECUTOR_PATHS.length} paths, listed in support/trials/evidence.ts)`;
  return null;
}

// Every path at which two JSON values differ, as `a.b[2].c`.
export function diffJson(a: unknown, b: unknown, path = ""): string[] {
  if (a === b) return [];
  const at = path || "(root)";
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return [at];
  if (Array.isArray(a) !== Array.isArray(b)) return [at];
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    const out: string[] = [];
    for (let i = 0; i < Math.max(a.length, bb.length); i++) out.push(...(i < a.length && i < bb.length ? diffJson(a[i], bb[i], `${path}[${i}]`) : [`${path}[${i}]`]));
    return out;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort()) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in ao) || !(k in bo)) out.push(p);
    else out.push(...diffJson(ao[k], bo[k], p));
  }
  return out;
}

// The report changes a pull request declares in its description, one per line:
// `Report change: <trial id or *> <path>`, where the path covers everything under it.
export function declaredChanges(body: string): { trial: string; path: string }[] {
  return body
    .split(/\r?\n/)
    .map((l) => /^\s*(?:[-*]\s+)?Report change:\s+(\S+)\s+(\S+)\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ trial: m[1], path: m[2] }));
}

export function undeclared(trial: string, diff: string[], declared: { trial: string; path: string }[]): string[] {
  const mine = declared.filter((d) => d.trial === trial || d.trial === "*").map((d) => d.path);
  return diff.filter((p) => !mine.some((d) => p === d || p.startsWith(`${d}.`) || p.startsWith(`${d}[`)));
}
