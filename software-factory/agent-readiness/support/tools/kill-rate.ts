import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { faultsVerdict } from "../../skill/agent-readiness/scripts/lib/mutate.ts";
import { loadRubric } from "../../skill/agent-readiness/scripts/lib/rubric.ts";
import type { Mutant } from "../../skill/agent-readiness/scripts/lib/types.ts";
import { readiness } from "./fixture.ts";

// Calibrates the planted-fault kill rate on real repos. For each repo it reads every sealed audit,
// or with --seeds first audits it once per seed, and tabulates per component how many planted
// faults the tests caught. Then it shows, for each candidate rate, which components pass, and how
// often a component's verdict changes from one seed to the next: the noise a rate leaves in a level.
//
//   node --experimental-strip-types support/tools/kill-rate.ts <repo>... [--seeds a,b,c] [--rates 1,0.8,0.6] [--out file.json]
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

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

function main(): void {
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
