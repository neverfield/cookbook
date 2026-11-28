import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiExhaustedError, apiRefusals, modelCatalog } from "./lib/api.ts";
import { HILL_CLIMB_MIN_REPEATS, compare, crashedRun, isInfraError, summarize, withControls, writeJunit } from "./lib/baseline.ts";
import type { Baseline } from "./lib/baseline.ts";
import { currentBinding } from "./lib/binding.ts";
import type { Binding } from "./lib/binding.ts";
import { scriptedAudit } from "./lib/controls.ts";
import { NO_DOCKER_GATES } from "./lib/gates.ts";
import { loadCalibration, releaseRecord, releaseVerdict } from "./lib/release.ts";
import { isolateHome } from "./lib/isolation.ts";
import { runFingerprint } from "./lib/fingerprint.ts";
import { DETERMINISTIC_REPEATS, deterministic, loadCases, planJobs, probeOutcome, restOf, select } from "./lib/plan.ts";
import type { Job } from "./lib/plan.ts";
import { gradeCase, latestReport } from "./lib/grade.ts";
import { renderMarkdown } from "../../skill/agent-readiness/scripts/lib/render.ts";
import { loadRubric } from "../../skill/agent-readiness/scripts/lib/rubric.ts";
import type { ReportJson } from "../../skill/agent-readiness/scripts/lib/types.ts";
import { PANEL_SAMPLES, PANEL_SIZE, PROMPTS, availableModels, chooseJudges, judgePanel, judgePromptDigest } from "./lib/judge.ts";
import type { JudgeResult, PanelResult } from "./lib/judge.ts";
import { rerenderLatest } from "./lib/rerender.ts";
import { runWithSdk } from "./lib/sdk.ts";
import type { Arm, CaseRun, EvalCase, Trajectory } from "./lib/types.ts";
import { exitWhenFlushed, supervise, writeResult } from "./lib/worker-exit.ts";
import { applyTurnHook, externalPreamble, fillPrompt, loadWorkspace, prepare, skillPreamble } from "./lib/workspace.ts";
import { knownFailures } from "../tools/known-failures.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL = process.env.SA_READINESS_EVAL_MODEL ?? "composer-2";
const ARMS: Arm[] = ["agent", "skill-off", "scripted", "no-docker"];
// Arms the agent drives; the scripted arm runs `readiness audit` alone.
const CONTROL_ARMS: Arm[] = ["skill-off", "scripted", "no-docker"];

