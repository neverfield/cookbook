import type { Rubric } from "../../../skill/agent-readiness/scripts/lib/rubric.ts";
import type { ReportJson } from "../../../skill/agent-readiness/scripts/lib/types.ts";
import { EMOJI, list, wordCount } from "../../../skill/agent-readiness/scripts/lib/format.ts";

// Part 1's wording rules, as a grader of the report the scripts wrote. From rubric 2026-12-beta the
// seal no longer applies them: part 1 is written by templates from the narration's slots, so these
// check the templates. A rubric without the gap limit gets the one 2026-11-beta set.

const MAX_GAP_WORDS = 22;

export function validatePart1(report: ReportJson, rubric: Rubric): string[] {
  const errors: string[] = [];
  const ex = report.executive;
  const maxHeadline = rubric.part1.maxHeadlineWords;
  const maxGap = rubric.part1.maxGapWords ?? MAX_GAP_WORDS;
  if (wordCount(ex.headline) > maxHeadline) errors.push(`headline has ${wordCount(ex.headline)} words; the limit is ${maxHeadline}`);
  if (ex.gaps.length > rubric.part1.maxGaps) errors.push(`part 1 has ${ex.gaps.length} gaps; the limit is ${rubric.part1.maxGaps}`);
  for (const g of ex.gaps) if (wordCount(g.text) > maxGap) errors.push(`gap "${g.text}" has more than ${maxGap} words`);
  const fields: [string, string][] = [
    ["heading", ex.heading],
    ["headline", ex.headline],
    ["nextLine", ex.nextLine],
    ["ask", ex.ask],
    ["coverage", ex.coverage],
    ...(ex.unassessed ? [["not assessed line", ex.unassessed.text] as [string, string]] : []),
    ...ex.gaps.map((g) => ["gap", g.text] as [string, string]),
    ...ex.numbers.flatMap((n) => [["number label", n.label], ["number", n.value], ["comparison", n.comparison]] as [string, string][]),
  ];
  for (const [name, text] of fields) {
    if (text.includes("`")) errors.push(`${name} uses code formatting`);
    if (EMOJI.test(text)) errors.push(`${name} uses an emoji; say the status in words`);
    if (/\bev-\d+/.test(text)) errors.push(`${name} cites an evidence id`);
    if (/\b(bootstrap|verify|context|safety|scope)\.[a-z_]+/.test(text)) errors.push(`${name} names a check id`);
    for (const term of rubric.part1.bannedTerms) if (text.toLowerCase().includes(term.toLowerCase())) errors.push(`${name} uses the banned term "${term}"`);
    let masked = text;
    for (const lvl of [...(rubric.part1.levelNames ?? rubric.scale.map((s) => s.name))].sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`\\b${lvl}\\b`, "gi");
      for (const m of [...masked.matchAll(re)]) {
        const before = masked.slice(0, m.index);
        if (!/Level [0-4](?: of 4)?, $/i.test(before)) errors.push(`${name} uses the level name "${lvl}" without its level number`);
      }
      masked = masked.replace(re, (s) => "#".repeat(s.length));
    }
  }
  errors.push(...headlineCauseErrors(report));
  return errors;
}

// Every cause the headline names for a component must match that component's condition states, so
// the headline never says a component fails what was only blocked, or couldn't be proved what failed.
export function headlineCauseErrors(report: ReportJson): string[] {
  const text = report.executive.headline;
  const comps = report.components.included;
  const byId = new Map(comps.map((c) => [c.id, c]));
  const ids = [...byId.keys()].sort((a, b) => b.length - a.length);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = (segment: string): string[] => {
    const out: string[] = [];
    let rest = segment;
    for (const id of ids) {
      const re = new RegExp(`(^|[^\\w@/.-])${esc(id)}(?![\\w@/-])`);
      if (re.test(rest)) {
        out.push(id);
        rest = rest.replace(new RegExp(`(^|[^\\w@/.-])${esc(id)}(?![\\w@/-])`, "g"), "$1#");
      }
    }
    return out;
  };
  const states = (id: string, cond: string) => byId.get(id)!.capReasons.filter((k) => k.condition === cond).map((k) => k.state);
  const errors: string[] = [];
  const failed = (id: string, cond: string, claim: string) => {
    if (!states(id, cond).includes("not_met")) errors.push(`the headline says ${id} ${claim}, but its ${cond} condition is ${states(id, cond)[0] ?? "met or not what holds it"}`);
  };
  // "<names> <phrase>" clauses: the names are those between the previous clause and this phrase.
  const PHRASES: [RegExp, string, string][] = [
    [/\b(?:doesn't|don't) install from a clean checkout/g, "clean.install", "doesn't install"],
    [/\b(?:has|have) no tests/g, "clean.test", "has no tests"],
    [/\b(?:doesn't|don't) build from a clean checkout/g, "clean.build", "doesn't build"],
    [/\bfails? (?:its|their) tests from a clean checkout/g, "clean.test", "fails its tests"],
    [/\bcouldn't be checked on this machine/g, "", "couldn't be checked"],
  ];
  const hits = PHRASES.flatMap(([re, cond, claim]) => [...text.matchAll(re)].map((m) => ({ at: m.index!, end: m.index! + m[0].length, cond, claim }))).sort((a, b) => a.at - b.at);
  let from = 0;
  for (const h of hits) {
    for (const id of named(text.slice(from, h.at))) {
      if (h.cond) failed(id, h.cond, h.claim);
      else if (byId.get(id)!.capReasons.some((k) => k.state === "not_met")) errors.push(`the headline says ${id} couldn't be checked, but a condition failed for it`);
    }
    from = h.end;
  }
  const tests = text.match(/Agents can't pass the tests in (.+?) from a clean checkout/);
  if (tests) for (const id of named(tests[1])) failed(id, "clean.test", "fails its tests");
  const proved = text.match(/Level \d couldn't be proved for (.+?)(?: because| on this machine|:|\.)/);
  if (proved) for (const id of named(proved[1])) if (byId.get(id)!.capReasons.some((k) => k.state === "not_met")) errors.push(`the headline says Level couldn't be proved for ${id}, but a condition failed for it`);
  const build = text.match(/Agents can build and test (.+?), but (.+?)(?:; |, and \d|\.|$)/);
  if (build) {
    const BUT: [RegExp, string][] = [[/commands? fails?/, "commands"], [/can't yet catch wrong changes/, "faults"], [/agent instructions don't match/, "instructions"], [/secret is committed|production access/, "safety"]];
    const subjects = named(build[1]);
    for (const [re, cond] of BUT) if (re.test(build[2]) && subjects.length && !subjects.some((id) => states(id, cond).includes("not_met"))) errors.push(`the headline says ${list(subjects)} ${cond === "faults" ? "can't catch wrong changes" : `fail${subjects.length > 1 ? "" : "s"} ${cond}`}, but no ${cond} condition failed there`);
  }
  const ready = text.match(/Nothing blocks agents in (.+?):/);
  if (ready) for (const id of named(ready[1])) if ((byId.get(id)!.level ?? 0) < 2) errors.push(`the headline says nothing blocks ${id}, but it is below Level 2`);
  return errors;
}
