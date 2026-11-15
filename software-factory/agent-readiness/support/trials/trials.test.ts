import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { detectRuntime } from "../../skill/agent-readiness/scripts/lib/container.ts";
import { readiness, SKILL, SUPPORT } from "../tools/fixture.ts";

// Real public repos pinned at the commits the Nov 14 reviews audited. Each run's observed summary must
// match the one recorded for it, and its false instruction findings may never rise above the recorded
// ceiling. A change on purpose is re-recorded with SA_TRIALS_RECORD=1 and explained in the PR.
// SA_TRIALS_TARGET=1 also asserts each trial's target, the correct answer the later waves work towards.

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
}

interface Target {
  sealed?: boolean;
  runtime?: string | null;
  outcome?: string;
  minLevel?: number;
  unproven?: boolean;
  components?: Record<string, { minLevel?: number; unproven?: boolean }>;
  falseInstructionFindings?: number;
  blockingSafety?: number;
}

interface Trial {
  id: string;
  repo: string;
  commit: string;
  runtime: "docker" | "none";
  review: string;
  truth: string;
  // Hosts the result depends on. When any is unreachable the run is compared with recorded.restricted.
  egress?: string[];
  // Instruction items, as file:line, that are genuinely wrong. Every other failing item is a false finding.
  realInstructionFindings: string[];
  falseInstructionFindings: number;
  target: Target;
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
const TARGET = process.env.SA_TRIALS_TARGET === "1";
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
  };
}

function falseFindings(t: Trial, o: Observed): string[] {
  return o.instructionFailures.filter((f) => !t.realInstructionFindings.includes(f));
}

function targetGaps(t: Trial, o: Observed): string[] {
  const g = t.target;
  const gaps: string[] = [];
  if (g.sealed !== undefined && o.sealed !== g.sealed) gaps.push(`sealed ${o.sealed}, target ${g.sealed}`);
  if (g.runtime !== undefined && o.runtime !== g.runtime) gaps.push(`runtime ${o.runtime}, target ${g.runtime}`);
  if (g.outcome !== undefined && o.outcome !== g.outcome) gaps.push(`outcome ${o.outcome}, target ${g.outcome}`);
  if (g.minLevel !== undefined && (o.level ?? -1) < g.minLevel) gaps.push(`level ${o.level}, target at least ${g.minLevel}`);
  if (g.unproven !== undefined && o.unproven !== g.unproven) gaps.push(`unproven ${o.unproven}, target ${g.unproven}`);
  for (const [id, c] of Object.entries(g.components ?? {})) {
    const oc = o.components[id];
    if (!oc) gaps.push(`${id} missing`);
    else {
      if (c.minLevel !== undefined && (oc.level ?? -1) < c.minLevel) gaps.push(`${id} level ${oc.level}, target at least ${c.minLevel}`);
      if (c.unproven !== undefined && oc.unproven !== c.unproven) gaps.push(`${id} unproven ${oc.unproven}, target ${c.unproven}`);
    }
  }
  const ff = falseFindings(t, o).length;
  if (g.falseInstructionFindings !== undefined && ff > g.falseInstructionFindings) gaps.push(`${ff} false instruction findings, target ${g.falseInstructionFindings}`);
  if (g.blockingSafety !== undefined && o.blockingSafety.length > g.blockingSafety) gaps.push(`${o.blockingSafety.length} blocking safety findings, target ${g.blockingSafety}`);
  return gaps;
}

const trials = spec.trials.filter((t) => ONLY.length === 0 || ONLY.includes(t.id));
const runtime = detectRuntime("docker");

describe("pinned trial repos", { concurrency: 2 }, () => {
  before(async () => {
    await Promise.all(trials.flatMap((t) => t.egress ?? []).map(probe));
  });
  for (const t of trials) {
    const skip = t.runtime === "docker" && !runtime ? "no docker: this trial runs in a container" : false;
    test(`${t.id} (${t.repo}@${t.commit.slice(0, 7)}, ${t.runtime === "docker" ? "docker" : "no container runtime"})`, { skip, timeout: 30 * 60_000 }, async (ctx) => {
      const blocked: string[] = [];
      for (const h of t.egress ?? []) if (!(await probe(h))) blocked.push(h);
      const key = !t.egress?.length ? "any" : blocked.length ? "restricted" : "open";
      const repo = checkout(t);
      const env: Record<string, string> = { SA_READINESS_EVAL_SEED: spec.seed, SA_READINESS_NOW: spec.now, SA_READINESS_RUNTIME: t.runtime };
      if (t.runtime === "none") env.PATH = noRuntimePath();
      // Copied into the repo and run from there, as the quickstart has a customer do, so the repo's
      // own package.json (such as "type": "commonjs") applies to the scripts.
      const skill = join(repo, ".cursor", "skills", "agent-readiness");
      cpSync(SKILL, skill, { recursive: true });
      const r = readiness(repo, ["audit", "--tier", "local-exec"], env, join(skill, "scripts", "readiness.ts"));
      const o = observe(repo, r.code);
      const ff = falseFindings(t, o);
      const gaps = targetGaps(t, o);
      ctx.diagnostic(`observed (${key}${blocked.length ? `, blocked: ${blocked.join(", ")}` : ""}): ${JSON.stringify(o)}`);
      ctx.diagnostic(`false instruction findings: ${ff.length} (ceiling ${t.falseInstructionFindings})`);
      ctx.diagnostic(gaps.length ? `short of target: ${gaps.join("; ")}` : "meets target");
      if (!o.sealed) ctx.diagnostic(`not sealed, output ends: ${r.out.trim().split("\n").slice(-5).join(" | ")}`);
      if (RECORD) {
        const file = JSON.parse(readFileSync(FILE, "utf8")) as TrialsFile;
        const entry = file.trials.find((x) => x.id === t.id)!;
        entry.recorded[key] = o;
        entry.falseInstructionFindings = ff.length;
        writeFileSync(FILE, JSON.stringify(file, null, 2) + "\n");
        return;
      }
      assert.ok(o.sealed || t.recorded[key]?.sealed === false, `the audit didn't seal (exit ${r.code}):\n${r.out.slice(-3000)}`);
      assert.ok(ff.length <= t.falseInstructionFindings, `${ff.length} false instruction findings, above the recorded ${t.falseInstructionFindings}: ${ff.join(", ")}`);
      const want = t.recorded[key];
      assert.ok(want, `no result recorded for the "${key}" network; run with SA_TRIALS_RECORD=1 and commit trials.json`);
      const { instructionFailures: _a, ...got } = o;
      const { instructionFailures: _b, ...exp } = want;
      assert.deepEqual(got, exp, `${t.id} changed from its recorded result; if that is intended, re-record it and say why in the PR`);
      if (TARGET) assert.deepEqual(gaps, [], `${t.id} is short of its target`);
    });
  }
});
