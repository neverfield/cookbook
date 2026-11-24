import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POOLED_FLOOR } from "./baseline.ts";
import type { Baseline } from "./baseline.ts";
import { bindingProblems } from "./binding.ts";
import type { Binding } from "./binding.ts";
import { PANEL_SIZE, family } from "./judge.ts";

// The release-gate policy (November 15, 2026, for 0.2.0):
// - Hard gates, k of n per case at 5 repeats or more: a case one run short of passing every gate
//   in every repeat is a flag; two or more runs short is a regression, and fails the release. At most
//   a tenth of the in-sample cases may be flagged, and the pooled all-gates pass rate's 95% lower
//   bound must reach the floor.
// - Lift: the agent must beat the scripted run (`readiness audit` alone) on the same cases. The
//   per-case all-gates lift and the headline judge's lift each need a 95% bootstrap interval (over
//   cases) whose lower bound is above 0. If the agent's narration shows no lift on the pinned repos,
//   narrationLift goes to false and the headline lift is reported only; the judges are not retuned.
// - Headline judge: pooled mean at least 0.8 and lower bound at least 0.75. Page judge: pooled
//   mean above 0.667, run 6's.
// - Judges: a panel of at least two models, of other families than the driver and each other,
//   calibrated on the label set with the same judge prompt.
// - Binding: the run names its commit, started from a clean tree, and its code digests match the
//   code checked out at the release check.
export const RELEASE_POLICY = {
  repeats: 5,
  judgeMean: 0.8,
  judgeLower: 0.75,
  pageAbove: 0.667,
  pooledFloor: POOLED_FLOOR,
  maxFlagShare: 0.1,
  liftOver: "scripted",
  narrationLift: true,
  judges: PANEL_SIZE,
  calibration: { agree: 0.8, auc: 0.9 },
} as const;

// The label-set check (labels/check.ts) for the judges a release uses.
export interface Calibration {
  ranAt: string;
  judgePrompt: string;
  models: string[];
  samples: number;
  agree: number;
  total: number;
  auc: number | null;
  // Mean absolute difference between two independent scores of one label: one call against
  // another, and one panel score against another.
  noise?: { single: number | null; panel: number | null };
}

export const CALIBRATION_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "labels", "last-check.json");

// Reads a label-set check. One written before the panel names a single judge and one call per label.
export function loadCalibration(file = CALIBRATION_FILE): Calibration | null {
  if (!existsSync(file)) return null;
  const c = JSON.parse(readFileSync(file, "utf8")) as Partial<Calibration> & { judgeModel?: string };
  if (typeof c.judgePrompt !== "string" || typeof c.agree !== "number" || typeof c.total !== "number") return null;
  return { ranAt: c.ranAt ?? "", judgePrompt: c.judgePrompt, models: c.models ?? (c.judgeModel ? [c.judgeModel] : []), samples: c.samples ?? 1, agree: c.agree, total: c.total, auc: c.auc ?? null, ...(c.noise ? { noise: c.noise } : {}) };
}

export interface ReleaseContext {
  // The code checked out now; null when it can't be read, which fails the release.
  binding?: Binding | null;
  calibration?: Calibration | null;
}

export interface CaseVerdict {
  id: string;
  passed: number;
  usable: number;
  short: number;
  verdict: "ok" | "flag" | "regression";
  holdout: boolean;
}

export interface ReleaseVerdict {
  pass: boolean;
  // One line per finding, ending with the verdict line.
  lines: string[];
  cases: CaseVerdict[];
  // Cases that passed every gate in every repeat, reported only.
  strict: string;
  judge: { mean: number | null; low: number | null; high: number | null; pass: boolean };
  page: { mean: number | null; low: number | null; high: number | null };
  lift: { gates: { mean: number | null; low: number | null }; judge: { mean: number | null; low: number | null } } | null;
}

// How many of the cases that pull the headline judge lift down the release check names.
export const LIFT_DRAG_SHOWN = 8;

