import type { Rubric } from "./rubric.ts";
import { strengthRank } from "./rubric.ts";
import type { Audit, Evidence, Result, Strength } from "./types.ts";
import { fail, nowIso } from "./util.ts";

// What one evidence row is a result for: the same check and condition, for the same component and
// command, run the same way. A replay result and a later diagnostic run on the host stay separate,
// since a replay outranks a host run (score.ts). A row with no command and no condition, such as a
// recorded observation, is a result of its own and has no key.
export function evidenceKey(e: Pick<Evidence, "checkId" | "condition" | "component" | "contractId" | "command" | "cwd" | "where">): string | null {
  if (!e.contractId && !e.command && !e.condition) return null;
  const lane = e.where === "container" || e.where === "fresh_copy" || e.where === "disposable_vm" ? "replay" : e.where;
  return [e.checkId, e.condition ?? "", e.component ?? "*", e.contractId ?? e.command ?? "", e.contractId ? "" : (e.cwd ?? ""), lane].join("\u0000");
}

// A new result for a key supersedes the one before it, so scoring, counts and the report read only
// the current row and the log folds the earlier one under it.
export function addEvidence(audit: Audit, e: Omit<Evidence, "id" | "at" | "supersededBy">): Evidence {
  const ev: Evidence = { id: `ev-${String(audit.evidence.length + 1).padStart(3, "0")}`, at: nowIso(), ...e };
  const key = evidenceKey(ev);
  if (key) for (const old of audit.evidence) if (!old.supersededBy && evidenceKey(old) === key) old.supersededBy = ev.id;
  audit.evidence.push(ev);
  return ev;
}

export function currentEvidence(audit: Pick<Audit, "evidence">): Evidence[] {
  return audit.evidence.filter((e) => !e.supersededBy);
}

export function recordObservation(
  audit: Audit,
  rubric: Rubric,
  input: { checkId: string; component?: string; result: Result; strength: Strength; summary: string },
): Evidence {
  if (!rubric.checks.some((c) => c.id === input.checkId)) fail(`Unknown check ${input.checkId}`);
  if (strengthRank(rubric, input.strength) > strengthRank(rubric, "static")) {
    fail(`record can't create ${input.strength} evidence. Only \`readiness run\` and \`readiness replay\` create executed or clean-replay evidence.`);
  }
  if (!input.summary.trim()) fail("record needs --summary");
  return addEvidence(audit, { checkId: input.checkId, component: input.component, strength: input.strength, where: "static", result: input.result, summary: input.summary });
}

export function latestFor(audit: Audit, pred: (e: Evidence) => boolean): Evidence | undefined {
  const hits = audit.evidence.filter(pred);
  return hits[hits.length - 1];
}
