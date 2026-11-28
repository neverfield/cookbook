import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { TestContext } from "node:test";
import { afterAudit, observe as observeTruth } from "../holdout/observe.ts";
import { CRITICAL, scoreRepo } from "../holdout/score.ts";
import type { RepoScore, Truth } from "../holdout/score.ts";
import { guards } from "../tools/known-failures.ts";
import { detectRuntime } from "../../skill/agent-readiness/scripts/lib/container.ts";
import { headlineCauseErrors } from "../evals/lib/part1.ts";
import type { ReportJson } from "../../skill/agent-readiness/scripts/lib/types.ts";
import { readiness, SKILL, SUPPORT } from "../tools/fixture.ts";
import { HOOK, HOOK_CALLS_ENV, HOOK_MISS_ENV, HOOK_MODE_ENV, HOOK_SCRIPTS_ENV, declaredChanges, diffJson, evidenceMode, executorDigest, loadStore, notReplayable, planDigest, sha256, undeclared, writeEvidence, writeManifest } from "./evidence.ts";
import type { RecordedCall, Store, TrialEvidence } from "./evidence.ts";
import { acquireHost } from "./host-lock.ts";
import { minutesOf, parseShard, shards } from "./shards.ts";

// Real public repos pinned at fixed commits. Each run's observed summary must match the one recorded
// for it, and its false instruction findings may never rise above the recorded ceiling. A change on
// purpose is re-recorded with SA_TRIALS_RECORD=1 and explained in the PR. Each trial also has truth
// written from the repo and its CI (truth/<id>.json, in the holdout's schema), scored by the holdout's
// scorer on every run: one guard per critical event and per rate a container run measures. A guard the
// tool doesn't meet yet is in tests/known-failures.json, unless the trial tracks it (`tracking`).
const guard = guards(import.meta.url);
const TRUTH_RATES = ["R1", "R2", "R3", "R6"] as const;
const TRUTH_CRITICAL = CRITICAL.filter((c) => c !== "K7");
type TruthCode = (typeof TRUTH_CRITICAL)[number] | (typeof TRUTH_RATES)[number];

interface Observed {
  exit: number;
  sealed: boolean;
  runtime: string | null;
  level: number | null;
  outcome: string | null;
  unproven: boolean | null;
  couldBe: number | null;
  components: Record<string, { level: number | null; unproven: boolean }>;
  notAssessed: string[];
  instructionFailures: string[];
  blockingSafety: string[];
  // Compared only where a recording has it, so a recorded headline can't drift unnoticed.
  headline?: string | null;
}

interface Trial {
  id: string;
  repo: string;
  commit: string;
  runtime: "docker" | "none";
  review: string;
  // When the audit runs, where it differs from the file's: the date of the review the trial reproduces.
  now?: string;
  // What the reviews found, in prose. The asserted truth is truth/<id>.json.
  notes: string;
  // Hosts the result depends on. When any is unreachable the run is compared with recorded.restricted.
  egress?: string[];
  // --budget-component for the audit, the rerun the report advises when a component's budget runs
  // out, for a trial whose result is otherwise decided by the machine's speed rather than the repo.
  budgetComponentMinutes?: number;
  // "read-only" scans without running repo code: a repo too large to audit within the run, checked
  // for discovery, placement, test commands and safety findings. Unset, the audit runs at local-exec.
  tier?: "read-only";
  // Wall minutes of the trial's audits on the machines the shards run on (CI's runners), which split
  // the run into shards.
  minutes: number;
  // A time budget decides the result, so it depends on the machine's speed: where several shards
  // share a machine, its audit runs with no other audit beside it.
  budgetEdge?: boolean;
  // Truth guards that report a miss without failing the run, each with why. Only for a miss that
  // comes from a feature the tool doesn't support yet; such a guard is never in known-failures.json.
  tracking?: Partial<Record<TruthCode, string>>;
  // The same audit run again another way, each recorded on its own: "none" with no container
  // runtime, "host" with no runtime and the user's yes to run on this machine, which on a Cursor
  // Cloud Agent VM takes the detected-VM path.
  alsoRun?: Variant[];
  // Instruction items, as file:line, that are genuinely wrong. Every other failing item is a false finding.
  realInstructionFindings: string[];
  falseInstructionFindings: number;
  recorded: Partial<Record<"any" | "open" | "restricted", Observed>>;
  // Each alsoRun result, by variant and, for "host", the environment the audit reports: "none",
  // "host/host", "host/disposable_vm".
  recordedAlso?: Record<string, Observed>;
}