const counts = (s: string) => s.split("/").map(Number) as [number, number];
const signed = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${x}`);
const ci = (x: { mean: number | null; low: number | null; high: number | null }) => `${signed(x.mean)} (95% CI ${x.low ?? "n/a"} to ${x.high ?? "n/a"})`;

export function caseVerdicts(b: Baseline): CaseVerdict[] {
  return Object.entries(b.cases).map(([id, c]) => {
    const [passed, usable] = counts(c.allGatesPass);
    const short = usable - passed;
    return { id, passed, usable, short, verdict: usable === 0 || short >= 2 ? "regression" : short === 1 ? "flag" : "ok", holdout: Boolean(c.holdout) };
  });
}

export function maxFlags(cases: number): number {
  return Math.max(1, Math.floor(RELEASE_POLICY.maxFlagShare * cases));
}

function judgeLines(b: Baseline, ctx: ReleaseContext, fail: (why: string) => void, ok: (what: string) => void): void {
  const models = (b.instrument.judgeModel ?? "").split(",").filter(Boolean);
  const families = new Set(models.map(family));
  const driver = family(b.instrument.driverModel);
  if (models.length < RELEASE_POLICY.judges) fail(`${models.length} judge model${models.length === 1 ? "" : "s"} (${models.join(", ") || "none"}); the policy needs a panel of ${RELEASE_POLICY.judges}`);
  else if (families.size < models.length || families.has(driver)) fail(`the judges ${models.join(", ")} must each be of another family than the driver (${driver}) and each other`);
  else ok(`judge panel ${models.join(", ")}, ${b.instrument.judgeSamples ?? 1} call${b.instrument.judgeSamples === 1 ? "" : "s"} each, median per judge`);
  const cal = ctx.calibration;
  if (!cal) return fail("no judge calibration on the label set; run `npm run labels -- --judge-model <a>,<b>`");
  const same = cal.models.length === models.length && cal.models.every((m) => models.includes(m));
  if (!same) return fail(`the judges were calibrated as ${cal.models.join(", ")}, but the run used ${models.join(", ") || "none"}`);
  if (cal.judgePrompt !== b.instrument.judgePrompt) return fail(`the calibration's judge prompt ${cal.judgePrompt} isn't the run's ${b.instrument.judgePrompt ?? "none"}`);
  const line = `judge calibration (${cal.ranAt.slice(0, 10)}): agrees with ${cal.agree} of ${cal.total} labels (needs ${RELEASE_POLICY.calibration.agree * 100}%), good-versus-broken AUC ${cal.auc ?? "n/a"} (needs ${RELEASE_POLICY.calibration.auc})${cal.noise ? `; repeat noise ${cal.noise.panel ?? "n/a"} for the panel, ${cal.noise.single ?? "n/a"} for one call` : ""}`;
  if (cal.total > 0 && cal.agree / cal.total >= RELEASE_POLICY.calibration.agree && (cal.auc ?? 0) >= RELEASE_POLICY.calibration.auc) ok(line);
  else fail(line);
}

