import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Arm, EvalCase } from "./types.ts";

const CASES = join(dirname(fileURLToPath(import.meta.url)), "..", "cases");

export interface Job {
  c: EvalCase;
  m: string;
  r: number;
  arm: Arm;
}

export async function loadCases(): Promise<EvalCase[]> {
  const out: EvalCase[] = [];
  for (const f of readdirSync(CASES).filter((x) => x.endsWith(".ts")).sort()) {
    const mod = (await import(join(CASES, f))) as { cases?: EvalCase[]; default?: EvalCase };
    const list = mod.cases ?? (mod.default ? [mod.default] : []);
    const prefix = basename(f, ".ts");
    for (const c of list) out.push({ ...c, id: `${prefix}/${c.id}` });
  }
  return out;
}

export function select(all: EvalCase[], flags: Record<string, string | true>): EvalCase[] {
  const tag = typeof flags.tag === "string" ? flags.tag : undefined;
  const only = typeof flags.case === "string" ? flags.case.split(",") : undefined;
  // A hill-climb round never sees the held-out cases unless asked to report them.
  const holdoutOut = Boolean(flags["hill-climb"]) && !flags["include-holdout"];
  return all.filter((c) => (!tag || c.tags.includes(tag as EvalCase["tags"][number])) && (!only || only.some((o) => c.id === o || c.id.endsWith("/" + o))) && !(holdoutOut && c.tags.includes("holdout")));
}

// Runs with no agent in them: the scripted control arm and the scripted negative cases. Their first
// DETERMINISTIC_REPEATS runs of a case stand for every repeat only when their fingerprints
// (fingerprint.ts) match; when they differ, or one is missing or lost, the case gets every repeat.
export const DETERMINISTIC_REPEATS = 2;

export function deterministic(j: Pick<Job, "c" | "arm">): boolean {
  return Boolean(j.c.attack) || j.arm === "scripted";
}

// Every run a selection makes: each driven case once per arm, model and repeat (the scripted arm
// has no model), and each scripted negative case once per repeat. With `probe` below `repeats`,
// deterministic jobs stop at `probe` repeats; restOf() plans the others when the probe differs.
export function planJobs(selected: EvalCase[], arms: Arm[], models: string[], repeats: number, probe = repeats): Job[] {
  const driven = selected.filter((c) => !c.attack);
  const scripted = selected.filter((c) => c.attack);
  const upTo = (arm: Arm, attack: boolean) => (attack || arm === "scripted" ? Math.min(repeats, probe) : repeats);
  return [
    ...driven.flatMap((c) => arms.flatMap((arm) => (arm === "scripted" ? ["scripted"] : models).flatMap((m) => Array.from({ length: upTo(arm, false) }, (_, i) => ({ c, m, r: i + 1, arm }))))),
    ...scripted.flatMap((c) => Array.from({ length: upTo("agent", true) }, (_, i) => ({ c, m: "scripted", r: i + 1, arm: "agent" as Arm }))),
  ];
}

// The repeats a deterministic job's case still needs after its probe, from probe + 1 to repeats.
export function restOf(j: Job, probe: number, repeats: number): Job[] {
  return Array.from({ length: Math.max(0, repeats - probe) }, (_, i) => ({ ...j, r: probe + i + 1 }));
}

export type ProbeOutcome = { matched: true } | { matched: false; why: string };

// Whether a case's probe runs may stand for every repeat: all of them finished, none was lost to
// infrastructure, each has a fingerprint, and the fingerprints are the same.
export function probeOutcome(runs: { fingerprint?: string | null; infra?: { lost: boolean } | null; error: string | null }[], probe: number): ProbeOutcome {
  if (runs.length < probe) return { matched: false, why: `${runs.length} of ${probe} probe runs left a result` };
  if (runs.some((r) => r.infra?.lost)) return { matched: false, why: "a probe run was lost to infrastructure" };
  if (runs.some((r) => !r.fingerprint)) return { matched: false, why: "a probe run has no fingerprint" };
  if (new Set(runs.map((r) => r.fingerprint)).size > 1) return { matched: false, why: "the probe runs differ" };
  return { matched: true };
}
