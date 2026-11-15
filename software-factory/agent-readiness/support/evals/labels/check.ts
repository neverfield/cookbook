import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReportJson } from "../../../skill/agent-readiness/scripts/lib/types.ts";
import { auditFixture, expected } from "../../tools/fixture.ts";
import { PANEL_SAMPLES, availableModels, chooseJudges, family, judge, judgePromptDigest, panelScore } from "../lib/judge.ts";
import type { JudgeResult } from "../lib/judge.ts";
import { modelCatalog } from "../lib/api.ts";
import type { Calibration } from "../lib/release.ts";
import { EVAL_SEED } from "../lib/workspace.ts";
import { FAIL_AT, HERE, LABELS, PASS_AT, agrees, labelPrompt, labelReport, trimReport } from "./labels.ts";
import type { Label } from "./labels.ts";

// npm run labels -- [mode]
//   --snapshot [--golden-dir <kept slugify clone>]  re-audit the base fixtures (needs Docker) and refresh base/
//   --write                                         regenerate labels.json from labels.ts
//   --prompts <dir>                                 write each label's judge prompt, for judging by hand or by subagents
//   --scores <file.json>                            grade scores judged elsewhere: { "<label id>": { "<model>": [0.7, 0.8, ...] } }
//                                                   (or { "<label id>": [0.7, 0.8] } for one judge)
//   (default)                                       judge every label with the release's judge panel: two models of other
//                                                   families than the driver, each called 2 x --samples times per label, so
//                                                   two independent panel scores give the panel's repeat noise
//     --driver <model> (default: the baseline's driver)  --judge-model <a>,<b>  --samples <n> (default 3)  --out <file>

const FIXTURE_BASES = ["healthy-node", "hidden-service", "tautological-tests", "monorepo-mixed", "nested-apps-dotnet"];

function flag(name: string): string | true | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

function writeBase(name: string, r: ReportJson): void {
  mkdirSync(join(HERE, "base"), { recursive: true });
  writeFileSync(join(HERE, "base", `${name}.json`), JSON.stringify(trimReport(r), null, 1) + "\n");
  process.stdout.write(`base/${name}.json: ${r.executive.heading}\n`);
}

export function labelsJson(): string {
  return JSON.stringify({ passAt: PASS_AT, failAt: FAIL_AT, judgePrompt: judgePromptDigest(), labels: LABELS }, null, 2) + "\n";
}

interface Scored {
  label: Label;
  scores: number[];
}

