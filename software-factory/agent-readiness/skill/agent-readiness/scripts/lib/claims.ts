import { list } from "./format.ts";
import { blockedBy } from "./score.ts";
import { NOT_SUPPORTED } from "./support.ts";
import type { Audit, ReportJson } from "./types.ts";

const NO_RESULT = /\bno (?:check|checks)\b[^.;:]{0,30}?\b(?:results?|ran|could run|was run|were run)\b|\bnothing (?:produced|gave) (?:a |any )?(?:real )?results?\b/i;

const CLEAN_CONTAINER = /\b(?:clean|fresh) container\b/i;

const INSTRUCTIONS_OK = /\binstructions?\b[^.;:]{0,30}?\b(?:check(?:s|ed)? out|are (?:accurate|correct|right|up to date)|all pass(?:ed)?)\b/i;

const RERUN = /\b(?:re-?runs?|run (?:it |them |this |the audit |the checks )?again|re-?audits?|another machine|a machine (?:with|that|where)|where (?:docker|podman|the network|network|the image|it|they|these)|in CI|open network|with (?:docker|podman|network))\b/i;

// Narrated claims the audit's own records contradict, which a reader can't check from the text:
// that no check gave a result when one did, that commands ran in a clean container when none
// did, and a level unproven or blocked on this machine with no word on where a rerun can prove it.
// Only for narration: the scripts' default wording is built from these records.
export function narrationClaimErrors(report: ReportJson, audit: Audit): string[] {
  const n = audit.narration;
  if (!n) return [];
  const texts = ([["headline", n.headline ?? ""], ["ask", n.ask ?? ""], ...Object.values(n.gaps ?? {}).map((g) => ["gap", g])] as [string, string][]).filter(([, t]) => t.trim());
  const errors: string[] = [];
  const gave = report.details.checks.filter((c) => c.counts.passed + c.counts.failed > 0);
  const instructions = report.details.checks.find((c) => c.id === "context.instructions_verified");
  const counted = instructions ? /^(\d+) of (\d+) /.exec(instructions.result) : null;
  const partial = instructions && (/\b(wrong|not run)\b/.test(instructions.result) || (counted !== null && counted[1] !== counted[2])) ? instructions.result : null;
  for (const [name, t] of texts) {
    if (partial && INSTRUCTIONS_OK.test(t) && !/\b\d+ of \d+ instruction/i.test(t)) errors.push(`the ${name} says the instructions check out, but the audit found ${partial}; give that count instead`);
    if (gave.length && NO_RESULT.test(t)) errors.push(`the ${name} says no check gave a result, but ${list(gave.map((c) => c.name.toLowerCase()))} did (${gave[0].result}); say which repo commands couldn't run instead`);
    if (CLEAN_CONTAINER.test(t) && !audit.evidence.some((e) => e.where === "container" && e.result !== "not_run")) errors.push(`the ${name} says something ran in a clean container, but no command ran in one in this audit`);
    // Delegable is Level 3's name, so "delegate" below it reads as a claim of Level 3.
    if (report.maturity.level < 3 && /\bdelegat\w*/i.test(t)) errors.push(`the ${name} says "delegate", but Delegable is Level 3's name and the repo is at Level ${report.maturity.level}; say "give agents work there" instead`);
  }
  const m = report.maturity;
  // As in rerunAdvice: a block only support for the stack can lift needs no rerun advice.
  const unsupported = audit.evidence.some((e) => NOT_SUPPORTED.test(blockedBy(e) ?? ""));
  if (n.headline && (m.unproven || m.outcome === "blocked") && !unsupported && !RERUN.test(n.headline)) errors.push("the level is unproven or blocked on this machine, so the headline must say where a rerun can prove it, for example on a machine with Docker, with open network access, or in CI");
  return errors;
}

export function danglingEvidence(report: ReportJson, audit: Audit): string[] {
  const known = new Set(audit.evidence.map((e) => e.id));
  const cited = new Set([...JSON.stringify(report).matchAll(/\bev-\d{3,}\b/g)].map((m) => m[0]));
  return [...cited].filter((id) => !known.has(id)).sort();
}

// Every number the audit itself reports, from the parts of the report narration doesn't write
// (the headline, ask, gaps and titles are left out).
export function allowedNumbers(report: ReportJson): Set<string> {
  const set = new Set<string>();
  const ex = report.executive;
  const computed = {
    numbers: ex.numbers,
    nextLine: ex.nextLine,
    coverage: ex.coverage,
    unassessed: ex.unassessed,
    maturity: report.maturity,
    components: report.components,
    actions: report.actions.map(({ title: _title, ...rest }) => rest),
    roadmap: report.roadmap.items.map((i) => [i.unlocks, i.statusText]),
    progress: report.progress,
    checks: report.details.checks.map((c) => [c.result, c.counts]),
    evidence: report.details.evidence.map((e) => e.summary),
    outcomes: report.details.outcomes,
  };
  for (const m of JSON.stringify(computed).matchAll(/\d+(?:\.\d+)?%?/g)) set.add(m[0]);
  for (const c of report.components.included) set.add(`${Math.round(c.changeShare * 100)}%`);
  for (const a of report.actions) if (a.impact > 0) set.add(`${Math.round(a.impact * 100)}%`);
  const setBy = report.components.included.filter((c) => report.maturity.setBy.includes(c.id)).reduce((s, c) => s + c.changeShare, 0);
  if (setBy > 0) set.add(`${Math.round(setBy * 100)}%`);
  for (let i = 0; i <= 4; i++) set.add(String(i));
  return set;
}
