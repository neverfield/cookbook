import { describeRate } from "./outcomes.ts";
import type { Level, ReportJson } from "./types.ts";
import { EMOJI, fmtDate, fmtShortDate, wordCount } from "./util.ts";
import { WAIVER_FILE } from "./waivers.ts";

// Formatters over the sealed report.json. Every fact is derived once, in model.ts; the renderers
// (render.ts and render-html.ts) import only these and types, so they can select and phrase a fact
// but never derive it a second way.

export { EMOJI, WAIVER_FILE, describeRate, fmtDate, fmtShortDate, wordCount };

export function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// The step's own line on waivers, when it fixes findings a waiver can cover.
export function waiverHint(r: ReportJson, itemId: string): string | null {
  const s = r.details.steps.find((x) => x.itemId === itemId)?.steps.find((x) => x.title === "Waive a finding that is a false positive");
  return s ? `If a finding is a false positive, waive it in ${WAIVER_FILE} instead of changing the repo; part 5 says how.` : null;
}

export function scaleLine(r: ReportJson): string {
  const here = r.maturity.assessedComponents === 0 || r.maturity.outcome === "not_assessed" || r.maturity.unproven || r.maturity.status === "undetermined" ? null : r.maturity.level;
  return r.scale.map((s) => (s.level === here ? `[Level ${s.level} ${s.name}]` : `Level ${s.level} ${s.name}`)).join(" > ");
}

// The level the report can mark on the scale, or null when it can't prove one.
export function markedLevel(r: ReportJson): Level | null {
  return r.maturity.assessedComponents === 0 || r.maturity.outcome === "not_assessed" || r.maturity.unproven || r.maturity.status === "undetermined" ? null : r.maturity.level;
}

// Part 1's compact ladder: the scale left to right, with the repo's level bracketed.
export function ladderLine(r: ReportJson): string {
  const here = markedLevel(r);
  const steps = r.scale.map((s) => (s.level === here ? `**[${s.level} ${s.name}]**` : `${s.level} ${s.name}`)).join(" → ");
  return `Level ladder: ${steps}${here === null ? " (no level marked: this audit couldn't give one)" : ""}`;
}

// Levels 3 and 4 rest on agent PR outcomes, which this version tests only in unit tests.
export const EXPERIMENTAL_NOTE = "Levels 3 and 4 are experimental: they measure agent PR outcomes, and this version doesn't yet validate them end to end. Level 2 is the proven top of this version.";

export function isExperimental(level: Level | null | undefined): boolean {
  return level !== null && level !== undefined && level >= 3;
}

// The roadmap's own number for a step, so an action and its roadmap line carry the same number.
export function stepOf(r: ReportJson, itemId: string): number | null {
  return r.roadmap.items.find((i) => i.id === itemId)?.order ?? null;
}

// What the marked level means and what the next one needs, so "not bootable" never stands alone
// next to a headline that says the repo installs and builds.
export function levelDefinition(r: ReportJson): string | null {
  const here = markedLevel(r);
  if (here === null) return null;
  const meaning = r.scale[here].meaning.replace(/\.$/, "");
  const next = here === 0 ? r.details.levelRules.level1 : here === 1 ? r.details.levelRules.level2 : here < 4 ? `Level ${here + 1} (experimental) needs: ${r.scale[here + 1].meaning.charAt(0).toLowerCase()}${r.scale[here + 1].meaning.slice(1).replace(/\.$/, "")}` : null;
  return `Level ${here} means: ${meaning.charAt(0).toLowerCase()}${meaning.slice(1)}.${next ? ` ${next}.` : ""}`;
}

// Page 1's three numbers, compared with what the next level needs. The sealed comparisons stay in
// report.json and in part 5; only the view's wording changes.
export function pageNumbers(r: ReportJson): ReportJson["executive"]["numbers"] {
  const here = markedLevel(r);
  return r.executive.numbers.map((n, i) => {
    if (n.value === "not measured") return { ...n, comparison: "Not measured yet: give the audit read access to pull requests, then rerun it to measure this" };
    if (here !== null && here >= 2 && i === 0) return { ...n, comparison: "Every active component is at Level 2. Level 3 (experimental) is measured on agent PRs, not components" };
    if (here !== null && here >= 2 && i === 2) return { ...n, comparison: "Nothing is below Level 2. Level 3 (experimental) needs agent PRs that meet targets your team sets" };
    // With history the sealed comparison is against past audits; page 1 leads with what Level 2 needs.
    const last = n.comparison.match(/last audit: ([^;.,]+)/i)?.[1];
    if (!last) return n;
    const total = n.value.match(/^\d+ of (\d+)$/)?.[1];
    if (i === 0 && total) return { ...n, comparison: `Level 2 needs ${total} of ${total}; last audit: ${last}` };
    if (i === 2 && /%$/.test(n.value)) return { ...n, comparison: `Level 2 needs 0%; last audit: ${last}, counting the last 90 days` };
    return n;
  });
}

