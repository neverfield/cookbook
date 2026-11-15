import { join } from "node:path";
import type { Rubric } from "./rubric.ts";
import type { Audit, CondId, WaiverEntry, WaiverRecord } from "./types.ts";
import { exists, readText, sha256 } from "./util.ts";

// A repo lists findings it has reviewed as false positives here. The audit reads the file from the
// audited commit only, never from the working copy, so nothing written during an audit, by the
// agent or anyone else, can waive a finding in it.
export const WAIVER_FILE = ".agent-readiness/waivers.json";
export const WAIVER_SCHEMA = "agent-readiness/waivers@1";
export const MAX_WAIVERS = 50;
const MAX_BYTES = 64 * 1024;

// Only findings that sit on top of Level 1 can be waived: wrong instructions and safety findings.
const WAIVABLE: Record<string, CondId> = {
  "context.instructions_verified": "instructions",
  "safety.execution_boundary": "safety",
};

function empty(file: string, ignored: string | null, digest: string | null = null): WaiverRecord {
  return { file, digest, entries: [], rejected: [], ignored };
}

// workingCopy is the repo's own file, when it exists, so an uncommitted edit is named and refused.
export function loadWaivers(tree: string, rubric: Rubric, today: string, workingCopy: string | null = null): WaiverRecord | null {
  const path = join(tree, WAIVER_FILE);
  if (!exists(path)) return workingCopy !== null ? empty(WAIVER_FILE, `${WAIVER_FILE} isn't in the audited commit, so it was ignored; commit it to use it`) : null;
  const text = readText(path);
  const digest = sha256(text);
  const changed = workingCopy !== null && workingCopy !== text ? `; the working copy's ${WAIVER_FILE} differs from the audited commit, and only the committed one counts` : "";
  if (text.length > MAX_BYTES) return empty(WAIVER_FILE, `${WAIVER_FILE} is over ${MAX_BYTES / 1024} KB, so it was ignored${changed}`, digest);
  let doc: { schema?: unknown; waivers?: unknown };
  try {
    doc = JSON.parse(text);
  } catch {
    return empty(WAIVER_FILE, `${WAIVER_FILE} isn't valid JSON, so it was ignored${changed}`, digest);
  }
  if (!doc || typeof doc !== "object" || doc.schema !== WAIVER_SCHEMA || !Array.isArray(doc.waivers)) {
    return empty(WAIVER_FILE, `${WAIVER_FILE} needs "schema": "${WAIVER_SCHEMA}" and a "waivers" list, so it was ignored${changed}`, digest);
  }
  const level1Checks = new Set(rubric.level1.map((c) => rubric.conditions[c].check));
  const record: WaiverRecord = { file: WAIVER_FILE, digest, entries: [], rejected: [], ignored: changed ? changed.slice(2) : null };
  const ids = new Set<string>();
  (doc.waivers as unknown[]).forEach((raw, i) => {
    const w = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = typeof w.id === "string" && w.id.trim() ? w.id.trim() : `#${i + 1}`;
    const reject = (reason: string) => record.rejected.push({ id, reason });
    const str = (k: string) => (typeof w[k] === "string" ? (w[k] as string).trim() : "");
    const unknown = Object.keys(w).filter((k) => !["id", "check", "match", "reason", "by", "expires"].includes(k));
    if (ids.has(id)) return reject("another waiver has the same id");
    ids.add(id);
    if (record.entries.length >= MAX_WAIVERS) return reject(`over the limit of ${MAX_WAIVERS} waivers`);
    if (unknown.length) return reject(`unknown field ${unknown.join(", ")}`);
    const check = str("check");
    if (level1Checks.has(check)) return reject("Level 1 checks can't be waived");
    if (!WAIVABLE[check]) return reject(`only ${Object.keys(WAIVABLE).join(" and ")} findings can be waived`);
    const match = str("match");
    if (!/^[^\s:][^:]*(:\d+)?$/.test(match)) return reject('"match" must be a file or file:line, such as README.md:72');
    if (str("reason").length < 10) return reject('"reason" must say why the finding is a false positive, in at least 10 characters');
    if (!str("by")) return reject('"by" must name the person who reviewed the finding');
    const expires = str("expires");
    if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return reject('"expires" must be a date, such as 2027-05-15');
    if (expires && expires < today) return reject(`it expired on ${expires}`);
    const entry: WaiverEntry = { id, check, match, reason: str("reason"), by: str("by"), ...(expires ? { expires } : {}) };
    record.entries.push(entry);
  });
  return record;
}

function matches(match: string, file: string, line: number | undefined): boolean {
  const [f, l] = match.split(":");
  return f === file && (l === undefined || Number(l) === line);
}

// Marks every finding a waiver names. A waived finding stops counting, keeps what it was, and is
// listed in the report with the waiver's reason; a waiver that names nothing is listed as unused.
export function applyWaivers(audit: Audit): void {
  const record = audit.waivers;
  if (!record) return;
  for (const w of record.entries) {
    if (WAIVABLE[w.check] === "instructions") {
      for (const item of audit.instructions.filter((i) => i.result === "fail" && !i.waived && matches(w.match, i.source, i.line))) {
        item.waived = { waiver: w.id, reason: w.reason, by: w.by, was: `wrong: ${item.reason ?? item.staticReason ?? "it failed"}` };
        item.result = "not_run";
        item.category = "skipped";
        item.reason = `waived by ${w.id} in ${record.file}: ${w.reason}`;
        item.rule = "waived";
        const ev = audit.evidence.find((e) => e.id === item.evidenceId);
        if (ev && !ev.summary.includes("waived")) ev.summary += `; waived by ${w.id}`;
      }
    } else {
      for (const f of audit.safety.filter((s) => s.blocking && !s.waived && matches(w.match, s.file, s.line))) {
        f.waived = { waiver: w.id, reason: w.reason, by: w.by, was: `blocking: ${f.detail}` };
        f.blocking = false;
        f.rule = "waived";
      }
    }
  }
  const waivedSafety = audit.safety.filter((s) => s.waived).length;
  if (waivedSafety) {
    for (const ev of audit.evidence.filter((e) => e.checkId === "safety.execution_boundary" && e.where === "static" && !e.summary.includes("waived"))) {
      const left = audit.safety.filter((s) => s.blocking).length;
      ev.summary += `; ${waivedSafety} waived in ${record.file}${left ? "" : ", so none blocks"}`;
    }
  }
}

// The waivers that named at least one finding, by id.
export function usedWaivers(audit: Audit): Set<string> {
  return new Set([...audit.instructions.map((i) => i.waived?.waiver), ...audit.safety.map((s) => s.waived?.waiver)].filter((x): x is string => Boolean(x)));
}