type Variant = "none" | "host";

interface TrialsFile {
  now: string;
  seed: string;
  trials: Trial[];
}

const FILE = join(SUPPORT, "trials", "trials.json");
const spec = JSON.parse(readFileSync(FILE, "utf8")) as TrialsFile;
const CACHE = process.env.SA_TRIALS_CACHE || join(tmpdir(), "agent-readiness-trials");
const RECORD = process.env.SA_TRIALS_RECORD === "1";
// SA_TRIALS_RECORD=minutes checks every result as usual and rewrites only each trial's minutes. Run
// it where the shards run, since the minutes balance them; a result recording leaves them as they are.
const RECORD_MINUTES = process.env.SA_TRIALS_RECORD === "minutes";
const ONLY = (process.env.SA_TRIALS_ONLY ?? "").split(",").filter(Boolean);
const SHARD = parseShard(process.env.SA_TRIALS_SHARD);
// Audits at once on this machine, across shard processes sharing SA_TRIALS_CACHE. One by default, so
// shards started side by side on one machine never slow each other's audits; raise it on a machine
// with spare cores. A budgetEdge trial always runs alone.
const HOST_SLOTS = Number(process.env.SA_TRIALS_HOST_SLOTS || 1);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Evidence replay (support/trials/evidence.ts): SA_TRIALS_EVIDENCE=record on a base-branch push
// writes SA_TRIALS_EVIDENCE_DIR; =replay on a pull request reads it. Unset, every trial runs live.
const REPO_ROOT = join(SUPPORT, "..", "..", "..");
const EVIDENCE = evidenceMode(process.env, git(REPO_ROOT, ["rev-parse", "HEAD"]).trim());
const EVIDENCE_DIR = process.env.SA_TRIALS_EVIDENCE_DIR ?? "";
const EXECUTOR = executorDigest(REPO_ROOT);
const DECLARED = declaredChanges(process.env.SA_PR_BODY ?? "");
const loaded = EVIDENCE.mode === "replay" ? loadStore(EVIDENCE_DIR, REPO_ROOT, process.env) : null;
const STORE: Store | null = loaded && "trials" in loaded ? loaded : null;
if (EVIDENCE.mode === "record" && !EVIDENCE_DIR) throw new Error("SA_TRIALS_EVIDENCE=record needs SA_TRIALS_EVIDENCE_DIR");
if (RECORD_MINUTES && EVIDENCE.mode !== "live") throw new Error("SA_TRIALS_RECORD=minutes times live audits; unset SA_TRIALS_EVIDENCE");
process.stdout.write(`trials: ${EVIDENCE.mode === "record" ? `live, recording evidence to ${EVIDENCE_DIR}` : EVIDENCE.mode === "live" ? `live (${EVIDENCE.why})` : STORE ? `replaying evidence from ${STORE.provenance.event} ${STORE.provenance.ref} at ${STORE.provenance.sha.slice(0, 7)}${STORE.provenance.runId ? `, run ${STORE.provenance.runId}` : ""} (${EVIDENCE.why}); a trial without a replayable recording runs live` : `live, the store was refused: ${(loaded as { refused: string }).refused}`}\n`);

// What a trial's recording depends on besides the code: a change to any of these runs it live.
function inputsOf(t: Trial): string {
  return sha256(JSON.stringify({ repo: t.repo, commit: t.commit, runtime: t.runtime, tier: t.tier ?? null, now: t.now ?? spec.now, seed: spec.seed, budget: t.budgetComponentMinutes ?? null, egress: t.egress ?? [] }));
}