export function releaseVerdict(b: Baseline, ctx: ReleaseContext = {}): ReleaseVerdict {
  const lines: string[] = [];
  const fail = (why: string) => lines.push(`FAIL ${why}`);
  const ok = (what: string) => lines.push(`OK ${what}`);
  const cases = caseVerdicts(b);
  if (b.repeats < RELEASE_POLICY.repeats) fail(`the run has ${b.repeats} repeats; the policy needs ${RELEASE_POLICY.repeats}`);
  // Binding: the run names the code it measured, and that code is what is checked out now.
  if (ctx.binding) {
    const problems = bindingProblems(b.binding, ctx.binding);
    for (const p of problems) fail(p);
    if (!problems.length) ok(`bound to commit ${b.binding!.commit}: scripts ${b.binding!.scripts}, rubric ${b.binding!.rubric}, evals ${b.binding!.evals}`);
  } else fail("the code checked out now couldn't be read, so the run can't be bound to it");
  for (const c of cases.filter((x) => x.verdict === "regression")) fail(`${c.id}${c.holdout ? " (held out)" : ""}: ${c.usable === 0 ? "no usable run" : `${c.passed}/${c.usable} runs pass every gate, ${c.short} short`}`);
  for (const c of cases.filter((x) => x.verdict === "flag")) lines.push(`FLAG ${c.id}${c.holdout ? " (held out)" : ""}: ${c.passed}/${c.usable} runs pass every gate, 1 short`);
  for (const [id, c] of Object.entries(b.cases)) if (c.infraLost) lines.push(`NOTE ${id}: ${c.infraLost} of ${c.runs} runs lost to infrastructure, left out`);
  const inSample = cases.filter((c) => !c.holdout);
  const flags = cases.filter((c) => c.verdict === "flag").length;
  const regressions = cases.filter((c) => c.verdict === "regression").length;
  const cap = maxFlags(inSample.length);
  if (flags > cap) fail(`${flags} cases flagged; the policy allows ${cap} (a tenth of ${inSample.length} cases)`);
  const pooled = b.totals.pooled;
  const pooledLine = `pooled all-gates pass rate ${pooled.passed}/${pooled.runs}, 95% CI ${pooled.lower ?? "n/a"} to ${pooled.upper ?? "n/a"} (lower bound needs ${RELEASE_POLICY.pooledFloor})`;
  if (pooled.lower !== null && pooled.lower >= RELEASE_POLICY.pooledFloor) ok(pooledLine);
  else fail(pooledLine);
  // Lift over the scripted run.
  const control = b.controls?.[RELEASE_POLICY.liftOver];
  let lift: ReleaseVerdict["lift"] = null;
  if (!control) fail(`the run has no ${RELEASE_POLICY.liftOver} control arm to measure the agent's lift over; run it with --arm agent,${RELEASE_POLICY.liftOver}`);
  else {
    const g = control.lift.gates;
    const h = control.lift.judge;
    lift = { gates: { mean: g?.mean ?? null, low: g?.low ?? null }, judge: { mean: h.mean, low: h.low } };
    if (!g) fail(`the ${RELEASE_POLICY.liftOver} lift has no per-case interval for the hard gates; re-summarize the run with this harness`);
    else {
      const gl = `all-gates lift over the ${RELEASE_POLICY.liftOver} run ${ci(g)} per case, over ${g.n} cases (lower bound needs to be above 0)`;
      if (g.low !== null && g.low > 0) ok(gl);
      else fail(gl);
    }
    const hl = `headline judge lift over the ${RELEASE_POLICY.liftOver} run ${ci(h)} per case`;
    if (!RELEASE_POLICY.narrationLift) lines.push(`REPORT ${hl} (narration is outside the gate)`);
    else if (h.low !== null && h.low > 0) ok(`${hl} (lower bound needs to be above 0)`);
    else fail(`${hl} (lower bound needs to be above 0)`);
    const drag = (control.lift.judgeByCase ?? []).filter((d) => d.diff < 0).slice(0, LIFT_DRAG_SHOWN);
    if (drag.length) lines.push(`REPORT headline judge lift by case, most negative first: ${drag.map((d) => `${d.id} ${d.diff} (agent ${d.agent}, ${RELEASE_POLICY.liftOver} ${d.control})`).join("; ")}`);
    else if (!control.lift.judgeByCase) lines.push(`REPORT headline judge lift by case: not recorded in this run; re-summarize it with this harness`);
    lines.push(`REPORT page judge lift over the ${RELEASE_POLICY.liftOver} run ${ci(control.lift.page)} (not a release criterion)`);
  }
  // Judges.
  const j = b.totals.judge;
  const judgePass = j.mean !== null && j.low !== null && j.mean >= RELEASE_POLICY.judgeMean && j.low >= RELEASE_POLICY.judgeLower;
  const judgeLine = `headline judge pooled mean ${j.mean ?? "n/a"} (needs ${RELEASE_POLICY.judgeMean}), 95% CI ${j.low ?? "n/a"} to ${j.high ?? "n/a"}, lower bound ${j.low ?? "n/a"} (needs ${RELEASE_POLICY.judgeLower}), over ${j.n} in-sample runs`;
  if (judgePass) ok(judgeLine);
  else fail(j.n === 0 ? "the headline judge scored no run" : judgeLine);
  const p = b.totals.page;
  const pageLine = `page judge pooled mean ${p.mean ?? "n/a"} (needs to be above ${RELEASE_POLICY.pageAbove}), 95% CI ${p.low ?? "n/a"} to ${p.high ?? "n/a"}`;
  if (p.mean !== null && p.mean > RELEASE_POLICY.pageAbove) ok(pageLine);
  else fail(p.n === 0 ? "the page judge scored no run" : pageLine);
  judgeLines(b, ctx, fail, ok);
  for (const [arm, v] of Object.entries(b.controls ?? {})) if (arm !== RELEASE_POLICY.liftOver) lines.push(`REPORT ${arm} arm: pooled ${v!.totals.pooled.passed}/${v!.totals.pooled.runs} runs pass every gate; headline judge ${v!.totals.judge.mean ?? "n/a"} (not a release criterion)`);
  const strictN = cases.filter((c) => c.usable > 0 && c.short === 0).length;
  const strict = `${strictN}/${cases.length}`;
  lines.push(`REPORT hard gates, k of n: ${cases.length - flags - regressions} cases clean, ${flags} flagged (1 short), ${regressions} regressed (2 or more short); every gate in every repeat: ${strict} cases (not a release criterion)`);
  const pass = !lines.some((l) => l.startsWith("FAIL "));
  lines.push(`RELEASE ${pass ? "PASS" : "FAIL"}`);
  return { pass, lines, cases, strict, judge: { mean: j.mean, low: j.low, high: j.high, pass: judgePass }, page: { mean: p.mean, low: p.low, high: p.high }, lift };
}

// What a release pass records: the commit and digests it passed on, and the numbers behind it.
export interface ReleaseRecord {
  schema: "agent-readiness/release-record@1";
  checkedAt: string;
  verdict: "PASS" | "FAIL";
  binding: Binding | null;
  instrument: Baseline["instrument"];
  repeats: number;
  recordedAt: string;
  lines: string[];
}

export function releaseRecord(b: Baseline, v: ReleaseVerdict, checkedAt: string): ReleaseRecord {
  return { schema: "agent-readiness/release-record@1", checkedAt, verdict: v.pass ? "PASS" : "FAIL", binding: b.binding ?? null, instrument: b.instrument, repeats: b.repeats, recordedAt: b.recordedAt, lines: v.lines };
}