// The first action, as page 1's next move: what it unlocks, its effort and owner, and the decision.
export function nextMove(r: ReportJson): { step: number | null; title: string; unlocks: string; effort: string; decision: string | null; itemId: string; experimental: boolean } | null {
  const a = r.actions[0];
  if (!a) return null;
  const item = r.roadmap.items.find((i) => i.id === a.itemId);
  return { step: stepOf(r, a.itemId), title: a.title, unlocks: a.movesTheNeedle, effort: a.effortAndOwner, decision: a.decision, itemId: a.itemId, experimental: isExperimental(item?.level) };
}

// "Give agents work in alpha", "… in bravo" and so on read as one step for the reader.
export function groupedSteps(items: ReportJson["roadmap"]["items"]): { orders: number[]; title: string; unlocks: string; statusText: string; done: boolean }[] {
  const out: { orders: number[]; title: string; unlocks: string; statusText: string; done: boolean }[] = [];
  const work = items.filter((i) => /^Give agents work in /.test(i.title));
  for (const i of items) {
    if (work.length > 1 && work.includes(i)) {
      if (i !== work[0]) continue;
      const names = work.map((w) => w.title.replace(/^Give agents work in /, ""));
      const statuses = [...new Set(work.map((w) => w.statusText))];
      out.push({ orders: work.map((w) => w.order), title: `Give agents work in ${list(names)}`, unlocks: `measured agent work in ${list(names)}`, statusText: statuses.join(" / "), done: work.every((w) => w.status === "done") });
    } else out.push({ orders: [i.order], title: i.title, unlocks: i.unlocks, statusText: i.statusText, done: i.status === "done" });
  }
  return out;
}

const SPARK = ["▁", "▂", "▄", "▆", "█"];

// One glyph per record, taller for a higher level; a dot where a record gave no level.
export function sparkline(levels: (Level | null | undefined)[]): string {
  return levels.map((l) => (l === null || l === undefined ? "·" : SPARK[l])).join("");
}

function recordLabel(h: { date: string; kind: string; result: string }, level: Level | null | undefined): string {
  const what = level === null || level === undefined ? "no level" : `Level ${level}`;
  return `${fmtShortDate(h.date)} ${what}${h.kind === "recheck" ? ` (recheck${h.result === "failed" ? ", failed" : ""})` : ""}`;
}

// The repo level at every audit and recheck, oldest first.
export function trendLine(r: ReportJson): string {
  const h = r.progress?.history ?? [];
  if (h.length < 2) return "Trend: this is the first audit, so there is no trend yet.";
  return `Trend: ${sparkline(h.map((x) => x.repoLevel))} ${h.map((x) => recordLabel(x, x.repoLevel)).join(" → ")}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return "under 1 s";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// Page 1's account of what the audit took as given, one line per kind of assumption. Null for a
// report sealed before the model carried it.
export function assumptionLines(r: ReportJson): { label: string; text: string }[] | null {
  const a = r.assumptions;
  if (!a) return null;
  const comp = (c: (typeof a.components)[number]) => `\`${c.path}\`${c.manifest ? ` (${c.manifest})` : ""}${c.assessed ? "" : `, not assessed: ${c.note}`}`;
  const cmd = (k: (typeof a.commands)[number]) => `\`${k.command}\` (${k.kind}${k.component === "*" ? "" : `, ${k.component}`}${k.cwd !== "." ? `, in ${k.cwd}` : ""}; from ${k.source})`;
  const lines = [
    { label: "Components", text: a.components.length ? a.components.map(comp).join("; ") : "none found" },
    { label: "Commands", text: a.commands.length ? a.commands.map(cmd).join("; ") : "none: the scan found no command to run" },
    { label: "Where they ran", text: a.environment.text },
  ];
  if (a.toolchains.length) lines.push({ label: "Toolchains the doctor found", text: a.toolchains.map((t) => `${t.where}: ${t.versions}`).join("; ") });
  if (r.details.evidence.some((e) => e.repro)) lines.push({ label: "Reruns", text: `every step that ran has a command in part 5 that reruns it from a clean checkout of ${r.audit.commit}` });
  return lines;
}

