import type { Rubric } from "./rubric.ts";
import { strengthRank } from "./rubric.ts";
import type { Audit, CondId, CondState, Evidence } from "./types.ts";

export interface CondDetail {
  state: CondState;
  reason: string;
  evidence: string[];
}

export type CompStates = Record<CondId, CondDetail>;

const COMPONENT_CONDS: CondId[] = ["clean.install", "clean.build", "clean.test", "commands", "faults"];
const REPO_CONDS: CondId[] = ["instructions", "safety", "toolchain", "lockfile"];

function latest(evs: Evidence[]): Evidence | undefined {
  return evs[evs.length - 1];
}

const replayed = (e: Evidence) => e.where === "container" || e.where === "fresh_copy";

// A component's own commands of a kind decide it. A repo-wide command fills in only where the
// component has none of that kind: a root `npm test` that fails in one workspace can't be pinned
// on the others, and a component with no test of its own still gets the repo's.
export function commandsFor(contract: Audit["contract"], componentId: string, kind: string): Audit["contract"] {
  const own = contract.filter((c) => c.component === componentId && c.kind === kind);
  return own.length ? own : contract.filter((c) => c.component === "*" && c.kind === kind);
}

// A replay result for a command outranks a later diagnostic run of it on the host, so
// `readiness run` can't turn a clean-container failure into a pass.
function commandEvidence(evs: Evidence[], contractId: string, replayOnly: boolean): Evidence | undefined {
  const mine = evs.filter((e) => e.contractId === contractId);
  const fromReplay = mine.filter(replayed);
  return latest(replayOnly || fromReplay.length ? fromReplay : mine);
}

// Every command must pass: one failing command fails the condition even when another passes.
function allPass(parts: CondDetail[], metReason: string, alwaysMetReason = false): CondDetail {
  const failed = parts.filter((p) => p.state === "not_met");
  const unknown = parts.filter((p) => p.state === "unknown");
  const blocked = parts.filter((p) => p.state === "blocked");
  const ids = parts.flatMap((p) => p.evidence);
  if (failed.length > 0) return { state: "not_met", reason: failed.map((p) => p.reason).join("; "), evidence: ids };
  if (blocked.length > 0 && unknown.length === 0) return { state: "blocked", reason: blocked[0].reason, evidence: ids };
  if (unknown.length > 0 || blocked.length > 0) return { state: "unknown", reason: [...unknown, ...blocked].map((p) => p.reason).join("; "), evidence: ids };
  return { state: "met", reason: parts.length === 1 && !alwaysMetReason ? parts[0].reason : metReason, evidence: ids };
}

function needsContainer(rubric: Rubric, check: string): boolean {
  const c = rubric.checks.find((x) => x.id === check);
  return c?.minStrengthForPass === "clean_replay";
}

// A host fallback runs on whatever this machine has installed. A missing tool there is an
// environment limit: only a clean container from the repo's own setup can show a repo defect.
export function hostToolMissing(ev: Evidence): boolean {
  return ev.result === "fail" && ev.where !== "container" && ev.where !== "static" && ev.diagnosis?.cause === "missing_tool";
}

export function blockedBy(ev: Evidence): string | null {
  if (ev.blocked) return ev.blocked;
  return hostToolMissing(ev) ? `${ev.diagnosis!.detail} on this machine` : null;
}

// No real results, no level: a level needs at least one Level 1 check that ran and passed, or failed
// for a reason in the repo. Returns why there is none, or null when there is one. Checks that this
// machine blocked aren't "no result": they make the level unproven here, which levels.ts reports
// with the reasons, so a missing Docker reads as unproven rather than as not assessed.
export function noRealResults(audit: Audit, states: Map<string, CompStates>): string | null {
  const assessed = audit.profile?.components.filter((c) => c.assessed) ?? [];
  if (assessed.length === 0) return "no component could be assessed";
  const ids = new Set(assessed.map((c) => c.id));
  const ran = audit.evidence.some((e) => (e.kind === "install" || e.kind === "build" || e.kind === "test") && (e.component === "*" || ids.has(e.component ?? "")) && (e.result === "pass" || (e.result === "fail" && !blockedBy(e))));
  const noTests = assessed.some((c) => states.get(c.id)?.["clean.test"].state === "not_met");
  if (ran || noTests) return null;
  if (audit.tier === "read-only") return "the read-only tier runs no repo code";
  const blockedHere = assessed.some((c) => {
    const s = states.get(c.id);
    return s !== undefined && (["clean.install", "clean.build", "clean.test"] as const).some((k) => s[k].state === "blocked");
  });
  if (blockedHere) return null;
  return "no check produced a result";
}

