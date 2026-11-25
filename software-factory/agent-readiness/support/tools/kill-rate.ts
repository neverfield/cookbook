import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { estimateRule, faultEstimate, faultsVerdict, keepPlanting } from "../../skill/agent-readiness/scripts/lib/mutate.ts";
import type { EstimateRule } from "../../skill/agent-readiness/scripts/lib/mutate.ts";
import { loadRubric } from "../../skill/agent-readiness/scripts/lib/rubric.ts";
import type { FaultEstimate, Mutant } from "../../skill/agent-readiness/scripts/lib/types.ts";
import { readiness } from "./fixture.ts";

// Calibrates the planted-fault kill rate on real repos. For each repo it reads every sealed audit,
// or with --seeds first audits it once per seed, and tabulates per component how many planted
// faults the tests caught. Then it shows, for each candidate rate, which components pass, and how
// often a component's verdict changes from one seed to the next: the noise a rate leaves in a level.
//
//   node --experimental-strip-types support/tools/kill-rate.ts <repo>... [--seeds a,b,c] [--rates 1,0.8,0.6] [--out file.json]
//   node --experimental-strip-types support/tools/kill-rate.ts --replay support/evals/calibration/kill-rate.json [--out file.json]
//
// The pinned trial checkouts (npm run trials) live in $SA_TRIALS_CACHE or $TMPDIR/agent-readiness-trials.

export interface Tally {
  repo: string;
  audit: string;
  component: string;
  caught: number;
  counted: number;
  missed: string[];
}

export function tallies(repo: string): Tally[] {
  const dir = join(repo, ".agent-readiness", "history", "audits");
  if (!existsSync(dir)) return [];
  const out: Tally[] = [];
  for (const id of readdirSync(dir).sort()) {
    const f = join(dir, id, "audit.json");
    if (!existsSync(f)) continue;
    const audit = JSON.parse(readFileSync(f, "utf8")) as { mutants?: Mutant[] };
    const by = new Map<string, Mutant[]>();
    for (const m of audit.mutants ?? []) by.set(m.component, [...(by.get(m.component) ?? []), m]);
    for (const [component, ms] of by) {
      const counted = ms.filter((m) => m.result === "caught" || m.result === "survived");
      out.push({ repo: basename(repo), audit: id, component, caught: counted.filter((m) => m.result === "caught").length, counted: counted.length, missed: ms.filter((m) => m.result === "survived").map((m) => `${m.operator} at ${m.file}:${m.line}`) });
    }
  }
  return out;
}

export interface RateRow {
  rate: number;
  // Component-audits that pass at this rate, of those with enough clear results.
  pass: number;
  decided: number;
  // Components whose verdict differs between two of their audits at this rate.
  unstable: string[];
}

export function rateTable(rows: Tally[], rates: number[], minForPass: number): RateRow[] {
  return rates.map((rate) => {
    const verdicts = new Map<string, Set<string>>();
    let pass = 0;
    let decided = 0;
    for (const t of rows) {
      const v = faultsVerdict(t.caught, t.counted, { minForPass, killRate: rate });
      if (v === "not_run") continue;
      decided++;
      if (v === "pass") pass++;
      const key = `${t.repo}/${t.component}`;
      verdicts.set(key, new Set([...(verdicts.get(key) ?? []), v]));
    }
    return { rate, pass, decided, unstable: [...verdicts].filter(([, s]) => s.size > 1).map(([k]) => k) };
  });
}

export interface EstimateRow {
  component: string;
  // One sequential estimate per starting draw: the component's draws taken in turn from that one,
  // each a batch, as plantFaults plants them, until the estimate is decided or the cap is reached.
  verdicts: FaultEstimate["verdict"][];
  decided: number[];
  // The 2026-11-beta verdict of each draw on its own, at its kill rate.
  killRate: ("pass" | "fail" | "not_run")[];
}