function reportOf(repo: string): unknown {
  const file = join(repo, ".agent-readiness/latest/report.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

interface Hook {
  mode: "record" | "replay";
  calls: string;
  miss: string;
  // The network key the recording was compared under, which a replay keeps.
  key?: string;
}

function checkout(t: Trial): string {
  const dir = join(CACHE, t.id);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(CACHE, { recursive: true });
    git(CACHE, ["clone", "-q", "--filter=blob:none", "--no-checkout", `https://github.com/${t.repo}`, t.id]);
  }
  try {
    git(dir, ["cat-file", "-e", `${t.commit}^{commit}`]);
  } catch {
    git(dir, ["fetch", "-q", "origin", t.commit]);
  }
  git(dir, ["checkout", "-q", "-f", "--detach", t.commit]);
  git(dir, ["clean", "-q", "-fdx"]);
  return dir;
}

// A PATH whose docker and podman are not found, as on a machine without a container runtime.
function noRuntimePath(): string {
  const bin = join(CACHE, "no-runtime-bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["docker", "podman"]) {
    if (existsSync(join(bin, name))) continue;
    writeFileSync(join(bin, name), "#!/bin/sh\necho \"$0: not installed (trial without a container runtime)\" >&2\nexit 127\n");
    chmodSync(join(bin, name), 0o755);
  }
  return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

// Any HTTP response counts as reachable. Every host is probed once, before any audit starts, so the
// audits' load can't time a probe out.
async function reachable(host: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fetch(`https://${host}/`, { signal: AbortSignal.timeout(15_000) });
      return true;
    } catch {}
  }
  return false;
}

const network = new Map<string, Promise<boolean>>();
function probe(host: string): Promise<boolean> {
  if (!network.has(host)) network.set(host, reachable(host));
  return network.get(host)!;
}

function observe(repo: string, code: number): Observed {
  const read = (p: string) => (existsSync(join(repo, p)) ? JSON.parse(readFileSync(join(repo, p), "utf8")) : null);
  const report = read(".agent-readiness/latest/report.json");
  const audit = report ? read(`${report.audit.storedAt}/audit.json`) : null;
  const components: Observed["components"] = {};
  for (const c of report?.components?.included ?? []) components[c.id] = { level: c.level ?? null, unproven: Boolean(c.unproven) };
  return {
    exit: code,
    sealed: audit?.state === "sealed",
    runtime: audit?.environment?.containerRuntime ?? null,
    level: report?.maturity?.level ?? null,
    outcome: report?.maturity?.outcome ?? null,
    unproven: report ? Boolean(report.maturity.unproven) : null,
    couldBe: report?.maturity?.couldBe ?? null,
    components,
    notAssessed: (report?.components?.excluded ?? []).map((c: { id: string }) => c.id).sort(),
    instructionFailures: (audit?.instructions ?? []).filter((i: { result: string }) => i.result === "fail").map((i: { source: string; line: number }) => `${i.source}:${i.line}`),
    blockingSafety: (audit?.safety ?? []).filter((s: { blocking: boolean }) => s.blocking).map((s: { file: string; line?: number; kind: string }) => `${s.kind} ${s.file}${s.line ? `:${s.line}` : ""}`),
    headline: report?.executive?.headline ?? null,
  };
}

// Every cause the headline names for a component must match that component's condition states.
function headlineErrors(repo: string): string[] {
  const file = join(repo, ".agent-readiness/latest/report.json");
  return existsSync(file) ? headlineCauseErrors(JSON.parse(readFileSync(file, "utf8")) as ReportJson) : [];
}

// Every result short of a pass, with why, and each planted fault's outcome, so a level that differs
// between machines can be traced to the check that decided it.
function unsettled(repo: string): string[] {
  const report = existsSync(join(repo, ".agent-readiness/latest/report.json")) ? JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8")) : null;
  const file = report ? join(repo, report.audit.storedAt, "audit.json") : "";
  if (!file || !existsSync(file)) return [];
  const audit = JSON.parse(readFileSync(file, "utf8")) as { evidence: { id: string; checkId: string; condition?: string; component?: string; result: string; blocked?: string; durationMs?: number; summary: string }[]; mutants: { id: string; result: string; exitCodes: number[] }[]; environment?: { limits?: unknown } };
  const lines = audit.evidence
    .filter((e) => e.result !== "pass")
    .map((e) => `not passed: ${e.id} ${e.checkId} ${e.condition ?? ""} ${e.component ?? "*"} ${e.result}${e.blocked ? ` (blocked: ${e.blocked})` : ""}${e.durationMs ? ` ${Math.round(e.durationMs / 1000)}s` : ""}: ${e.summary}`);
  if (audit.mutants.length) lines.push(`planted faults: ${audit.mutants.map((m) => `${m.id} ${m.result} [${m.exitCodes.join(",")}]`).join("; ")}`);
  if (audit.environment?.limits) lines.push(`container limits: ${JSON.stringify(audit.environment.limits)}`);
  return lines;
}

