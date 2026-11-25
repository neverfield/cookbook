import type { Rubric } from "./rubric.ts";
import type { Level, ReportJson } from "./types.ts";
import { EXPERIMENTAL_NOTE, assumptionLines, evidenceLog, fmtDuration, levelResult, levelShort, WAIVER_FILE, changeSummary, describeRate, fmtDate, fmtShortDate, groupedSteps, isExperimental, ladderLine, levelDefinition, levelText, list, markedLevel, nextMove, nowLevelText, pageNumbers, shortReason, signalsNote, sparkline, stepOf, trendLine, waiverHint } from "./format.ts";

export { scaleLine } from "./format.ts";

function levelWord(rubric: Rubric, l: number): string {
  return `${l} ${rubric.scale[l].name}`;
}

function componentTrend(r: ReportJson, id: string): string {
  const h = r.progress?.history ?? [];
  return h.length < 2 ? "first audit" : sparkline(h.map((x) => x.levels[id]));
}

function miniLadder(level: Level | null): string {
  return [0, 1, 2, 3, 4].map((l) => (l === level ? "●" : "○")).join("");
}

function supportLink(doc: string | null): string {
  if (!doc) return "";
  // report.md sits in .agent-readiness/latest/, two folders below the repo root.
  return doc.startsWith("references/") ? ` What the audit supports: ${doc} in the agent-readiness skill.` : ` What the audit supports: [supported.md](../../${doc}).`;
}

// The provenance and eval-mode lines that need no action from a reader; they close the report.
function aboutLines(r: ReportJson): string[] {
  const fromFile = r.details.outcomes !== null && r.details.outcomes.source !== "GitHub through gh";
  const lines: string[] = [];
  if (r.audit.seedPinned) lines.push("Eval run with a pinned seed; not a production result.");
  if (fromFile) lines.push("Outcomes come from a recorded PR file, not GitHub; not a production result.");
  lines.push(`${r.audit.sealStatus}.`);
  if (r.audit.staleCopy) lines.push(r.audit.staleCopy);
  return lines;
}

function keyNote(r: ReportJson): string | null {
  return /unkeyed/.test(r.audit.sealStatus) ? "For signed reports, set SA_READINESS_SEAL_KEY from a CI secret where the audit runs." : null;
}