// The evidence log in reading order: each current row, then the rows it superseded, oldest first.
export function evidenceLog(r: ReportJson): { row: ReportJson["details"]["evidence"][number]; current: boolean }[] {
  const rows = r.details.evidence;
  const byId = new Map(rows.map((e) => [e.id, e]));
  const finalOf = (e: (typeof rows)[number]): string => {
    let at = e;
    for (let hops = 0; at.supersededBy && byId.has(at.supersededBy) && hops < rows.length; hops++) at = byId.get(at.supersededBy)!;
    return at.id;
  };
  const folded = new Map<string, (typeof rows)[number][]>();
  for (const e of rows) if (e.supersededBy) folded.set(finalOf(e), [...(folded.get(finalOf(e)) ?? []), e]);
  return rows.filter((e) => !e.supersededBy).flatMap((e) => [{ row: e, current: true }, ...(folded.get(e.id) ?? []).map((row) => ({ row, current: false }))]);
}

// One wording for a level result in every view. An unproven result is no level, so it never reads
// as a level the ladder doesn't mark.
export const UNPROVEN_RESULT = "Unproven on this machine (could be 1)";

export const UNDETERMINED_RESULT = "Undetermined: one fact about the repo would settle it";

export function levelResult(row: { level: Level | null; couldBe: Level | null; unproven: boolean; status?: string }, name: (l: Level) => string = (l) => `Level ${l}`): string {
  if (row.status === "undetermined") return UNDETERMINED_RESULT;
  if (row.level === null) return "not assessed";
  if (row.unproven) return UNPROVEN_RESULT;
  return `${name(row.level)}${row.couldBe !== null ? ` (could be ${row.couldBe})` : ""}`;
}

// Page 1's short form, beside a mini ladder.
export function levelShort(row: { level: Level | null; unproven: boolean; status?: string }): string {
  return row.status === "undetermined" ? "Undetermined" : row.unproven ? "Unproven here" : levelText(row.level);
}

export function levelText(l: Level | null | undefined): string {
  return l === null || l === undefined ? "no level" : `Level ${l}`;
}

// This audit's side of a comparison: an unproven result is named as such, not as a drop to Level 0.
export function nowLevelText(l: Level | null, unproven: boolean): string {
  return l === null && unproven ? "unproven on this machine (no level, so not a drop)" : levelText(l);
}

// One line on what changed since the last audit, or null on a first audit.
export function changeSummary(r: ReportJson): string | null {
  const move = changeMove(r);
  if (!move) return null;
  const closed = r.progress!.closed.length;
  return `${move}${closed ? `; ${closed} ${closed === 1 ? "step" : "steps"} closed` : ""}`;
}

// How the repo level moved since the last audit, or null on a first audit.
export function changeMove(r: ReportJson): string | null {
  const ch = r.progress?.changes;
  if (!ch) return null;
  const since = fmtShortDate(ch.since.date);
  const { from, to } = ch.repo;
  const unprovenNow = r.maturity.unproven;
  return from !== null && to === null
      ? `Level ${from} at the audit on ${since}; this audit ${unprovenNow ? "couldn't prove a level on this machine" : "gives no level"}, so it isn't a change in the repo`
      : from === null && to === null
        ? `No level to compare: neither this audit nor the one on ${since} gave one`
        : from === null
          ? `The audit on ${since} gave no level, so Level ${to} has nothing to compare with`
          : from === to
            ? `Unchanged since ${since}`
            : to! > from
              ? `Up from Level ${from} since ${since}`
              : `Down from Level ${from} since ${since}`;
}

// Page 1 names the reason; the missed-fault locations stay in the audit details.
export function shortReason(reason: string): string {
  return reason.split("; missed:")[0];
}

// Signals never set a level; from 2026-12-beta the drive signal can add a later rollout step.
export function signalsNote(r: ReportJson): string {
  return r.details.signals.some((s) => s.id === "drive_app") ? "These don't set a level. Only the drive-the-app signal can add a roadmap step: a later one, for a component already at Level 2." : "These don't set a level or add a roadmap step.";
}
