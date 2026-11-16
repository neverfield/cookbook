import type { Audit } from "./types.ts";

// The scan's default time bound (--budget-scan). A 25,000-file monorepo scans in well under it;
// what runs past it is sampled, and the report says so.
export const SCAN_BOUND_MINUTES = 3;

// Set as `blocked` on a command or planted-fault result the replay's time budget cut off.
export const BUDGET_OUT = "the audit's time budget ran out (--budget-total or --budget-component)";
export const CUT_OFF = "not replayed: cut off by the time budget (--budget-total)";

const FAULTS_CUT = /; the time budget cut off \d+ of \d+/;

const n = (x: number) => x.toLocaleString("en-US");

// The reason on a component for a top-level folder the file cap left partly unlisted.
export function capCutReason(cap: number): string {
  return `the scan stopped at its ${n(cap)}-file cap before it listed everything in this folder, so projects in it may be missing`;
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// The folders the file cap cut short, largest share of changes first. The report and the scan's log
// both name these.
export function capCutFolders(audit: Pick<Audit, "profile">): string[] {
  const cap = audit.profile?.scope?.fileCap;
  if (!cap) return [];
  const reason = capCutReason(cap);
  return (audit.profile?.components ?? []).filter((c) => c.notAssessedReason === reason).sort((a, b) => b.changeShare - a.changeShare).map((c) => c.path);
}

// What the audit read only part of on a large repo, in one clause per part, or null when it read
// everything. The coverage line and the scan's log both use it.
export function sampledScope(audit: Pick<Audit, "profile" | "evidence" | "instructions">): string | null {
  const s = audit.profile?.scope;
  const parts: string[] = [];
  if (s?.fileCap) {
    const cut = capCutFolders(audit);
    const named = cut.length > 8 ? [...cut.slice(0, 8), `${cut.length - 8} more`] : cut;
    parts.push(`the scan stopped at ${n(s.fileCap)} files${cut.length ? `, before it listed everything in ${list(named)}, which ${cut.length === 1 ? "isn't" : "aren't"} assessed` : ", so it left out the deepest files of the largest folders"}`);
  }
  if (s && s.secrets.scanned < s.secrets.total) parts.push(`the secret scan read ${n(s.secrets.scanned)} of ${n(s.secrets.total)} files before the scan's ${s.boundMinutes}-minute bound`);
  if (s && s.assetHistory.read < s.assetHistory.total) parts.push(`git history was read for ${n(s.assetHistory.read)} of ${n(s.assetHistory.total)} agent assets`);
  const cut = audit.evidence.filter((e) => e.blocked === BUDGET_OUT);
  const commands = cut.filter((e) => e.condition !== "faults").length;
  const faults = [...new Set(audit.evidence.filter((e) => e.condition === "faults" && (e.blocked === BUDGET_OUT || FAULTS_CUT.test(e.summary))).map((e) => e.component ?? "*"))];
  if (commands) parts.push(`the time budget cut off ${commands} ${commands === 1 ? "command" : "commands"}`);
  if (faults.length) parts.push(`planted faults in ${faults.join(", ")} stopped at the time budget`);
  const instructions = audit.instructions.filter((i) => i.reason === CUT_OFF).length;
  if (instructions) parts.push(`${instructions} documented ${instructions === 1 ? "command wasn't" : "commands weren't"} run before the time budget ran out`);
  return parts.length ? parts.join("; ") : null;
}