function fromEvidence(rubric: Rubric, ev: Evidence | undefined, check: string, missingReason: string, componentId?: string): CondDetail {
  if (!ev) return { state: "unknown", reason: missingReason, evidence: [] };
  const blocked = blockedBy(ev);
  if (blocked) return { state: "blocked", reason: ev.where === "container" ? `${blocked}, a limit of the audit's environment rather than a repo defect` : `${blocked}, an environment limit rather than a repo defect; Level 1 needs a clean container`, evidence: [ev.id] };
  // A repo-wide run whose every failing file is in other components passes for this one.
  if (ev.result === "fail" && componentId && ev.failedIn?.length && !ev.failedIn.includes(componentId)) {
    const passed = fromEvidence(rubric, { ...ev, result: "pass", failedIn: undefined }, check, missingReason);
    return passed.state === "met" ? { ...passed, reason: `the repo-wide ${ev.kind ?? "command"} passes for ${componentId}: every failure is in ${ev.failedIn.join(", ")}` } : passed;
  }
  if (ev.result === "fail") return { state: "not_met", reason: ev.summary, evidence: [ev.id] };
  if (ev.result === "not_run") return { state: "unknown", reason: ev.summary, evidence: [ev.id] };
  const min = rubric.checks.find((c) => c.id === check)?.minStrengthForPass ?? "executed";
  if (strengthRank(rubric, ev.strength) < strengthRank(rubric, min)) {
    if (needsContainer(rubric, check)) return { state: "blocked", reason: "passed in host mode, which ran on this machine and could read its local files, so it isn't a sandbox; Level 1 needs a clean container", evidence: [ev.id] };
    return { state: "unknown", reason: `passed, but only ${rubric.strengthLabels[ev.strength]}`, evidence: [ev.id] };
  }
  return { state: "met", reason: ev.summary, evidence: [ev.id] };
}

export const CANARY_MISSING = "the type-check hasn't been seen to fail on a planted type error";

// From 2026-12-beta a passing type-check must also fail on the type error the replay plants. A
// component with no file to plant it in is exempt; one where planting didn't finish is unproven.
function canaryPart(rubric: Rubric, evs: Evidence[], componentId: string): CondDetail & { exempt?: boolean } {
  const ev = latest(evs.filter((e) => e.canary?.kind === "typecheck" && e.component === componentId));
  if (!ev) return { state: "unknown", reason: CANARY_MISSING, evidence: [] };
  if (ev.canary!.exempt) return { state: "met", reason: ev.summary, evidence: [ev.id], exempt: true };
  return fromEvidence(rubric, ev, "verify.canonical_interface", CANARY_MISSING);
}

export function componentStates(audit: Audit, rubric: Rubric, componentId: string): CompStates {
  const evs = audit.evidence;
  const contract = audit.contract;
  const states = {} as CompStates;
  const preferReplay = (list: Evidence[]) => latest(list.filter(replayed)) ?? latest(list);
  const repoInstall = preferReplay(evs.filter((e) => e.kind === "install" && (e.component === "*" || !e.component)));
  const ownInstall = preferReplay(evs.filter((e) => e.kind === "install" && e.component === componentId));
  const install = ownInstall && !(repoInstall && repoInstall.result !== "pass") ? ownInstall : (repoInstall ?? ownInstall);
  states["clean.install"] = fromEvidence(rubric, install, "bootstrap.cold_replay", "the clean install hasn't run");
  const builds = commandsFor(contract, componentId, "build");
  if (builds.length === 0) {
    states["clean.build"] = { state: states["clean.install"].state, reason: "no build step; follows the install", evidence: states["clean.install"].evidence };
  } else {
    states["clean.build"] = allPass(builds.map((c) => fromEvidence(rubric, commandEvidence(evs, c.id, true), "bootstrap.cold_replay", "the clean build hasn't run", componentId)), `${builds.length} build commands pass`);
  }
  const tests = commandsFor(contract, componentId, "test");
  if (tests.length === 0) {
    states["clean.test"] = { state: "not_met", reason: "no test command was found", evidence: [] };
  } else {
    states["clean.test"] = allPass(tests.map((c) => fromEvidence(rubric, commandEvidence(evs, c.id, true), "bootstrap.cold_replay", "the clean test run hasn't run", componentId)), `${tests.length} test commands pass`);
  }
  const cmdKinds = ["build", "lint", "typecheck", "test"] as const;
  const discovered = cmdKinds.flatMap((k) => commandsFor(contract, componentId, k));
  if (!discovered.some((c) => c.kind === "test")) {
    states.commands = { state: "not_met", reason: "no test command was found", evidence: [] };
  } else {
    const parts = discovered.map((c) => fromEvidence(rubric, commandEvidence(evs, c.id, false), "verify.canonical_interface", `${c.kind} hasn't run`, componentId));
    // The canary is asked of a type-check only once it passed; a failing or blocked one decides alone.
    const typechecksMet = parts.filter((_, i) => discovered[i].kind === "typecheck");
    const canary = rubric.canary?.typecheck && typechecksMet.length && typechecksMet.every((p) => p.state === "met") ? canaryPart(rubric, evs, componentId) : null;
    const caught = canary?.state === "met" ? (canary.exempt ? `; ${canary.reason}` : ", and the type-check failed on a planted type error") : "";
    states.commands = allPass(canary ? [...parts, canary] : parts, `${discovered.length} commands pass${caught}`, true);
  }
  const faults = latest(evs.filter((e) => e.condition === "faults" && e.component === componentId));
  states.faults = fromEvidence(rubric, faults, "verify.behavioral_oracle", "faults haven't been planted");
  if (states.faults.state === "unknown" && states["clean.test"].state === "blocked" && !faults?.skipped) {
    states.faults = { state: "blocked", reason: "not checked: the clean test run was blocked on this machine", evidence: states.faults.evidence };
  }
  const repo = repoStates(audit, rubric);
  states.instructions = repo.instructions;
  states.safety = repo.safety;
  states.toolchain = repo.toolchain;
  states.lockfile = repo.lockfile;
  return states;
}