// Every call of every judge on one label, in call order.
interface PanelScored {
  label: Label;
  calls: Record<string, number[]>;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const r2 = (x: number) => Math.round(x * 100) / 100;

// How well the scores separate the labels: agreement with each label's verdict, the chance a
// known-good label outscores a broken one (AUC), and each label's run-to-run spread.
export function agreement(scored: Scored[]): { agree: number; total: number; auc: number | null; rows: string[] } {
  const rows: string[] = [];
  let agree = 0;
  let total = 0;
  for (const s of scored) {
    if (!s.scores.length) {
      rows.push(`${s.label.id.padEnd(36)} ${s.label.expected.padEnd(5)} no score`);
      continue;
    }
    const m = mean(s.scores);
    const ok = agrees(s.label, m);
    total++;
    if (ok) agree++;
    rows.push(`${s.label.id.padEnd(36)} ${s.label.expected.padEnd(5)} mean ${r2(m).toFixed(2)} range ${r2(Math.max(...s.scores) - Math.min(...s.scores)).toFixed(2)} ${ok ? "agrees" : "DISAGREES"}  [${s.scores.join(", ")}]`);
  }
  const good = scored.filter((s) => s.label.expected === "pass" && s.scores.length).map((s) => mean(s.scores));
  const bad = scored.filter((s) => s.label.expected === "fail" && s.scores.length).map((s) => mean(s.scores));
  let wins = 0;
  for (const g of good) for (const b of bad) wins += g > b ? 1 : g === b ? 0.5 : 0;
  return { agree, total, auc: good.length && bad.length ? r2(wins / (good.length * bad.length)) : null, rows };
}

const asResults = (xs: number[]): JudgeResult[] => xs.map((score) => ({ score, reasons: [] }));
const mad = (pairs: [number, number][]) => (pairs.length ? r2(mean(pairs.map(([a, b]) => Math.abs(a - b)))) : null);

// The panel as a release uses it: each judge's median over `samples` calls, then the mean over
// judges. Each label's calls split into two halves give two independent panel scores; agreement
// counts both, and their spread is the panel's repeat noise, next to one call's against another's.
export function panelCalibration(scored: PanelScored[], samples: number): { calibration: Omit<Calibration, "ranAt" | "judgePrompt">; rows: string[]; panels: Record<string, number[]> } {
  const models = [...new Set(scored.flatMap((s) => Object.keys(s.calls)))].sort();
  const panels: Record<string, number[]> = {};
  const draws: Scored[] = [];
  const singles: [number, number][] = [];
  const panelPairs: [number, number][] = [];
  for (const s of scored) {
    const halves = [0, 1].map((h) => panelScore(Object.fromEntries(models.map((m) => [m, asResults((s.calls[m] ?? []).slice(h * samples, (h + 1) * samples))]))).score).filter((x): x is number => x !== null);
    panels[s.label.id] = halves;
    draws.push({ label: s.label, scores: halves });
    if (halves.length === 2) panelPairs.push([halves[0], halves[1]]);
    for (const m of models) {
      const c = s.calls[m] ?? [];
      if (c.length >= 2) singles.push([c[0], c[1]]);
    }
  }
  const byDraw = draws.flatMap((d) => d.scores.map((x) => ({ label: d.label, scores: [x] })));
  const a = agreement(byDraw);
  const auc = agreement(draws).auc;
  return { calibration: { models, samples, agree: a.agree, total: a.total, auc, noise: { single: mad(singles), panel: mad(panelPairs) } }, rows: agreement(draws).rows, panels };
}

function writePanel(scored: PanelScored[], samples: number, out: string | null): void {
  const { calibration: c, rows, panels } = panelCalibration(scored, samples);
  for (const row of rows) process.stdout.write(row + "\n");
  process.stdout.write(`Panel ${c.models.join(" + ")}, median of ${samples} calls each: agrees with ${c.agree} of ${c.total} panel scores; good-versus-broken AUC ${c.auc ?? "n/a"}; repeat noise ${c.noise?.panel ?? "n/a"} for the panel, ${c.noise?.single ?? "n/a"} for one call.\n`);
  if (out) {
    const file: Calibration & { labels: unknown[] } = { ranAt: new Date().toISOString(), judgePrompt: judgePromptDigest(), ...c, labels: scored.map((s) => ({ id: s.label.id, expected: s.label.expected, calls: s.calls, panel: panels[s.label.id] })) };
    writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
  }
}

async function main(): Promise<void> {
  if (flag("snapshot")) {
    for (const f of FIXTURE_BASES) {
      const run = expected(f).runs[0];
      const a = auditFixture(f, run, { seed: EVAL_SEED });
      if (a.code !== 0) throw new Error(`${f}: audit failed: ${a.out.slice(-400)}`);
      if (a.report.maturity.level !== run.level) throw new Error(`${f}: Level ${a.report.maturity.level}, but expected.json says ${run.level}; a base report must match its fixture`);
      writeBase(f, a.report as ReportJson);
    }
    const golden = flag("golden-dir");
    if (typeof golden === "string") writeBase("slugify", JSON.parse(readFileSync(join(resolve(golden), ".agent-readiness/latest/report.json"), "utf8")) as ReportJson);
    return;
  }
  if (flag("write")) {
    writeFileSync(join(HERE, "labels.json"), labelsJson());
    process.stdout.write(`labels.json: ${LABELS.length} labels\n`);
    return;
  }
  const prompts = flag("prompts");
  if (typeof prompts === "string") {
    mkdirSync(resolve(prompts), { recursive: true });
    for (const l of LABELS) writeFileSync(join(resolve(prompts), `${l.id}.txt`), labelPrompt(l));
    process.stdout.write(`Wrote ${LABELS.length} prompts to ${resolve(prompts)}. Judge each one on its own, then pass the scores with --scores.\n`);
    return;
  }
  const out = typeof flag("out") === "string" ? resolve(flag("out") as string) : join(HERE, "last-check.json");
  const samples = Number(flag("samples") ?? PANEL_SAMPLES);
  const scoresFile = flag("scores");
  if (typeof scoresFile === "string") {
    const given = JSON.parse(readFileSync(resolve(scoresFile), "utf8")) as Record<string, number[] | Record<string, number[]>>;
    const one = String(flag("judge-model") ?? "external");
    writePanel(LABELS.map((label) => {
      const g = given[label.id];
      return { label, calls: Array.isArray(g) ? { [one]: g } : (g ?? {}) };
    }), samples, null);
    return;
  }
  const key = process.env.CURSOR_API_KEY;
  if (!key) throw new Error("CURSOR_API_KEY isn't set. Use --prompts to judge the labels some other way, then --scores.");
  const baseline = join(HERE, "..", "baseline.json");
  const driver = typeof flag("driver") === "string" ? (flag("driver") as string) : existsSync(baseline) ? ((JSON.parse(readFileSync(baseline, "utf8")) as { instrument?: { driverModel: string }; model?: string }).instrument?.driverModel ?? (JSON.parse(readFileSync(baseline, "utf8")) as { model?: string }).model ?? "claude-opus-5-5") : "claude-opus-5-5";
  const explicit = typeof flag("judge-model") === "string" ? (flag("judge-model") as string).split(",").filter(Boolean) : [];
  await modelCatalog(key);
  const choices = chooseJudges(driver, explicit.length ? [] : await availableModels(key), explicit);
  for (const c of choices) process.stdout.write(`Judge: ${c.model} (${c.why}); driver family ${family(driver)}.\n`);
  const { scored, missing, calls } = await judgeLabels(LABELS, choices.map((c) => c.model), samples, key);
  if (missing.length) {
    for (const m of missing) process.stdout.write(`NO SCORE ${m}\n`);
    throw new Error(`${missing.length} of ${calls} judge calls gave no score, so the calibration would be missing draws; last-check.json was not written. Rerun once the cause above is fixed.`);
  }
  writePanel(scored, samples, out);
}

// Every label judged 2 x samples times by each model. The calls go through the shared API limiter
// and its retries (lib/api.ts); one still refused after them rejects the whole check. A call that
// returns no score is listed in `missing`, so the caller can refuse to record a calibration with a
// draw left out.
export async function judgeLabels(labels: Label[], models: string[], samples: number, key: string): Promise<{ scored: PanelScored[]; missing: string[]; calls: number }> {
  const scored: PanelScored[] = [];
  const missing: string[] = [];
  let calls = 0;
  for (const label of labels) {
    const byModel: Record<string, number[]> = {};
    await Promise.all(models.map(async (model) => {
      const results = await Promise.all(Array.from({ length: 2 * samples }, () => judge(label.judge, labelReport(label), model, key)));
      calls += results.length;
      byModel[model] = results.filter((j) => j.score !== null).map((j) => j.score as number);
      for (const j of results.filter((x) => x.score === null)) missing.push(`${label.id} (${model}): ${j.reasons.join("; ")}`);
    }));
    scored.push({ label, calls: byModel });
  }
  return { scored, missing, calls };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(HERE, "check.ts")) {
  main().catch((e: Error) => {
    process.stderr.write(`labels: ${e.message}\n`);
    process.exitCode = 1;
  });
}