function falseFindings(t: Trial, o: Observed): string[] {
  return o.instructionFailures.filter((f) => !t.realInstructionFindings.includes(f));
}

const selected = SHARD ? shards(spec.trials, SHARD.count)[SHARD.index - 1] : spec.trials;
const trials = selected.filter((t) => ONLY.length === 0 || ONLY.includes(t.id));
const runtime = detectRuntime("docker");
if (SHARD) process.stdout.write(`shard ${SHARD.index}/${SHARD.count}: ${selected.map((t) => t.id).join(", ")} (${minutesOf(selected)} recorded minutes)\n`);

interface TrialRun {
  key: string;
  blocked: string[];
  code: number;
  out: string;
  repo: string;
  o: Observed;
  score: RepoScore;
  minutes: number;
  // Read once the audit ends, so a later replay in the same checkout can't change them.
  headlineErrors: string[];
  unsettled: string[];
  report: unknown;
  // How the evidence was got, when it was recorded or replayed.
  evidence?: string;
  // Paths at which a replayed report.json differs from the recording's.
  reportDiff?: string[];
}

function truthOf(t: Trial): Truth {
  return JSON.parse(readFileSync(join(SUPPORT, "trials", "truth", `${t.id}.json`), "utf8")) as Truth;
}

// The audit's environment as the holdout's observer reads it, which keys a "host" variant's recording.
function environmentOf(repo: string): string {
  return observeTruth(repo, { exit: 0 }).environment;
}

async function auditTrial(t: Trial, variant?: Variant, hook?: Hook): Promise<TrialRun> {
  const blocked: string[] = [];
  if (hook?.mode !== "replay") for (const h of t.egress ?? []) if (!(await probe(h))) blocked.push(h);
  const network = hook?.key ?? (!t.egress?.length ? "any" : blocked.length ? "restricted" : "open");
  const repo = checkout(t);
  const tmp = join(CACHE, "tmp", t.id);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const runtimeOf = variant ? "none" : t.runtime;
  const env: Record<string, string> = { SA_READINESS_EVAL_SEED: spec.seed, SA_READINESS_NOW: t.now ?? spec.now, SA_READINESS_RUNTIME: runtimeOf, TMPDIR: tmp };
  if (runtimeOf === "none") env.PATH = noRuntimePath();
  // "none" is the same on every machine: no runtime and, so no machine reads as a disposable VM,
  // detection off. "host" keeps the machine's own detection.
  if (variant === "none") env.SA_READINESS_VM_DETECT = "off";
  // Copied into the repo and run from there, as the quickstart has a customer do, so the repo's
  // own package.json (such as "type": "commonjs") applies to the scripts.
  const skill = join(repo, ".cursor", "skills", "agent-readiness");
  cpSync(SKILL, skill, { recursive: true });
  const budget = t.budgetComponentMinutes ? ["--budget-component", String(t.budgetComponentMinutes)] : [];
  const args = ["audit", "--tier", t.tier ?? "local-exec", ...(t.tier === "read-only" ? [] : budget), ...(variant === "host" ? ["--allow-host"] : [])];
  if (hook) Object.assign(env, { [HOOK_MODE_ENV]: hook.mode, [HOOK_CALLS_ENV]: hook.calls, [HOOK_MISS_ENV]: hook.miss, [HOOK_SCRIPTS_ENV]: join(skill, "scripts") });
  // A replay's budgets read the recording's clock, so it needn't run alone.
  const release = await acquireHost(join(CACHE, "host-lock"), { slots: HOST_SLOTS, exclusive: Boolean(t.budgetEdge) && hook?.mode !== "replay", label: `${t.id}${variant ? ` (${variant})` : ""}` });
  const started = Date.now();
  let r: { code: number; out: string };
  try {
    r = readiness(repo, args, env, join(skill, "scripts", "readiness.ts"), hook ? ["--import", HOOK] : []);
  } finally {
    release();
  }
  const minutes = Math.round((Date.now() - started) / 6000) / 10;
  const after = afterAudit(repo, { tmp, containers: `-${t.commit.slice(0, 7)}-`, ignore: [".cursor/skills/agent-readiness/"] });
  const score = scoreRepo(truthOf(t), observeTruth(repo, { exit: r.code, after }));
  const key = variant === "host" ? `host/${environmentOf(repo)}` : variant ?? network;
  return { key, blocked, code: r.code, out: r.out, repo, o: observe(repo, r.code), score, minutes, headlineErrors: headlineErrors(repo), unsettled: unsettled(repo), report: reportOf(repo) };
}