// Says what was checked and what wasn't run, so a list of skipped commands never reads as verified.
function instructionsMetReason(items: Audit["instructions"]): string {
  if (items.length === 0) return "no agent instructions to check";
  const skipped = items.filter((i) => i.result === "not_run" && i.category === "skipped").length;
  const notRun = items.filter((i) => i.result === "not_run").length - skipped;
  const checked = items.length - notRun - skipped;
  if (notRun + skipped === 0) return `${items.length} instruction items check out`;
  const why = [notRun ? `${notRun} weren't run because they need access, run long or are risky` : "", skipped ? `${skipped} ${skipped === 1 ? "was" : "were"} skipped as vendored-skill, placeholder, interactive or package-adding commands` : ""].filter(Boolean).join("; ");
  return `${checked} of ${items.length} instruction items check out; ${why}`;
}

export function repoStates(audit: Audit, rubric: Rubric): Record<"instructions" | "safety" | "toolchain" | "lockfile", CondDetail> {
  const items = audit.instructions;
  const failed = items.filter((i) => i.result === "fail");
  const pending = items.filter((i) => i.result === "not_run" && i.category === "replay");
  const insEvidence = items.map((i) => i.evidenceId).filter((x): x is string => Boolean(x));
  const instructions: CondDetail =
    failed.length > 0
      ? { state: "not_met", reason: `${failed.length} of ${items.length} instruction items are wrong`, evidence: insEvidence }
      : pending.length > 0 && pending.every((i) => i.blocked)
        ? { state: "blocked", reason: `${pending.length} instruction commands couldn't be replayed: ${pending[0].blocked}`, evidence: insEvidence }
        : pending.length > 0
          ? { state: "unknown", reason: `${pending.length} instruction commands haven't been run`, evidence: insEvidence }
          : { state: "met", reason: instructionsMetReason(items), evidence: insEvidence };
  const blocking = audit.safety.filter((s) => s.blocking);
  const safety: CondDetail = blocking.length > 0 ? { state: "not_met", reason: blocking.map((b) => b.detail).join("; "), evidence: [] } : { state: "met", reason: "no blocking safety findings", evidence: [] };
  const tc = audit.profile?.toolchain;
  const toolchain: CondDetail = !tc ? { state: "unknown", reason: "not scanned", evidence: [] } : tc.pinned ? { state: "met", reason: `pinned in ${tc.files.join(", ")}`, evidence: [] } : { state: "not_met", reason: `missing ${tc.missing.join(" and ")}`, evidence: [] };
  const lockfile = fromEvidence(rubric, latest(audit.evidence.filter((e) => e.condition === "lockfile")), "bootstrap.cold_replay", "the frozen install hasn't run");
  return { instructions, safety, toolchain, lockfile };
}

export interface CheckCounts {
  passed: number;
  failed: number;
  notRun: number;
}

export function checkCounts(audit: Audit, checkId: string): CheckCounts {
  if (checkId === "context.instructions_verified") {
    const items = audit.instructions;
    return { passed: items.filter((i) => i.result === "pass").length, failed: items.filter((i) => i.result === "fail").length, notRun: items.filter((i) => i.result === "not_run").length };
  }
  if (checkId === "safety.execution_boundary") {
    const blocking = audit.safety.filter((s) => s.blocking).length;
    return { passed: blocking === 0 ? 1 : 0, failed: blocking, notRun: 0 };
  }
  const latestByKey = new Map<string, Evidence>();
  for (const e of audit.evidence.filter((x) => x.checkId === checkId)) latestByKey.set(`${e.contractId ?? e.condition ?? e.id}:${e.component ?? ""}`, e);
  const evs = [...latestByKey.values()];
  return { passed: evs.filter((e) => e.result === "pass").length, failed: evs.filter((e) => e.result === "fail").length, notRun: evs.filter((e) => e.result === "not_run").length };
}

export const ALL_COMPONENT_CONDS = COMPONENT_CONDS;
export const ALL_REPO_CONDS = REPO_CONDS;