function args() {
  const a = process.argv.slice(2);
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const key = a[i].slice(2);
    const next = a[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function holdoutIds(all: EvalCase[]): Set<string> {
  return new Set(all.filter((c) => c.tags.includes("holdout")).map((c) => c.id));
}

function writeJudgePrompts(dir: string, r: ReportJson): void {
  for (const [kind, prompt] of Object.entries(PROMPTS)) writeFileSync(join(dir, `${kind}-prompt.txt`), prompt(r));
}

function readJudge(file: string): JudgeResult {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as JudgeResult) : { score: null, reasons: ["judge not run"] };
}

function externalTrajectory(root: string, wallMs: number): Trajectory {
  const reply = join(root, "reply.md");
  return { driver: "external", toolCalls: [], text: existsSync(reply) ? readFileSync(reply, "utf8") : "", durationMs: wallMs, tokens: null, error: null };
}

function runAttack(ws: ReturnType<typeof prepare>, c: EvalCase): Trajectory {
  const started = Date.now();
  try {
    return c.attack!(ws, c);
  } catch (e) {
    return { driver: "scripted", toolCalls: [], snapshots: [], text: "", durationMs: Date.now() - started, tokens: null, error: `the attack script failed: ${(e as Error).message}` };
  }
}

const NOT_JUDGED: PanelResult = { score: null, reasons: ["negative cases aren't judged"], byModel: {} };

async function judgeRun(r: ReportJson | null, arm: Arm, judgeModels: string[], samples: number): Promise<[PanelResult, PanelResult]> {
  const key = process.env.CURSOR_API_KEY;
  // A control arm that left no report has nothing a reader could use: it scores 0, so the agent's lift counts it.
  const zero: PanelResult = { score: 0, reasons: ["no report: 0 for a control arm"], byModel: {} };
  if (!r && arm !== "agent" && key && judgeModels.length) return [zero, zero];
  const none: PanelResult = { score: null, reasons: ["no judge model"], byModel: {} };
  if (!judgeModels.length) return [none, none];
  const [h, p] = await Promise.all((["headline", "page"] as const).map((k) => judgePanel(k, r, judgeModels, key, samples)));
  return [h, p];
}

// The no-docker arm: no container runtime is reachable, whatever is installed. The variables point
// the docker and podman clients at a socket that doesn't exist, and stubs earlier on PATH stand in
// for the binaries, as on a machine without a runtime.
function withoutRuntime(): void {
  const bin = mkdtempSync(join(tmpdir(), "no-runtime-"));
  for (const name of ["docker", "podman"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$0: not installed (eval arm without a container runtime)" >&2\nexit 127\n`);
    chmodSync(join(bin, name), 0o755);
  }
  process.env.PATH = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  process.env.DOCKER_HOST = "unix:///nonexistent/docker.sock";
  process.env.CONTAINER_HOST = "unix:///nonexistent/podman.sock";
  process.env.SA_READINESS_RUNTIME = "none";
}

async function worker(flags: Record<string, string | true>): Promise<void> {
  // Before anything reads HOME: the SDK, the agent's shell and the grader all run in this process.
  const iso = isolateHome();
  if (iso.userDirs.length) throw new Error(`the isolated HOME already holds ${iso.userDirs.join(", ")}`);
  const all = await loadCases();
  const c = all.find((x) => x.id === flags.case)!;
  const model = String(flags.model);
  const arm = (typeof flags.arm === "string" ? flags.arm : "agent") as Arm;
  const judgeModels = typeof flags["judge-model"] === "string" ? flags["judge-model"].split(",").filter(Boolean).sort() : [];
  const samples = Number(flags["judge-samples"] ?? PANEL_SAMPLES);
  if (arm === "no-docker") withoutRuntime();
  const ws = prepare(c, { skill: arm !== "skill-off" });
  const timeoutMs = Number(flags["timeout-min"] ?? 30) * 60000;
  const t = c.attack ? runAttack(ws, c) : arm === "scripted" ? scriptedAudit(ws, c) : await runWithSdk(ws, c, model, process.env.CURSOR_API_KEY!, timeoutMs, { skill: arm !== "skill-off" });
  const gates = t.error && c.attack ? [{ name: "the attack ran", pass: false, detail: t.error }] : gradeCase(ws, t, arm === "no-docker" ? { ...c, gates: NO_DOCKER_GATES } : c);
  const report = latestReport(ws);
  let judgeError: string | undefined;
  const [h, p] = c.attack
    ? [NOT_JUDGED, NOT_JUDGED]
    : await judgeRun(report, arm, judgeModels, samples).catch((e: Error): [PanelResult, PanelResult] => {
        // Kept out of run.error, so the parent doesn't redo the agent's run as an infrastructure loss.
        if (!(e instanceof ApiExhaustedError)) throw e;
        judgeError = e.message;
        const none: PanelResult = { score: null, reasons: [`judge refused: ${e.message}`], byModel: {} };
        return [none, none];
      });
  const byModel = { ...(Object.keys(h.byModel).length ? { judgeByModel: h.byModel, pageByModel: p.byModel } : {}), ...(judgeError ? { judgeError } : {}) };
  const fingerprint = deterministic({ c, arm }) ? { fingerprint: runFingerprint(ws, gates, t.error) } : {};
  const run: CaseRun = { id: c.id, repeat: Number(flags.repeat), model, driver: t.driver, arm, judgeModel: c.attack || !judgeModels.length ? null : judgeModels.join(","), rubric: report?.audit.rubric ?? null, isolation: iso.id, workspace: ws.dir, grade: { gates, soft: { judge: h.score, judgeReasons: h.reasons, page: p.score, pageReasons: p.reasons, ...byModel, wallMs: t.durationMs, toolCalls: t.toolCalls.length, tokens: t.tokens } }, error: t.error, ...fingerprint };
  writeResult(String(flags.out), { run, trajectory: t });
}

// How long a worker may run on after writing a complete result before the parent stops it.
const RESULT_GRACE_MS = Number(process.env.SA_READINESS_EVAL_RESULT_GRACE_SEC ?? 60) * 1000;


interface JudgeSetup {
  models: string[];
  samples: number;
}

async function spawnOnce(j: Job, out: string, timeoutMin: string, judges: JudgeSetup | null): Promise<void> {
  const argv = [fileURLToPath(import.meta.url), "--worker", "--case", j.c.id, "--repeat", String(j.r), "--model", j.m, "--arm", j.arm, "--out", out, "--timeout-min", timeoutMin, ...(judges?.models.length ? ["--judge-model", judges.models.join(","), "--judge-samples", String(judges.samples)] : [])];
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", ...argv], { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  // The worker cancels its own turn at the timeout and exits once its result is written; this
  // catches one that hangs past either, keeping a result that is already complete.
  const s = await supervise(child, out, { graceMs: RESULT_GRACE_MS, hardMs: (Number(timeoutMin) + 10) * 60000, log: (line) => process.stdout.write(`${j.c.id} #${j.r} [${j.arm}]: ${line}\n`) });
  if (!existsSync(out)) writeFileSync(out, JSON.stringify({ run: crashedRun(j.c, j.r, j.m, `the worker exited ${s.signal ? `on ${s.signal}` : `with code ${s.code}`} without a result`, j.arm) }, null, 2));
}

// Infrastructure errors (capacity, network, a crashed worker) are retried in a fresh workspace and
// recorded separately; a run that fails that way every time is lost, not failed.
async function spawnWorker(j: Job, out: string, timeoutMin: string, judges: JudgeSetup | null, retries: number): Promise<void> {
  const errors: string[] = [];
  for (let attempt = 1; ; attempt++) {
    rmSync(out, { force: true });
    await spawnOnce(j, out, timeoutMin, judges);
    const saved = JSON.parse(readFileSync(out, "utf8")) as { run: CaseRun; trajectory?: Trajectory };
    const infra = isInfraError(saved.run.error);
    if (infra) errors.push(saved.run.error!);
    if (!infra || attempt > retries) {
      if (errors.length) {
        saved.run.infra = { attempts: attempt, errors, lost: infra };
        writeFileSync(out, JSON.stringify(saved, null, 2));
      }
      return;
    }
    process.stdout.write(`retrying ${j.c.id} #${j.r} [${j.arm}] after an infrastructure error: ${saved.run.error}\n`);
  }
}

function collect(dir: string): CaseRun[] {
  const runs: CaseRun[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === "result.json" || n.endsWith(".run.json")) runs.push((JSON.parse(readFileSync(p, "utf8")) as { run: CaseRun }).run);
    }
  };
  walk(dir);
  return runs;
}