function hookFiles(t: Trial, what: string): { calls: string; miss: string } {
  const dir = join(CACHE, "evidence", what);
  mkdirSync(dir, { recursive: true });
  const calls = join(dir, `${t.id}.calls.json`);
  const miss = join(dir, `${t.id}.miss`);
  for (const f of [calls, `${calls}.made`, miss]) rmSync(f, { force: true });
  return { calls, miss };
}

// Replays a recording with this checkout's code. Abandoned, with why, at the first call the recording
// doesn't have, a recorded call never made, or a plan that differs from the recording's.
async function replayTrial(t: Trial, ev: TrialEvidence): Promise<{ run: TrialRun } | { abandoned: string }> {
  const files = hookFiles(t, "replay");
  writeFileSync(files.calls, JSON.stringify(ev.calls));
  const run = await auditTrial(t, undefined, { mode: "replay", ...files, key: ev.key });
  if (existsSync(files.miss)) return { abandoned: readFileSync(files.miss, "utf8").trim() };
  if (!existsSync(`${files.calls}.made`)) return { abandoned: `the audit ended without the hook's record of the calls it made (exit ${run.code}): ${run.out.trim().split("\n").slice(-3).join(" | ")}` };
  const made = JSON.parse(readFileSync(`${files.calls}.made`, "utf8")) as string[];
  if (planDigest(made) !== ev.plan) return { abandoned: "the replay made the recorded calls in another order" };
  return { run: { ...run, reportDiff: diffJson(ev.report, run.report) } };
}