export function estimateTable(rows: Tally[], rule: EstimateRule, minForPass: number, killRate: number): EstimateRow[] {
  const by = new Map<string, Tally[]>();
  for (const t of rows) by.set(`${t.repo}/${t.component}`, [...(by.get(`${t.repo}/${t.component}`) ?? []), t]);
  return [...by].map(([component, draws]) => {
    const verdicts: FaultEstimate["verdict"][] = [];
    const decided: number[] = [];
    for (let start = 0; start < draws.length; start++) {
      let caught = 0;
      let counted = 0;
      let est = faultEstimate(0, 0, rule, minForPass);
      for (let i = 0; i < draws.length; i++) {
        const d = draws[(start + i) % draws.length];
        caught += d.caught;
        counted += d.counted;
        est = faultEstimate(caught, counted, rule, minForPass);
        if (!keepPlanting(est, rule)) break;
      }
      verdicts.push(est.verdict);
      decided.push(est.decided);
    }
    return { component, verdicts, decided, killRate: draws.map((d) => faultsVerdict(d.caught, d.counted, { minForPass, killRate })) };
  });
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

// --replay <kill-rate.json>: replays recorded draws under the rubric's sequential estimate, as batches.
function replay(file: string): void {
  const rubric = loadRubric();
  const rule = estimateRule(rubric.mutation);
  if (!rule) throw new Error(`rubric ${rubric.version} has no mutation.estimate`);
  const cal = JSON.parse(readFileSync(resolve(file), "utf8")) as { rubric: string; minForPass: number; rows: Tally[] };
  const killRate = loadRubric(cal.rubric).mutation.killRate ?? 1;
  const table = estimateTable(cal.rows, rule, rubric.mutation.minForPass, killRate);
  for (const r of table) process.stdout.write(`${r.component.padEnd(36)} estimate ${r.verdicts.join(" ")} (decided ${r.decided.join(", ")}); kill rate ${killRate} per draw ${r.killRate.join(" ")}\n`);
  const out = flag("out");
  if (out) writeFileSync(resolve(out), JSON.stringify({ rubric: rubric.version, from: { file: basename(file), rubric: cal.rubric, killRate }, rule, minForPass: rubric.mutation.minForPass, table }, null, 2) + "\n");
}

function main(): void {
  if (flag("replay")) return replay(flag("replay")!);
  const valued = new Set(["--seeds", "--rates", "--out"]);
  const repos = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !valued.has(all[i - 1] ?? "")).map((r) => resolve(r));
  if (!repos.length) throw new Error("name at least one audited repo");
  const seeds = (flag("seeds") ?? "").split(",").filter(Boolean);
  const rates = (flag("rates") ?? "1,0.8,0.6").split(",").map(Number);
  const rubric = loadRubric();
  for (const repo of repos) {
    for (const seed of seeds) {
      const r = readiness(repo, ["audit", "--tier", "local-exec"], { SA_READINESS_EVAL_SEED: seed, SA_READINESS_NOW: process.env.SA_READINESS_NOW ?? "2026-11-14T12:00:00Z" });
      process.stdout.write(`${basename(repo)} seed ${seed}: exit ${r.code}\n`);
    }
  }
  const rows = repos.flatMap(tallies);
  for (const t of rows) process.stdout.write(`${`${t.repo}/${t.component}`.padEnd(40)} ${t.audit.padEnd(36)} caught ${t.caught} of ${t.counted}${t.missed.length ? `; missed ${t.missed.join(", ")}` : ""}\n`);
  const table = rateTable(rows, rates, rubric.mutation.minForPass);
  for (const r of table) process.stdout.write(`kill rate ${r.rate}: ${r.pass} of ${r.decided} component audits pass; verdict changes between audits in ${r.unstable.length ? r.unstable.join(", ") : "none"}\n`);
  const out = flag("out");
  if (out) writeFileSync(resolve(out), JSON.stringify({ rubric: rubric.version, minForPass: rubric.mutation.minForPass, perComponent: rubric.mutation.perComponent, rows, table }, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("kill-rate.ts")) main();
