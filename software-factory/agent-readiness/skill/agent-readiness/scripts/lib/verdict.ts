import { attributes, attributionOf } from "./attribute.ts";
import type { Rubric } from "./rubric.ts";
import { provingPlace, strengthRank } from "./rubric.ts";
import type { Evidence } from "./types.ts";

// One verdict per result. Scoring, the model, the explanations, the roadmap, the recheck and the CLI
// read a row's verdict from here, never its raw result, so a step that is blocked or undetermined
// can't read as failed in one place and as blocked in another.
export type Verdict = "pass" | "repo_fault" | "blocked" | "undetermined" | "not_run";

export interface Judgement {
  verdict: Verdict;
  reason: string;
}

// A reason that starts with this is a condition the audit couldn't decide, and says what would.
export const UNDETERMINED = "undetermined: ";

// A host fallback runs on whatever this machine has installed. A missing tool there is an
// environment limit: only a clean container from the repo's own setup can show a repo defect.
export function hostToolMissing(ev: Evidence): boolean {
  return ev.result === "fail" && ev.where !== "container" && ev.where !== "static" && ev.diagnosis?.cause === "missing_tool";
}

export function blockedBy(ev: Evidence): string | null {
  if (ev.blocked) return ev.blocked;
  return hostToolMissing(ev) ? `${ev.diagnosis!.detail} on this machine` : null;
}

function needsContainer(rubric: Rubric, check: string): boolean {
  return rubric.checks.find((x) => x.id === check)?.minStrengthForPass === "clean_replay";
}

// Whether a pass of this row would fall short of what the check asks.
export function belowProof(rubric: Rubric, ev: Evidence, check = ev.checkId): boolean {
  const min = rubric.checks.find((c) => c.id === check)?.minStrengthForPass ?? "executed";
  return strengthRank(rubric, ev.strength) < strengthRank(rubric, min);
}

// From 2026-12-beta a failure is the repo's only where a pass would have proved the check: a place
// that can't prove a pass can't prove a failure either, unless an experiment there showed it.
function placeFailure(rubric: Rubric, ev: Evidence, check: string): Judgement {
  if (needsContainer(rubric, check) && ev.where === "disposable_vm") return { verdict: "blocked", reason: `${ev.summary} on a disposable VM, which this audit's rubric doesn't count as proof either way; Level 1 needs a clean container` };
  if (needsContainer(rubric, check)) return { verdict: "blocked", reason: `${ev.summary} in host mode, on this machine with what it has installed, which isn't a sandbox: a failure there shows a repo defect no more than a pass would show it works; Level 1 needs ${provingPlace(rubric)}` };
  return { verdict: "undetermined", reason: `${UNDETERMINED}${ev.summary}, but only ${rubric.strengthLabels[ev.strength]}, which can't show the repo's fault` };
}

// check: the check the row is scored for, when that isn't the row's own.
export function judge(ev: Evidence, rubric: Rubric, check = ev.checkId): Judgement {
  const blocked = blockedBy(ev);
  if (blocked) return { verdict: "blocked", reason: ev.where === "container" ? `${blocked}, a limit of the audit's environment rather than a repo defect` : `${blocked}, an environment limit rather than a repo defect; Level 1 needs a clean container` };
  if (ev.result === "not_run") return { verdict: "not_run", reason: ev.summary };
  if (ev.result === "pass") return { verdict: "pass", reason: ev.summary };
  if (!attributes(rubric)) return { verdict: "repo_fault", reason: ev.summary };
  const a = attributionOf(ev);
  if (a?.verdict === "environment") return { verdict: "blocked", reason: `${a.detail}, a limit of the audit's environment rather than a repo defect` };
  if (a?.verdict === "undetermined") return { verdict: "undetermined", reason: `${UNDETERMINED}${a.detail}` };
  if (a?.basis !== "experiment" && belowProof(rubric, ev, check)) return placeFailure(rubric, ev, check);
  return { verdict: "repo_fault", reason: ev.summary };
}

export function verdictOf(ev: Evidence, rubric: Rubric, check = ev.checkId): Verdict {
  return judge(ev, rubric, check).verdict;
}

// The word a row's verdict reads as in every place the report, the CLI and the recheck show it. A
// repo fault keeps "fail", the word the released reports use.
export const VERDICT_WORD: Record<Verdict, string> = { pass: "pass", repo_fault: "fail", blocked: "blocked", undetermined: "undetermined", not_run: "not run" };

// The same word as report.json's evidence log and the recheck record store it.
export const RECORD_WORD: Record<Verdict, string> = { pass: "pass", repo_fault: "fail", blocked: "blocked", undetermined: "undetermined", not_run: "not_run" };

export function verdictWord(ev: Evidence, rubric: Rubric): string {
  return VERDICT_WORD[verdictOf(ev, rubric)];
}

// Counts of rows by verdict. failed counts repo faults only.
export interface VerdictCounts {
  passed: number;
  failed: number;
  blocked: number;
  undetermined: number;
  notRun: number;
}

export function countVerdicts(evs: Evidence[], rubric: Rubric): VerdictCounts {
  const out: VerdictCounts = { passed: 0, failed: 0, blocked: 0, undetermined: 0, notRun: 0 };
  for (const e of evs) {
    const v = verdictOf(e, rubric);
    switch (v) {
      case "pass":
        out.passed++;
        break;
      case "repo_fault":
        out.failed++;
        break;
      case "blocked":
        out.blocked++;
        break;
      case "undetermined":
        out.undetermined++;
        break;
      case "not_run":
        out.notRun++;
        break;
      default: {
        const never: never = v;
        throw new Error(`unknown verdict ${String(never)}`);
      }
    }
  }
  return out;
}