const fmtCi = (x: { mean: number | null; low: number | null; high: number | null }) => (x.mean === null ? "n/a" : `${x.mean} (95% CI ${x.low} to ${x.high})`);

interface ReportOptions {
  model: string;
  driver: string;
  repeats: number;
  holdout: Set<string>;
  selected?: string[];
  controls?: Partial<Record<Arm, CaseRun[]>>;
  judgeSamples?: number | null;
  binding?: Binding;
}

function report(runs: CaseRun[], flags: Record<string, string | true>, o: ReportOptions): number {
  const arm = runs[0]?.arm ?? "agent";
  let summary = summarize(runs, { model: o.model, driver: o.driver, repeats: o.repeats, note: typeof flags.note === "string" ? flags.note : undefined, arm, holdout: o.holdout, judgePrompt: judgePromptDigest(), judgeSamples: o.judgeSamples ?? null, binding: o.binding });
  if (o.controls) summary = withControls(summary, runs, o.controls, o.holdout);
  for (const [id, s] of Object.entries(summary.cases)) process.stdout.write(`${s.allGatesPass.padStart(5)}  ${(id + (s.holdout ? " (held out)" : "")).padEnd(60)} judge ${s.judge ?? "n/a"} page ${s.page ?? "n/a"}${s.infraLost ? `  ${s.infraLost} lost to infrastructure` : ""}  ${Object.entries(s.gates).filter(([, v]) => !v.startsWith(String(s.usable))).map(([g, v]) => `${g} ${v}`).join("; ")}\n`);
  const t = summary.totals;
  process.stdout.write(`[${arm}] All gates passed in ${t.allGatesPass} cases; pooled ${t.pooled.passed}/${t.pooled.runs} runs (95% CI ${t.pooled.lower ?? "n/a"} to ${t.pooled.upper ?? "n/a"}). Headline judge ${fmtCi(t.judge)}; page judge ${fmtCi(t.page)}.${t.infraLost ? ` ${t.infraLost} runs lost to infrastructure.` : ""}\n`);
  if (summary.holdout) process.stdout.write(`[${arm}] Held out: ${summary.holdout.allGatesPass} cases; pooled ${summary.holdout.pooled.passed}/${summary.holdout.pooled.runs}; headline judge ${fmtCi(summary.holdout.judge)}.\n`);
  for (const [c, v] of Object.entries(summary.controls ?? {})) process.stdout.write(`Lift over ${c}: pooled pass rate ${v!.lift.pooled ?? "n/a"} (${c} ${v!.totals.pooled.passed}/${v!.totals.pooled.runs}); headline judge ${fmtCi(v!.lift.judge)}; page judge ${fmtCi(v!.lift.page)}.\n`);
  if (typeof flags.json === "string") {
    mkdirSync(dirname(resolve(flags.json)), { recursive: true });
    writeFileSync(resolve(flags.json), JSON.stringify({ summary, runs }, null, 2));
  }
  if (typeof flags.junit === "string") {
    mkdirSync(dirname(resolve(flags.junit)), { recursive: true });
    writeJunit(resolve(flags.junit), runs);
  }
  if (typeof flags["write-baseline"] === "string") {
    if (o.repeats < HILL_CLIMB_MIN_REPEATS) process.stdout.write(`NOTE the baseline has ${o.repeats} repeats; hill-climb rounds need ${HILL_CLIMB_MIN_REPEATS}.\n`);
    writeFileSync(resolve(flags["write-baseline"]), JSON.stringify(summary, null, 2) + "\n");
  }
  let code = 0;
  if (typeof flags.compare === "string" && existsSync(resolve(flags.compare))) {
    const base = JSON.parse(readFileSync(resolve(flags.compare), "utf8")) as Baseline;
    const { regressions, flags: soft } = compare(summary, base, { selected: o.selected });
    for (const r of regressions) process.stdout.write(`REGRESSION ${r}\n`);
    for (const f of soft) process.stdout.write(`FLAG ${f}\n`);
    if (regressions.length) code = 1;
  }
  if (arm === "agent" && o.driver === "scripted") {
    // Negative cases: any gate that lets an attack through, in any run, fails.
    if (runs.some((r) => !r.infra?.lost && !r.grade.gates.every((g) => g.pass))) code = code || 2;
  } else if (arm === "agent") {
    // The release policy (release.ts): k of n per case; one run short is a flag, two a regression.
    const verdict = releaseVerdict(summary, { binding: currentBinding(), calibration: loadCalibration(), knownFailures: knownFailures().length });
    for (const line of verdict.lines) process.stdout.write(`${line}\n`);
    if (verdict.cases.some((c) => c.verdict === "regression")) code = code || 2;
    if (flags.release && !verdict.pass) code = code || 1;
  }
  // Control arms are expected to fail gates; that is what the lift measures.
  return code;
}

