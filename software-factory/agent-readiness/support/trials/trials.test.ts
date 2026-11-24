import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { afterAudit, observe as observeTruth } from "../holdout/observe.ts";
import { CRITICAL, scoreRepo } from "../holdout/score.ts";
import type { RepoScore, Truth } from "../holdout/score.ts";
import { guards } from "../tools/known-failures.ts";
import { detectRuntime } from "../../skill/agent-readiness/scripts/lib/container.ts";
import { headlineCauseErrors } from "../../skill/agent-readiness/scripts/lib/render.ts";
import type { ReportJson } from "../../skill/agent-readiness/scripts/lib/types.ts";
import { readiness, SKILL, SUPPORT } from "../tools/fixture.ts";

// Real public repos pinned at the commits the Nov 14 reviews and Nov 24 sims audited. Each run's
// observed summary must match the one recorded for it, and its false instruction findings may never
// rise above the recorded ceiling. A change on purpose is re-recorded with SA_TRIALS_RECORD=1 and
// explained in the PR. Each trial also has truth written from the repo and its CI (truth/<id>.json, in
// the holdout's schema), scored by the holdout's scorer on every run: one guard per critical event and
// per rate a container run measures. A guard the tool doesn't meet yet is in tests/known-failures.json.
const guard = guards(import.meta.url);
const TRUTH_RATES = ["R1", "R2", "R3", "R6"] as const;

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
  // Instruction items, as file:line, that are genuinely wrong. Every other failing item is a false finding.
  realInstructionFindings: string[];
  falseInstructionFindings: number;
  recorded: Partial<Record<"any" | "open" | "restricted", Observed>>;
}

interface TrialsFile {
  now: string;
  seed: string;
  trials: Trial[];
}

const FILE = join(SUPPORT, "trials", "trials.json");
const spec = JSON.parse(readFileSync(FILE, "utf8")) as TrialsFile;
const CACHE = process.env.SA_TRIALS_CACHE || join(tmpdir(), "agent-readiness-trials");
const RECORD = process.env.SA_TRIALS_RECORD === "1";
const ONLY = (process.env.SA_TRIALS_ONLY ?? "").split(",").filter(Boolean);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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

const trials = spec.trials.filter((t) => ONLY.length === 0 || ONLY.includes(t.id));
const runtime = detectRuntime("docker");

interface TrialRun {
  key: "any" | "open" | "restricted";
  blocked: string[];
  code: number;
  out: string;
  repo: string;
  o: Observed;
  score: RepoScore;
}

function truthOf(t: Trial): Truth {
  return JSON.parse(readFileSync(join(SUPPORT, "trials", "truth", `${t.id}.json`), "utf8")) as Truth;
}

async function auditTrial(t: Trial): Promise<TrialRun> {
  const blocked: string[] = [];
  for (const h of t.egress ?? []) if (!(await probe(h))) blocked.push(h);
  const key = !t.egress?.length ? "any" : blocked.length ? "restricted" : "open";
  const repo = checkout(t);
  const tmp = join(CACHE, "tmp", t.id);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const env: Record<string, string> = { SA_READINESS_EVAL_SEED: spec.seed, SA_READINESS_NOW: t.now ?? spec.now, SA_READINESS_RUNTIME: t.runtime, TMPDIR: tmp };
  if (t.runtime === "none") env.PATH = noRuntimePath();
  // Copied into the repo and run from there, as the quickstart has a customer do, so the repo's
  // own package.json (such as "type": "commonjs") applies to the scripts.
  const skill = join(repo, ".cursor", "skills", "agent-readiness");
  cpSync(SKILL, skill, { recursive: true });
  const r = readiness(repo, ["audit", "--tier", "local-exec"], env, join(skill, "scripts", "readiness.ts"));
  const after = afterAudit(repo, { tmp, containers: `-${t.commit.slice(0, 7)}-`, ignore: [".cursor/skills/agent-readiness/"] });
  const score = scoreRepo(truthOf(t), observeTruth(repo, { exit: r.code, after }));
  return { key, blocked, code: r.code, out: r.out, repo, o: observe(repo, r.code), score };
}

describe("pinned trial repos", { concurrency: 2 }, () => {
  before(async () => {
    await Promise.all(trials.flatMap((t) => t.egress ?? []).map(probe));
  });
  for (const t of trials) {
    const skip = t.runtime === "docker" && !runtime ? "no docker: this trial runs in a container" : false;
    describe(`${t.id} (${t.repo}@${t.commit.slice(0, 7)}, ${t.runtime === "docker" ? "docker" : "no container runtime"})`, { skip }, () => {
      let run: TrialRun;
      before(async () => {
        run = await auditTrial(t);
      }, { timeout: 30 * 60_000 });
      test(`${t.id} matches its recording`, (ctx) => {
        const { key, blocked, code, out, repo, o } = run;
        const ff = falseFindings(t, o);
        ctx.diagnostic(`observed (${key}${blocked.length ? `, blocked: ${blocked.join(", ")}` : ""}): ${JSON.stringify(o)}`);
        ctx.diagnostic(`headline: ${o.headline}`);
        ctx.diagnostic(`false instruction findings: ${ff.length} (ceiling ${t.falseInstructionFindings})`);
        ctx.diagnostic(`against its truth: ${JSON.stringify(run.score.classes)}`);
        if (!o.sealed) ctx.diagnostic(`not sealed, output ends: ${out.trim().split("\n").slice(-5).join(" | ")}`);
        for (const line of unsettled(repo)) ctx.diagnostic(line);
        if (RECORD) {
          const file = JSON.parse(readFileSync(FILE, "utf8")) as TrialsFile;
          const entry = file.trials.find((x) => x.id === t.id)!;
          entry.recorded[key] = o;
          entry.falseInstructionFindings = ff.length;
          writeFileSync(FILE, JSON.stringify(file, null, 2) + "\n");
          return;
        }
        assert.ok(o.sealed || t.recorded[key]?.sealed === false, `the audit didn't seal (exit ${code}):\n${out.slice(-3000)}`);
        const wrongCauses = headlineErrors(repo);
        assert.deepEqual(wrongCauses, [], `${t.id}'s headline names a cause its own conditions contradict: ${o.headline}`);
        assert.ok(ff.length <= t.falseInstructionFindings, `${ff.length} false instruction findings, above the recorded ${t.falseInstructionFindings}: ${ff.join(", ")}`);
        const want = t.recorded[key];
        assert.ok(want, `no result recorded for the "${key}" network; run with SA_TRIALS_RECORD=1 and commit trials.json`);
        const { instructionFailures: _a, headline: gotHeadline, ...got } = o;
        const { instructionFailures: _b, headline: wantHeadline, ...exp } = want;
        if (wantHeadline !== undefined) assert.equal(gotHeadline, wantHeadline, `${t.id}'s headline changed from its recorded one; if that is intended, re-record it and say why in the PR`);
        assert.deepEqual(got, exp, `${t.id} changed from its recorded result; if that is intended, re-record it and say why in the PR`);
      });
      for (const k of CRITICAL.filter((c) => c !== "K7")) {
        guard(`${t.id} truth ${k}`, () => assert.equal(run.score.critical[k], 0, `${k}: ${run.score.critical[k]} event(s); classes ${JSON.stringify(run.score.classes)}`));
      }
      for (const r of TRUTH_RATES) {
        guard(`${t.id} truth ${r}`, () => {
          const n = run.score.rates[r];
          assert.equal(n.hit, n.of, `${r}: ${n.hit} of ${n.of}; classes ${JSON.stringify(run.score.classes)}`);
        });
      }
    });
  }
});