// Live, with every container call recorded; then replayed at once with the same code, which must give
// back the same report.json for a pull request to replay it. The live run is the one asserted.
async function recordTrial(t: Trial): Promise<TrialRun> {
  if (EVIDENCE.mode !== "record") throw new Error("not recording");
  const files = hookFiles(t, "record");
  const run = await auditTrial(t, undefined, { mode: "record", ...files });
  const calls = JSON.parse(readFileSync(files.calls, "utf8")) as RecordedCall[];
  const ev: TrialEvidence = { version: 1, trial: t.id, key: run.key, inputs: inputsOf(t), executor: EXECUTOR, plan: planDigest(calls.map((c) => c.key)), calls, report: run.report, replayable: false, provenance: EVIDENCE.provenance };
  const started = Date.now();
  const check = await replayTrial(t, ev);
  const minutes = Math.round((Date.now() - started) / 6000) / 10;
  const diff = "run" in check ? check.run.reportDiff! : [];
  ev.replayable = "run" in check && diff.length === 0 && run.report !== null;
  if (!ev.replayable) ev.why = "abandoned" in check ? check.abandoned : run.report === null ? "the live audit wrote no report" : `report.json differs at ${diff.slice(0, 10).join(", ")}`;
  writeEvidence(EVIDENCE_DIR, ev);
  return { ...run, evidence: `recorded ${calls.length} container calls; the replay ${ev.replayable ? `gave back the same report.json in ${minutes} minutes` : `isn't faithful, so pull requests run this trial live: ${ev.why}`}` };
}

// The main audit of a trial: recorded on a base push, replayed on a pull request when the store has a
// replayable recording of it, otherwise live.
async function mainRun(t: Trial): Promise<TrialRun> {
  if (EVIDENCE.mode === "record") return recordTrial(t);
  if (!STORE) return auditTrial(t);
  const ev = STORE.trials.get(t.id);
  const why = notReplayable(ev, inputsOf(t), EXECUTOR);
  if (why) return { ...(await auditTrial(t)), evidence: `live: ${why}` };
  const replayed = await replayTrial(t, ev!);
  if ("run" in replayed) return { ...replayed.run, evidence: `replayed ${ev!.calls.length} container calls recorded at ${ev!.provenance.sha.slice(0, 7)}` };
  return { ...(await auditTrial(t)), evidence: `live: the replay was abandoned: ${replayed.abandoned}` };
}

// Shards recording side by side on one machine write trials.json one at a time.
async function updateTrials(id: string, change: (entry: Trial) => void): Promise<void> {
  const release = await acquireHost(join(CACHE, "record-lock"), { slots: 1, exclusive: false, label: id, pollMs: 200 });
  try {
    const file = JSON.parse(readFileSync(FILE, "utf8")) as TrialsFile;
    change(file.trials.find((x) => x.id === id)!);
    writeFileSync(FILE, JSON.stringify(file, null, 2) + "\n");
  } finally {
    release();
  }
}

function describeRun(ctx: TestContext, t: Trial, run: TrialRun): void {
  const { key, blocked, out, o } = run;
  if (run.evidence) ctx.diagnostic(`evidence: ${run.evidence}`);
  ctx.diagnostic(`observed (${key}${blocked.length ? `, blocked: ${blocked.join(", ")}` : ""}, ${run.minutes} minutes): ${JSON.stringify(o)}`);
  ctx.diagnostic(`headline: ${o.headline}`);
  ctx.diagnostic(`false instruction findings: ${falseFindings(t, o).length} (ceiling ${t.falseInstructionFindings})`);
  ctx.diagnostic(`against its truth: ${JSON.stringify(run.score.classes)}`);
  if (!o.sealed) ctx.diagnostic(`not sealed, output ends: ${out.trim().split("\n").slice(-5).join(" | ")}`);
  for (const line of run.unsettled) ctx.diagnostic(line);
  if (run.reportDiff?.length) ctx.diagnostic(`report.json differs from the recording's at: ${run.reportDiff.join(", ")}`);
}

// A replayed report.json is compared whole with the recording's. A pull request that changes a report
// on purpose says where in its description: `Report change: <trial id or *> <path>`.
function assertReport(t: Trial, run: TrialRun): void {
  if (!run.reportDiff) return;
  const bad = undeclared(t.id, run.reportDiff, DECLARED);
  assert.deepEqual(bad, [], `${t.id}'s replayed report.json differs from the base's where the PR description declares no change; if intended, add "Report change: ${t.id} <path>" lines for: ${bad.slice(0, 20).join(", ")}`);
}

function assertMatches(t: Trial, run: TrialRun, want: Observed | undefined, what: string): void {
  const { code, out, o } = run;
  const ff = falseFindings(t, o);
  assert.ok(o.sealed || want?.sealed === false, `the audit didn't seal (exit ${code}):\n${out.slice(-3000)}`);
  const wrongCauses = run.headlineErrors;
  assert.deepEqual(wrongCauses, [], `${t.id}'s headline names a cause its own conditions contradict: ${o.headline}`);
  assert.ok(ff.length <= t.falseInstructionFindings, `${ff.length} false instruction findings, above the recorded ${t.falseInstructionFindings}: ${ff.join(", ")}`);
  assert.ok(want, `no result recorded for ${what}; run with SA_TRIALS_RECORD=1 and commit trials.json`);
  const { instructionFailures: _a, headline: gotHeadline, ...got } = o;
  const { instructionFailures: _b, headline: wantHeadline, ...exp } = want;
  if (wantHeadline !== undefined) assert.equal(gotHeadline, wantHeadline, `${t.id}'s headline changed from its recorded one; if that is intended, re-record it and say why in the PR`);
  assert.deepEqual(got, exp, `${t.id} changed from its recorded result; if that is intended, re-record it and say why in the PR`);
}

function truthCheck(run: TrialRun, code: TruthCode): void {
  if ((TRUTH_CRITICAL as readonly string[]).includes(code)) {
    const k = code as (typeof TRUTH_CRITICAL)[number];
    assert.equal(run.score.critical[k], 0, `${k}: ${run.score.critical[k]} event(s); classes ${JSON.stringify(run.score.classes)}`);
    return;
  }
  const n = run.score.rates[code as (typeof TRUTH_RATES)[number]];
  assert.equal(n.hit, n.of, `${code}: ${n.hit} of ${n.of}; classes ${JSON.stringify(run.score.classes)}`);
}

// Run one trial at a time: each audit blocks the event loop while it runs, so no two audits in
// this process overlap anyway, and the host lock, not this suite, decides what runs side by side.
describe("pinned trial repos", () => {
  before(async () => {
    await Promise.all(trials.flatMap((t) => t.egress ?? []).map(probe));
  });
  after(() => {
    if (EVIDENCE.mode === "record") writeManifest(EVIDENCE_DIR, SHARD ? `${SHARD.index}-of-${SHARD.count}` : "all", EVIDENCE.provenance);
  });
  for (const t of trials) {
    const skip = t.runtime === "docker" && !runtime ? "no docker: this trial runs in a container" : false;
    const how = t.tier === "read-only" ? "read-only scan" : t.runtime === "docker" ? "docker" : "no container runtime";
    describe(`${t.id} (${t.repo}@${t.commit.slice(0, 7)}, ${how})`, { skip }, () => {
      let run: TrialRun;
      before(async () => {
        run = await mainRun(t);
      }, { timeout: 120 * 60_000 });
      test(`${t.id} matches its recording`, async (ctx) => {
        describeRun(ctx, t, run);
        if (RECORD) {
          await updateTrials(t.id, (entry) => {
            entry.recorded[run.key as keyof Trial["recorded"]] = run.o;
            entry.falseInstructionFindings = falseFindings(t, run.o).length;
          });
          return;
        }
        if (RECORD_MINUTES) await updateTrials(t.id, (entry) => (entry.minutes = run.minutes));
        assertMatches(t, run, t.recorded[run.key as keyof Trial["recorded"]], `the "${run.key}" network`);
        assertReport(t, run);
      });
      for (const code of [...TRUTH_CRITICAL, ...TRUTH_RATES]) {
        const why = t.tracking?.[code];
        if (!why) {
          guard(`${t.id} truth ${code}`, () => truthCheck(run, code));
          continue;
        }
        test(`${t.id} truth ${code} (tracking)`, (ctx) => {
          try {
            truthCheck(run, code);
            ctx.diagnostic(`tracking: ${t.id} ${code} now meets its truth; take it out of tracking`);
          } catch (e) {
            ctx.diagnostic(`tracking miss: ${t.id} ${code} (${why}): ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
          }
        });
      }
      for (const variant of t.alsoRun ?? []) {
        describe(`${t.id} with ${variant === "none" ? "no container runtime" : "host mode"}`, () => {
          let v: TrialRun;
          before(async () => {
            v = await auditTrial(t, variant);
          }, { timeout: 120 * 60_000 });
          test(`${t.id} with ${variant} matches its recording`, async (ctx) => {
            describeRun(ctx, t, v);
            if (RECORD) {
              await updateTrials(t.id, (entry) => {
                entry.recordedAlso = { ...entry.recordedAlso, [v.key]: v.o };
              });
              return;
            }
            if (RECORD_MINUTES) await updateTrials(t.id, (entry) => (entry.minutes = Math.round((entry.minutes + v.minutes) * 10) / 10));
            for (const k of TRUTH_CRITICAL) truthCheck(v, k);
            const want = t.recordedAlso?.[v.key];
            // A host-mode result depends on the machine's own toolchains, so a machine with none
            // recorded for its environment reports what it saw rather than failing.
            if (!want && variant === "host") {
              assert.ok(v.o.sealed, `the audit didn't seal (exit ${v.code}):\n${v.out.slice(-3000)}`);
              ctx.diagnostic(`no host-mode result recorded for "${v.key}"; SA_TRIALS_RECORD=1 on this kind of machine records one`);
              return;
            }
            assertMatches(t, v, want, `"${v.key}"`);
          });
        });
      }
    });
  }
});