// What holds a component where it is, and the roadmap step that moves it.
function holdsText(r: ReportJson, c: ReportJson["components"]["included"][number]): string {
  if (c.level !== null && c.level >= 2) return "ready for agents";
  const cap = c.capReasons.find((k) => k.state !== "met");
  const item = r.roadmap.items.find((i) => i.status !== "done" && new RegExp(`(^|, )${c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} to Level`).test(i.unlocks));
  return `${cap ? `${cap.label}: ${shortReason(cap.reason)}`.replace(/\|/g, "\\|") : ""}${item ? ` (step ${item.order})` : ""}`;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// Part 5's account of every result: what ran, where it ran, what happened and the rule behind it.
function explanationLines(r: ReportJson): string[] {
  const ex = r.explanations ?? [];
  if (!ex.length) return [];
  const head = "| Result for | Result | What ran | Where it ran | What happened | Rule |";
  const rows = (kinds: string[]) => ex.filter((e) => kinds.includes(e.kind)).map((e) => `| ${cell(e.subject)} | ${cell(e.result)} | ${cell(e.ran)} | ${cell(e.where)} | ${cell(e.happened)} | ${cell(e.rule)} |`);
  const out = ["### How each result was reached", "", "Every level, every unproven or not-assessed result and every finding, with what ran, where it ran, what happened and the rule that produced the result.", "", "#### Levels", "", head, "|---|---|---|---|---|---|", ...rows(["level", "not_assessed"]), ""];
  const conds = rows(["condition"]);
  if (conds.length) out.push("#### Conditions", "", head, "|---|---|---|---|---|---|", ...conds, "");
  const ins = rows(["instruction"]);
  if (ins.length) out.push("#### Agent instructions", "", "<details><summary>Every instruction item</summary>", "", head, "|---|---|---|---|---|---|", ...ins, "", "</details>", "");
  const saf = rows(["safety"]);
  if (saf.length) out.push("#### Safety findings", "", head, "|---|---|---|---|---|---|", ...saf, "");
  const w = r.waivers;
  if (w) {
    out.push("#### Waivers", "", `Read from ${w.file} at the audited commit${w.digest ? ` (sha256 ${w.digest.slice(0, 12)})` : ""}, never from the working copy. A waiver can't cover a Level 1 check.${w.ignored ? ` ${w.ignored.charAt(0).toUpperCase()}${w.ignored.slice(1)}.` : ""}`, "");
    if (w.applied.length) {
      out.push("| Waiver | Check | Finding | Reviewed by | Reason | Findings waived |", "|---|---|---|---|---|---|");
      for (const a of w.applied) out.push(`| ${cell(a.id)} | \`${a.check}\` | ${cell(a.match)} | ${cell(a.by)} | ${cell(a.reason)} | ${a.findings} |`);
      out.push("");
    }
    if (w.unused.length) out.push(`Unused, because they match no finding in this audit: ${w.unused.map((u) => `${u.id} (${u.match})`).join("; ")}.`, "");
    if (w.rejected.length) out.push(`Refused: ${w.rejected.map((x) => `${x.id} (${x.reason})`).join("; ")}.`, "");
  }
  return out;
}

export function renderMarkdown(r: ReportJson, rubric: Rubric): string {
  const out: string[] = [];
  const ex = r.executive;
  const conf = r.maturity.confidence;
  const noResults = r.maturity.outcome === "not_assessed";
  out.push(`# Agent readiness: ${r.repo}`, "");
  if (r.preview) out.push(`> ${r.preview}`, "");
  for (const n of r.notices ?? []) out.push(`> **Action needed:** ${n.text}`, "");

  // Page 1: where the repo stands, what changed and what to do next. Measures, methodology and
  // provenance are in part 5 and "About this report".
  out.push("## 1. Where am I now", "", `**${ex.heading}.**${changeSummary(r) ? ` ${changeSummary(r)}.` : ""}`, "", `**${ex.headline}**`, "");
  const move = nextMove(r);
  out.push(move ? `> **Next move${move.step !== null ? `, step ${move.step}` : ""}:** ${move.title}${move.experimental ? " (experimental)" : ""}. ${move.unlocks} Effort and owner: ${move.effort}${move.decision ? ` Decision: ${move.decision}.` : ""}` : `> **Next move:** ${ex.ask}`, "");
  out.push(ladderLine(r), "", `${levelDefinition(r) ?? "No level is marked: this audit couldn't give one."} ${EXPERIMENTAL_NOTE}`, "");
  if ((r.progress?.history.length ?? 0) > 2) out.push(trendLine(r), "");
  for (const n of pageNumbers(r)) out.push(`- **${n.label}:** ${n.value}. ${n.comparison}.`);
  out.push("");
  const comps = r.components;
  const listed = comps.excluded.filter((c) => !c.reason.startsWith("not a component"));
  if (comps.included.length + listed.length > 1) {
    out.push("| Component | Level | Ladder 0 to 4 | Share of changes | Trend | What holds it |", "|---|---|---|---|---|---|");
    for (const c of [...comps.included].sort((a, b) => b.changeShare - a.changeShare)) {
      const level = levelShort(c);
      out.push(`| \`${c.id}\` | ${level} | ${c.unproven ? miniLadder(null) : miniLadder(c.level)} | ${Math.round(c.changeShare * 100)}%${c.active ? "" : " (under 10%)"} | ${componentTrend(r, c.id)} | ${holdsText(r, c)} |`);
    }
    for (const c of listed) out.push(`| \`${c.id}\` | not assessed: ${c.reason} | | ${Math.round(c.changeShare * 100)}% | | |`);
    out.push("", "Share of changes: the component's share of changed files over the last 90 days.", "");
  }
  if (ex.unassessed) out.push(`- **Not assessed:** ${ex.unassessed.text}.${supportLink(ex.unassessed.supportDoc)}`, "");
  const assumed = assumptionLines(r);
  if (assumed) out.push("<details><summary>What this audit assumed</summary>", "", ...assumed.map((a) => `- **${a.label}:** ${a.text}.`), "", "</details>", "");

  out.push("## 2. Have I improved", "");
  if (!r.progress) out.push("This is the first audit, so there is nothing to compare yet. Rerun the audit after your first fix to see what changed here.", "");
  else {
    const ch = r.progress.changes;
    if (ch) {
      out.push(`Since the audit on ${fmtDate(ch.since.date)}:`, "");
      const unprovenComp = new Set(r.components.included.filter((c) => c.unproven).map((c) => c.id));
      out.push(`- **Repo level:** ${levelText(ch.repo.from)} to ${nowLevelText(ch.repo.to, r.maturity.unproven)}${ch.repo.from === ch.repo.to ? ", no change" : ""}.`);
      for (const c of ch.components) out.push(`- **${c.id}:** ${levelText(c.from)} to ${nowLevelText(c.to, unprovenComp.has(c.id))}.`);
      if (ch.nowMet.length) out.push(`- **Now met:** ${ch.nowMet.map((m) => `${m.component}: ${m.label}`).join("; ")}.`);
      if (ch.nowFailing.length) out.push(`- **Now failing:** ${ch.nowFailing.map((m) => `${m.component}: ${m.label} (${m.reason})`).join("; ")}.`);
      const word = (ok: boolean | null) => (ok === true ? "passed" : ok === false ? "failed" : "not proven");
      if (ch.checks.length) out.push(`- **Checks that changed:** ${ch.checks.map((c) => `${c.name}, ${word(c.from)} then ${word(c.to)}`).join("; ")}.`);
      if (!ch.components.length && !ch.nowMet.length && !ch.nowFailing.length && !ch.checks.length) out.push("- No component level, condition or check changed.");
    } else out.push("The previous audit's sealed report isn't readable here, so only the levels in part 5 are compared.");
    if (r.progress.closed.length) out.push(`- **Steps closed:** ${r.progress.closed.map((c) => `${c.title} (${fmtShortDate(c.closed)})`).join("; ")}. Part 5 shows what moved after them.`);
    out.push("");
  }

  out.push("## 3. What moves the needle next", "", `> **Recommendation:** ${ex.ask}`, "", ex.nextLine, "");
  if (ex.gaps.length) {
    for (const g of ex.gaps) out.push(`${g.rank}. **${g.text}.** ${g.blocks}.`);
    out.push("");
  }
  r.actions.forEach((a, i) => {
    const item = r.roadmap.items.find((x) => x.id === a.itemId);
    out.push(`### Step ${stepOf(r, a.itemId) ?? a.rank}: ${a.title} (${a.startNow ? "can start now" : i === 0 ? "do first" : "then"}${isExperimental(item?.level) ? ", experimental" : ""})`, "");
    out.push(`- **How it moves the needle:** ${a.movesTheNeedle}`, `- **Why it matters:** ${a.why}`, `- **Effort and owner:** ${a.effortAndOwner}`);
    if (a.decision) out.push(`- **Decision needed:** ${a.decision}.`);
    if (a.dependsOn.length) out.push(`- **Depends on:** ${list(a.dependsOn)}`);
    const hint = waiverHint(r, a.itemId);
    if (hint) out.push(`- **False positives:** ${hint.replace(WAIVER_FILE, `\`${WAIVER_FILE}\``)}`);
    if (a.evidence?.length) out.push(`- **Evidence:** ${a.evidence.map((e) => `\`${e}\``).join(", ")}`);
    out.push("");
  });
  if (r.actions.length === 0) out.push(r.maturity.assessedComponents === 0 ? "No actions can be planned yet: no component could be assessed, so nothing was checked. Part 1 says why." : noResults ? "No actions can be planned yet: this audit has no real check results to plan from. Part 1 says why." : r.maturity.outcome === "blocked" ? `No actions are open: nothing in the repo blocks Level ${r.maturity.level + 1}. Proving it needs a rerun where this machine's limits don't apply, such as CI with Docker.` : "No actions are open.", "");

  out.push("## 4. Roadmap to the max level", "");
  if (noResults) out.push("This audit added no steps, because it has no real check results to plan from. The roadmap is as the last audit left it.", "");
  out.push(`${r.roadmap.doneCount} of ${r.roadmap.total} steps done. Kept in \`.agent-readiness/roadmap.json\`.${r.roadmap.owner ? ` Owner: ${r.roadmap.owner}.` : ""}`, "");
  const here = markedLevel(r);
  const step = (g: ReturnType<typeof groupedSteps>[number]) => `- [${g.done ? "x" : " "}] ${g.orders.length > 1 ? `Steps ${g.orders[0]} to ${g.orders[g.orders.length - 1]}` : `Step ${g.orders[0]}`}: ${g.title}: unlocks ${g.unlocks} (${g.statusText})`;
  for (const L of [1, 2, 3, 4] as Level[]) {
    const s = r.scale[L];
    const state = here !== null && here >= L ? "reached" : (here ?? -1) + 1 === L ? "next" : "later";
    const needs = L === 1 ? r.details.levelRules.level1 : L === 2 ? r.details.levelRules.level2 : `Level ${L} means: ${s.meaning.charAt(0).toLowerCase()}${s.meaning.slice(1).replace(/\.$/, "")}`;
    out.push(`### Level ${L}, ${s.plain} (${state}${isExperimental(L) ? ", experimental" : ""})`, "", `${needs}.`, "");
    const items = groupedSteps(r.roadmap.items.filter((i) => i.level === L));
    if (items.length) out.push(...items.map(step), "");
    else if (state !== "reached") out.push(state === "next" ? "No step is open for it in the roadmap yet." : "Its steps are added once the level below it is reached.", "");
  }
  const every = groupedSteps(r.roadmap.items.filter((i) => i.level === null || i.level === undefined));
  if (every.length) out.push("### For every level", "", ...every.map(step), "");

  out.push("## 5. Audit details: exact steps and everything we checked", "");
  out.push("### Measures", "", `Confidence: ${conf.level} (${conf.reasons.join("; ")}).`, "");
  for (const n of ex.numbers) out.push(`- **${n.label}:** ${n.value}. ${n.comparison}.`);
  out.push("", ex.coverage, "");
  if (r.progress) {
    const keys = Object.keys(r.progress.history[r.progress.history.length - 1].levels);
    out.push("### Levels over time", "", "| Date | Record | Repo | " + keys.join(" | ") + " |", "|---|---|---|" + keys.map(() => "---|").join(""));
    const cell = (v: Level | null | undefined) => (v === undefined ? "-" : v === null ? "not assessed" : String(v));
    for (const h of r.progress.history) out.push(`| ${fmtShortDate(h.date)} | ${h.kind}${h.result === "failed" ? " failed" : ""}${h.note ? `, ${h.note}` : ""} | ${cell(h.repoLevel)} | ${keys.map((k) => cell(h.levels[k])).join(" | ")} |`);
    out.push("", "A failed recheck lowers a level and a later passing recheck restores it. Only an audit can raise a level above the last audit.", "");
    if (r.progress.rubricChanges.length) out.push(`Rubric changes: ${r.progress.rubricChanges.map((c) => `${fmtShortDate(c.date)} ${c.from} to ${c.to}`).join("; ")}. A level change at a rubric change can come from the rubric, not the repo.`, "");
    if (r.progress.closed.length) {
      out.push("### What each closed step was expected to move, and what moved after it", "", "| Step | Closed | Expected | Observed after |", "|---|---|---|---|");
      for (const c of r.progress.closed) out.push(`| ${c.title} | ${fmtShortDate(c.closed)} | ${c.expected} | ${c.observed} |`);
      out.push("", "Movement after a step closed, not proof that the step caused it. Each step shows its own measure; steps closed in the same audit share the window after it, so a change can't be credited to one of them.", "");
    }
    if (r.progress.weakening) out.push(r.progress.weakening, "");
  }
  if (r.matrix.points.length) {
    out.push(`Effort against impact (impact is the share of recent changes an action unblocks): ${r.matrix.points.map((p) => `${p.label} (${p.quadrant ? `${p.quadrant}: ` : ""}effort ${p.x <= 0.35 ? "small" : p.x <= 0.7 ? "medium" : "large"}, ${Math.round((p.impact ?? p.y) * 100)}%)`).join("; ")}.`, "");
  }
  for (const s of r.details.steps) {
    const a = r.actions.find((x) => x.itemId === s.itemId);
    out.push(`### Steps for ${s.title} (step ${stepOf(r, s.itemId) ?? ""})`, "");
    if (a) out.push(`- **What to watch:** ${a.watch}`, `- **Done when:** ${a.doneWhen}`, "");
    s.steps.forEach((st, i) => out.push(`${i + 1}. **${st.title}.** ${st.detail}`));
    out.push("");
  }
  out.push("### Everything we checked, and why", "", "| Check | Why it matters | Result | Evidence |", "|---|---|---|---|");
  for (const c of r.details.checks) {
    const src = c.sources.map((s) => ` ${s.claim} ${s.caveat} ([source](${s.url}))`).join("");
    const result = c.ok === false ? c.result.split("; ").map((part) => (/^(failed|toolchain|lockfile):/.test(part) ? `**${part}**` : part)).join("; ") : c.result;
    out.push(`| ${c.name} (\`${c.id}\`) | ${c.why}${src} | ${result} | ${c.evidence.slice(0, 6).map((e) => `\`${e}\``).join(", ")}${c.evidence.length > 6 ? ` and ${c.evidence.length - 6} more` : ""} |`);
  }
  out.push("", `Not assessed by this rubric version, which is different from unknown: ${list(r.details.notAssessed.map((n) => n.charAt(0).toLowerCase() + n.slice(1)))}.`, "");
  const levelCell = (level: Level | null, couldBe: Level | null, unproven = false, status?: string) => levelResult({ level, couldBe, unproven, status }, (l) => levelWord(rubric, l));
  out.push("### Levels by component", "", `Repo shape: ${comps.shape === "sampled_monorepo" ? "monorepo, sampled (only the most active supported components are assessed)" : comps.shape}. Each component gets one standard level; scenarios someone added appear under the components they cover.`, "", "| Component | Path | Toolchain | Manifest | Lockfile | Share of changes | Level |", "|---|---|---|---|---|---|---|");
  const file = (f: string | null) => (f ? `\`${f}\`` : "none");
  for (const c of comps.included) {
    out.push(`| \`${c.id}\`${c.active ? "" : " (under 10%)"} | \`${c.path}\` | ${c.toolchain} | ${file(c.manifest)} | ${file(c.lockfile)} | ${Math.round(c.changeShare * 100)}% | ${levelCell(c.level, c.couldBe, c.unproven, c.status)} |`);
    for (const s of c.scenarios) out.push(`| \`${c.id}\` › ${s.label} | | | | | | ${levelCell(s.level, s.couldBe, s.unproven)} |`);
  }
  for (const c of comps.excluded) out.push(`| \`${c.id}\` | \`${c.path}\` | ${c.toolchain} | ${file(c.manifest)} | ${file(c.lockfile)} | ${c.reason.startsWith("not a component") ? "n/a" : `${Math.round(c.changeShare * 100)}%`} | not assessed: ${c.reason} |`);
  out.push("", `Repo level: ${levelResult({ level: noResults ? null : r.maturity.level, couldBe: null, unproven: r.maturity.unproven, status: r.maturity.status }, (l) => levelWord(rubric, l))}. ${r.maturity.rule}`, "");
  if (r.maturity.capReasons.length) {
    out.push(r.maturity.unproven ? "What keeps Level 1 unproven on this machine:" : `What holds the repo at Level ${r.maturity.level}:`, "");
    for (const c of r.maturity.capReasons) out.push(`- ${c.component === "*" ? "Repo" : `\`${c.component}\``}: ${c.label}, ${c.state === "blocked" ? "blocked on this machine" : c.state === "unknown" ? "not proven" : "not met"} (${c.reason}).`);
    out.push("");
  }
  out.push(`- **Standard level:** ${r.details.levelRules.level1}. ${r.details.levelRules.level2}.`);
  for (const s of r.details.levelRules.scenarios) out.push(`- **${s.label} scenario:** ${s.bar}.`);
  out.push("");
  const oc = r.details.outcomes;
  out.push("### Agent PR outcomes", "");
  if (oc) {
    out.push(`${oc.window}. Agent PRs are matched by ${oc.filter}. Source: ${oc.source}.`, "", "| Measure | " + oc.series.map((s) => s.label).join(" | ") + " |", "|---|" + oc.series.map(() => "---|").join(""));
    out.push(`| Opened | ${oc.series.map((s) => s.opened).join(" | ")} |`);
    out.push(`| Merged | ${oc.series.map((s) => describeRate(s.merged)).join(" | ")} |`);
    out.push(`| Passed CI the first time | ${oc.series.map((s) => describeRate(s.firstTimeCi)).join(" | ")} |`);
    out.push(`| Reviewer requested changes | ${oc.series.map((s) => describeRate(s.changesRequested)).join(" | ")} |`);
    out.push(`| Median days to merge | ${oc.series.map((s) => (s.medianDaysToMerge === null ? "n/a" : String(s.medianDaysToMerge))).join(" | ")} |`);
    if (oc.reverts) out.push(`| Reverted within ${oc.reverts.days} days | ${oc.series.map((s) => (s.reverted ? describeRate(s.reverted) : "not measured")).join(" | ")} |`);
    out.push("", "| Component | Agent PRs | Passed CI the first time | Changes requested |", "|---|---|---|---|");
    for (const c of oc.byComponent) out.push(`| \`${c.component}\` | ${c.prs} | ${describeRate(c.firstTimeCi)} | ${describeRate(c.changesRequested)} |`);
    out.push("", `${oc.multiComponentNote} ${oc.caveat}`, "", `Matched PRs: ${oc.matchedPrs.map((n) => `#${n}`).join(", ") || "none"}.`, "");
    if (oc.reverts) out.push(`${oc.reverts.note}${oc.reverts.agent.length ? ` Reverted agent PRs: ${oc.reverts.agent.map((x) => `#${x.number} (by ${x.by})`).join(", ")}.` : ""}`, "");
  } else out.push("Not measured: outcomes need the external-systems tier and `readiness outcomes`.", "");
  out.push("### Agent assets already in the repo", "");
  if (r.details.assets.length) {
    out.push("| Asset | Path | Authors | Last changed | Status |", "|---|---|---|---|---|");
    for (const a of r.details.assets) out.push(`| ${a.kind} | \`${a.path}\` | ${a.authors.join(", ") || "unknown"} | ${a.lastChanged ? fmtShortDate(a.lastChanged) : "n/a"} | ${a.status} |`);
    out.push("");
  }
  if (r.details.missingAssets.length) out.push(`Missing: ${list(r.details.missingAssets)}.`, "");
  if (r.details.signals.length) {
    out.push("### Other signals (informational, not scored)", "", "| Signal | Found | Detail |", "|---|---|---|");
    for (const s of r.details.signals) out.push(`| ${s.label} | ${s.found === null ? "n/a" : s.found ? "yes" : "no"} | ${s.detail.replace(/\|/g, "\\|")} |`);
    out.push("", signalsNote(r), "");
  }
  out.push(...explanationLines(r));
  // Five columns: where a check ran goes with its result, and a check read from files names no command.
  out.push("### Evidence log", "", "<details><summary>All evidence</summary>", "", "| ID | Check | Component | What ran | Result |", "|---|---|---|---|---|");
  for (const { row: e, current } of evidenceLog(r)) {
    const where = `${e.where}${typeof e.durationMs === "number" ? `, ${fmtDuration(e.durationMs)}` : ""}`;
    const ran = e.ran === e.summary ? `(${where})` : `${e.ran.replace(/\|/g, "\\|").slice(0, 120)} (${where})`;
    const result = `${e.result}: ${e.summary.replace(/\|/g, "\\|").slice(0, 160)}`;
    out.push(`| \`${e.id}\` | \`${e.check}\` | ${e.component ?? "repo"} | ${ran} | ${current ? result : `superseded by \`${e.supersededBy}\`; was ${result}`} |`);
  }
  const reruns = r.details.evidence.filter((e) => e.repro && !e.supersededBy);
  if (reruns.length) out.push("", `Rerun a step from a clean checkout of \`${r.audit.commit}\`:`, "", ...reruns.map((e) => `- \`${e.id}\`: \`${e.repro!.replace(/`/g, "'")}\``));
  out.push("", "</details>", "", "Evidence strength, weakest to strongest: stated in docs, read from files, ran on host, ran in a clean container or on a disposable VM, confirmed by outcomes. A check passes only at its required strength.", "");

  out.push("## About this report", "", `Audited ${fmtDate(r.audit.date)} at ${r.audit.commit}. ${aboutLines(r).join(" ")}`, "");
  for (const x of r.details.record) out.push(`- **${x.label}:** ${x.value}`);
  out.push("");
  const key = keyNote(r);
  out.push("---", "", `Generated from \`report.json\` by the agent-readiness skill; \`report.html\` is the same report as a page.${key ? ` ${key}` : ""}`, "");
  return out.join("\n");
}