// --judge-model takes a comma-separated panel; without it, PANEL_SIZE judges of other families
// than the driver and each other are picked from what the key can use.
async function pickJudges(flags: Record<string, string | true>, driverModel: string): Promise<JudgeSetup | null> {
  const key = process.env.CURSOR_API_KEY;
  const raw = typeof flags["judge-model"] === "string" ? flags["judge-model"] : process.env.SA_READINESS_JUDGE_MODEL;
  const explicit = (raw ?? "").split(",").filter(Boolean);
  const samples = Number(flags["judge-samples"] ?? PANEL_SAMPLES);
  if (!key) return explicit.length ? { models: explicit.sort(), samples } : null;
  const choices = chooseJudges(driverModel, explicit.length ? [] : await availableModels(key), explicit);
  for (const c of choices) process.stdout.write(`Judge: ${c.model} (${c.why}), ${samples} call${samples === 1 ? "" : "s"} per report.\n`);
  if (choices.length < PANEL_SIZE) process.stdout.write(`NOTE ${choices.length} judge${choices.length === 1 ? "" : "s"}; the release policy needs a panel of ${PANEL_SIZE}.\n`);
  return { models: choices.map((c) => c.model).sort(), samples };
}

async function main(): Promise<void> {
  const flags = args();
  // A worker exits as soon as its result is written: open keep-alive sockets would hold it otherwise.
  if (flags.worker) {
    try {
      await worker(flags);
    } catch (e) {
      process.stderr.write(`evals worker: ${(e as Error).stack ?? (e as Error).message}\n`);
      return exitWhenFlushed(1);
    }
    return exitWhenFlushed(0);
  }
  const all = await loadCases();
  const holdout = holdoutIds(all);
  if (flags.list) {
    for (const c of all) process.stdout.write(`${c.id.padEnd(48)} [${c.tags.join(",")}] ${c.description}\n`);
    return;
  }
  const repeats = Number(flags.repeats ?? 1);
  if (flags["hill-climb"] && repeats < HILL_CLIMB_MIN_REPEATS) throw new Error(`--hill-climb needs --repeats ${HILL_CLIMB_MIN_REPEATS} or more; ${repeats} can't tell a change from a flake.`);
  const models = String(flags.model ?? DEFAULT_MODEL).split(",");
  const arms = String(flags.arm ?? "agent").split(",") as Arm[];
  for (const a of arms) if (!ARMS.includes(a)) throw new Error(`Unknown --arm ${a}; use ${ARMS.join(", ")}.`);
  // Scores a saved run (--json output or a baseline) against the release policy: one PASS or FAIL.
  if (typeof flags["release-check"] === "string") {
    const saved = JSON.parse(readFileSync(resolve(flags["release-check"]), "utf8")) as { summary?: Baseline } & Baseline;
    const b = saved.summary ?? saved;
    const verdict = releaseVerdict(b, { binding: currentBinding(), calibration: loadCalibration(typeof flags.calibration === "string" ? resolve(flags.calibration) : undefined), knownFailures: knownFailures().length });
    for (const line of verdict.lines) process.stdout.write(`${line}\n`);
    if (typeof flags["release-record"] === "string") {
      mkdirSync(dirname(resolve(flags["release-record"])), { recursive: true });
      writeFileSync(resolve(flags["release-record"]), JSON.stringify(releaseRecord(b, verdict, new Date().toISOString()), null, 2) + "\n");
    }
    process.exitCode = verdict.pass ? 0 : 1;
    return;
  }
  if (typeof flags.hook === "string") {
    const { ws, id } = loadWorkspace(resolve(flags.hook));
    const c = all.find((x) => x.id === id)!;
    const applied = applyTurnHook(ws, c.turns[Number(flags.turn ?? 2) - 1]);
    process.stdout.write(applied ? "Applied the user's change for this turn.\n" : "Nothing to apply for this turn.\n");
    return;
  }
  if (typeof flags.rerender === "string") {
    const root = resolve(flags.rerender);
    const { ws } = loadWorkspace(root);
    const r = rerenderLatest(ws);
    if (!r) throw new Error(`${root} has no sealed audit.`);
    const out = join(root, "rerender", String(flags.label ?? "current"));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "report.md"), renderMarkdown(r, loadRubric(r.audit.rubric)));
    writeJudgePrompts(out, r);
    process.stdout.write(`${out}\n`);
    return;
  }
  if (typeof flags.grade === "string") {
    const root = resolve(flags.grade);
    const { ws, id } = loadWorkspace(root);
    const c = all.find((x) => x.id === id)!;
    const t = externalTrajectory(root, Number(flags["wall-ms"] ?? 0));
    const gates = gradeCase(ws, t, c);
    const report = latestReport(ws);
    if (report) writeJudgePrompts(root, report);
    const h = readJudge(join(root, "headline.json"));
    const p = readJudge(join(root, "page.json"));
    const judgeModel = typeof flags["judge-model"] === "string" ? flags["judge-model"] : null;
    const run: CaseRun = { id, repeat: Number(flags.repeat ?? 1), model: String(flags.model ?? "external"), driver: "external", arm: "agent", judgeModel, rubric: report?.audit.rubric ?? null, isolation: "external: not controlled by the harness", workspace: ws.dir, grade: { gates, soft: { judge: h.score, judgeReasons: h.reasons, page: p.score, pageReasons: p.reasons, wallMs: t.durationMs, toolCalls: 0, tokens: null } }, error: null };
    writeFileSync(join(root, "result.json"), JSON.stringify({ run }, null, 2));
    for (const g of gates) process.stdout.write(`${g.pass ? "PASS" : "FAIL"}  ${g.name}: ${g.detail}\n`);
    return;
  }
  // Grades stored SDK runs again from their saved trajectories, for a grader fix with no new agent runs.
  if (typeof flags.regrade === "string") {
    const dir = resolve(flags.regrade);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".run.json"))) {
      const saved = JSON.parse(readFileSync(join(dir, f), "utf8")) as { run: CaseRun; trajectory?: Trajectory };
      const c = all.find((x) => x.id === saved.run.id);
      if (!c || !saved.trajectory || !saved.run.workspace) continue;
      const { ws } = loadWorkspace(dirname(saved.run.workspace));
      saved.run.grade.gates = gradeCase(ws, saved.trajectory, c);
      writeFileSync(join(dir, f), JSON.stringify(saved, null, 2));
    }
    const runs = collect(dir);
    process.exitCode = report(runs.filter((r) => (r.arm ?? "agent") === "agent"), flags, { model: String(flags.model ?? runs[0]?.model ?? DEFAULT_MODEL), driver: "sdk", repeats, holdout });
    return;
  }
  if (typeof flags.collect === "string") {
    process.exitCode = report(collect(resolve(flags.collect)), flags, { model: String(flags.model ?? "external"), driver: String(flags.driver ?? "external"), repeats, holdout });
    return;
  }
  const selected = select(all, flags);
  if (selected.length === 0) throw new Error("No cases match.");
  if (flags.prepare) {
    const manifest = [];
    for (const c of selected.filter((x) => !x.attack)) {
      for (let r = 1; r <= repeats; r++) {
        const ws = prepare(c);
        manifest.push({ id: c.id, repeat: r, root: dirname(ws.dir), dir: ws.dir, env: c.env ?? {}, prompts: c.turns.map((t, i) => (i === 0 ? externalPreamble(ws.dir) + skillPreamble(ws.dir) : "") + fillPrompt(t.prompt, ws)), turnHooks: c.turns.map((t) => Boolean(t.before)) });
      }
    }
    const out = typeof flags.out === "string" ? resolve(flags.out) : join(HERE, "runs", "prepared.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(manifest, null, 2));
    process.stdout.write(`Prepared ${manifest.length} workspaces. Manifest: ${out}\n`);
    return;
  }
  const scripted = selected.filter((c) => c.attack);
  let driven = selected.filter((c) => !c.attack);
  // The scripted control arm needs no key; the arms an agent drives do.
  let drivenArms = arms;
  if (driven.length && !process.env.CURSOR_API_KEY) {
    drivenArms = arms.filter((a) => a === "scripted");
    const skipped = arms.filter((a) => a !== "scripted");
    if (skipped.length) process.stdout.write(`CURSOR_API_KEY isn't set, so the ${skipped.join(" and ")} arm${skipped.length > 1 ? "s" : ""} of ${driven.length} cases ${skipped.length > 1 ? "are" : "is"} skipped${scripted.length ? `; running the ${scripted.length} scripted negative cases` : ""}. Add it as a secret to run them.\n`);
    if (!drivenArms.length) driven = [];
    if (!driven.length && !scripted.length) return;
  }
  // The model catalog is fetched once here and handed to every worker through the environment.
  if (driven.length && process.env.CURSOR_API_KEY) await modelCatalog(process.env.CURSOR_API_KEY);
  const judges = driven.length ? await pickJudges(flags, models[0]) : null;
  // Recorded before any run starts, so a change made while the runs go can't be passed off as measured.
  const binding = currentBinding();
  const maxRuns = Number(flags["max-runs"] ?? 120);
  // --max-runs bounds the worst case, in which every deterministic case falls back to every repeat.
  const worst = planJobs([...driven, ...scripted], drivenArms, models, repeats).length;
  if (worst > maxRuns) throw new Error(`${worst} runs exceed --max-runs ${maxRuns}.`);
  const probe = Number(flags["deterministic-repeats"] ?? DETERMINISTIC_REPEATS);
  if (!Number.isInteger(probe) || probe < 2) throw new Error(`--deterministic-repeats ${flags["deterministic-repeats"]} must be a whole number of 2 or more: one run can't show that runs match.`);
  const jobs = planJobs([...driven, ...scripted], drivenArms, models, repeats, probe);
  const outDir = join(HERE, "runs", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  const outOf = (j: Job) => join(outDir, `${j.c.id.replace(/\//g, "__")}.${j.arm}.${j.m}.${j.r}.run.json`);
  const concurrency = Number(flags.concurrency ?? 2);
  const retries = Number(flags["infra-retries"] ?? 2);
  const probed = new Map<string, Job[]>();
  const matched: string[] = [];
  const fellBack: string[] = [];
  const afterRun = (j: Job) => {
    if (probe >= repeats || !deterministic(j) || j.r > probe) return;
    const key = `${j.c.id} [${j.c.attack ? "negative" : j.arm}]`;
    const list = [...(probed.get(key) ?? []), j];
    probed.set(key, list);
    if (list.length < probe) return;
    const o = probeOutcome(list.map((x) => (JSON.parse(readFileSync(outOf(x), "utf8")) as { run: CaseRun }).run), probe);
    if (o.matched) return void matched.push(key);
    fellBack.push(`${key}: ${o.why}`);
    jobs.push(...restOf(j, probe, repeats));
  };
  let next = 0;
  // A case that falls back adds jobs after some workers may have finished, so drain until none are left.
  while (next < jobs.length) {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < jobs.length) {
          const j = jobs[next++];
          await spawnWorker(j, outOf(j), String(flags["timeout-min"] ?? 30), j.c.attack ? null : judges, retries);
          afterRun(j);
        }
      }),
    );
  }
  if (probed.size) {
    process.stdout.write(`Runs with no agent (the scripted arm and the negative cases): ${matched.length} of ${probed.size} cases matched byte for byte in ${probe} runs and stood for all ${repeats} repeats; ${fellBack.length} fell back to ${repeats}.\n`);
    for (const f of fellBack) process.stdout.write(`FELL BACK ${f}\n`);
  }
  const done = collect(outDir);
  // A run the API refused after every retry, or a judge call it refused, would leave a draw out of
  // the summary. The run fails, and no baseline is written from it.
  const refused = apiRefusals(done);
  for (const r of refused) process.stdout.write(`FAIL ${r}\n`);
  if (refused.length) {
    process.stdout.write(`FAIL ${refused.length} run${refused.length === 1 ? "" : "s"} lost a call the API kept refusing; rerun them. No baseline is written from this run.\n`);
    delete flags["write-baseline"];
  }
  const drivenIds = new Set(driven.map((c) => c.id));
  const of = (arm: Arm, m?: string) => done.filter((r) => drivenIds.has(r.id) && (r.arm ?? "agent") === arm && (!m || r.model === m));
  let code = 0;
  const controls = Object.fromEntries(CONTROL_ARMS.map((a) => [a, drivenArms.includes(a) ? of(a) : []])) as Record<Arm, CaseRun[]>;
  const selectedIds = driven.map((c) => c.id);
  const own = { judgeSamples: judges?.models.length ? judges.samples : null, binding };
  for (const m of drivenArms.includes("agent") ? models : []) code = report(of("agent", m), flags, { model: m, driver: "sdk", repeats, holdout, selected: selectedIds, ...own, controls: { "skill-off": controls["skill-off"].filter((r) => r.model === m), scripted: controls.scripted, "no-docker": controls["no-docker"].filter((r) => r.model === m) } }) || code;
  // Control arms alone (no agent arm) still print their own summary; the baseline is for the agent.
  if (!drivenArms.includes("agent")) {
    const { "write-baseline": _w, compare: _c, ...rest } = flags;
    for (const arm of drivenArms) code = report(of(arm), rest, { model: arm === "scripted" ? "scripted" : models[0], driver: arm === "scripted" ? "scripted" : "sdk", repeats, holdout, ...own }) || code;
  }
  // The baseline is for agent runs; a negative case fails the run by failing its gates.
  if (scripted.length) {
    const { "write-baseline": _w, compare: _c, ...rest } = flags;
    const own = driven.length ? Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "json" && k !== "junit")) : rest;
    code = report(done.filter((r) => !drivenIds.has(r.id)), own, { model: "scripted", driver: "scripted", repeats, holdout }) || code;
  }
  process.exitCode = refused.length ? Math.max(code, 1) : code;
}

main().catch((e: Error) => {
  process.stderr.write(`evals: ${e.message}\n`);
  process.exitCode = 1;
});
