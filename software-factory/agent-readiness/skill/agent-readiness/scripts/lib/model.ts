import { attributes } from "./attribute.ts";
import { serviceLabel } from "./diagnose.ts";
import { explanationsOf, imagesUsed, waiversOf } from "./explain.ts";
import { list } from "./format.ts";
import { LANGUAGE_LABELS } from "./languages/index.ts";
import type { LevelResult } from "./levels.ts";
import { describeRate, rate, windowLabel } from "./outcomes.ts";
import { PREVIEW } from "./preview.ts";
import { watchFor } from "./roadmap.ts";
import type { Rubric } from "./rubric.ts";
import type { CompStates } from "./score.ts";
import { UNDETERMINED, blockedBy, checkCounts, gatingInstruction } from "./score.ts";
import { sampledScope } from "./scope.ts";
import type { ComponentResult } from "./seal.ts";
import { NOT_SUPPORTED, STACKS, SUPPORTED_DOC } from "./support.ts";
import type { Asset, Audit, CondId, Component, ComponentLevel, HistoryLine, Level, LevelStatus, OutcomeStats, OutcomesSnapshot, ReportAction, ReportChanges, ReportJson, RevertsSnapshot, Roadmap, RoadmapItem, ScenarioId, SettleBy } from "./types.ts";
import { fmtShortDate, pct, wordCount } from "./util.ts";
import { WAIVER_FILE } from "./waivers.ts";

// The report model, built once from the audit: every state, count, level and sentence the report
// shows. report.json is this model; render.ts and render-html.ts only lay it out.

export interface ModelInput {
  audit: Audit;
  rubric: Rubric;
  components: Component[];
  states: Map<string, CompStates>;
  levels: Map<string, ComponentResult>;
  scenarioLevels: Map<string, Map<ScenarioId, LevelResult>>;
  rollup: { level: Level; couldBe: Level | null; setBy: string[]; outcomeReasons: string[]; undetermined?: boolean };
  active: Set<string>;
  roadmap: Roadmap;
  top: RoadmapItem[];
  startNow: RoadmapItem | null;
  history: HistoryLine[];
  currentLine: HistoryLine;
  previousOutcomes: { window: string; agent: OutcomeStats } | null;
  weakening: string | null;
  sealStatus: string;
  staleCopy: string | null;
  storedAt: string;
  partial: { partial: boolean; unassessedShare: number };
  // Why the audit has no real check results to give a level from, or null when it has some.
  noResults?: string | null;
  // references/supported.md as a repo-relative path when the skill is installed in the repo.
  supportDoc?: string | null;
  // The previous audit's sealed report, for what changed since; null on a first audit or when it can't be read.
  previousReport?: ReportJson | null;
}

const STATUS_TEXT: Record<RoadmapItem["status"], string> = { done: "done", in_progress: "in progress", next: "next", start_now: "can start now", waiting: "waiting", later: "later" };

function condLabel(rubric: Rubric, c: CondId): string {
  return rubric.conditions[c].label;
}

// The rubric's labels name every command kind; say only what these components' contracts run.
function condPhrase(input: ModelInput, c: CondId, comps: string[]): string | null {
  const has = (kind: string) => input.audit.contract.some((k) => k.kind === kind && comps.includes(k.component));
  if (c === "clean.build" && !has("build")) return null;
  if (c === "commands") {
    const kinds = ["build", "lint", "typecheck", "test"].filter(has);
    if (kinds.length > 0 && kinds.length < 4) return `${list(kinds.map((k) => (k === "typecheck" ? "type-check" : k)))} commands pass`;
  }
  return condLabel(input.rubric, c);
}

function statusText(item: RoadmapItem, roadmap: Roadmap): string {
  if (item.status === "done") return item.closedAt ? `done ${fmtShortDate(item.closedAt)}` : "done";
  if (item.status === "waiting") {
    const orders = item.dependsOn.map((d) => roadmap.items.find((i) => i.id === d)?.order).filter((x): x is number => typeof x === "number");
    return orders.length ? `waiting on step ${list(orders.map(String))}` : "waiting";
  }
  return STATUS_TEXT[item.status];
}

function researchFor(rubric: Rubric, item: RoadmapItem): string | null {
  const cond = item.fixes[0]?.condition;
  if (!cond) return null;
  const checkId = rubric.templates[item.template]?.researchCheck ?? rubric.conditions[cond].check;
  const check = rubric.checks.find((c) => c.id === checkId);
  const src = check?.sources[0];
  return src ? `${src.claim} ${src.caveat} ${src.url}` : null;
}

function metricLabel(metric: string, scope = "repo"): string {
  const [m, pattern] = metric.split(":");
  const prs = scope === "repo" ? "agent PRs" : `agent PRs touching ${scope}`;
  if (m === "first_time_ci_pass") return `Share of ${prs} that pass CI the first time`;
  if (m === "changes_requested") return `Share of ${prs} where a reviewer requested changes`;
  if (m === "prs_adding_path") return `${prs.charAt(0).toUpperCase() + prs.slice(1)} that add a stray ${pattern}`;
  if (m === "reverted") return `Share of merged ${prs} reverted soon after merging`;
  return `Merged ${prs}`;
}

// How part 3's revert row was measured, so a reader knows what it can miss and that nothing gates on it.
export function revertNote(r: RevertsSnapshot): string {
  if (r.unavailable) return `Reverts weren't measured: ${r.unavailable}.`;
  const recent = r.mergedRecently ? ` ${r.mergedRecently} of the merged agent PRs merged less than ${r.days} days before the window ended, so they had less time to be reverted.` : "";
  return `Reverted within ${r.days} days counts merged PRs whose first revert landed within ${r.days} days of the merge. A revert is a merged PR whose body says "Reverts #123" or whose title is Revert "<the PR's title>", or a commit on the default branch that says "This reverts commit <the merge commit>"; a revert squashed without that line isn't seen, so these are detected reverts.${recent}${r.limited ? ` ${r.limited}.` : ""} Reported only: no level or target uses it yet.`;
}

function watchLine(item: RoadmapItem, rubric: Rubric, outcomes: OutcomesSnapshot | null): string {
  const w = item.expected.watch;
  const label = metricLabel(w.metric, w.scope);
  const [metric, pattern] = w.metric.split(":");
  const now = outcomes ? watchFor(metric, w.scope, outcomes, rubric, pattern) : null;
  const baseline = `${w.baseline}${w.window ? `, ${w.window}` : ""}`;
  if (!now || (now.window === w.window && now.baseline === w.baseline)) return `${label}. Now: ${baseline}.`;
  return `${label}. Baseline: ${baseline}. Now: ${now.baseline}, ${now.window}.`;
}

function action(item: RoadmapItem, rank: number, rubric: Rubric, roadmap: Roadmap, startNow: boolean, outcomes: OutcomesSnapshot | null): ReportAction {
  return {
    rank,
    itemId: item.id,
    title: item.title,
    startNow,
    why: item.why,
    movesTheNeedle:
      item.kind === "fix"
        ? `${item.impact > 0 ? `Takes ${item.unlocks}, covering ${pct(item.impact, 1)}% of recent changes` : item.unlocks.includes(" together with ") ? `Takes ${item.unlocks}` : `Changes no level on its own: ${item.unlocks}`}. ${item.expected.outcome}`
        : `Unlocks ${item.unlocks}. ${item.expected.outcome}`,
    watch: watchLine(item, rubric, outcomes),
    research: researchFor(rubric, item),
    effortAndOwner: `${item.size}. ${item.ownerRole}.`,
    decision: item.decision,
    doneWhen: item.doneWhen,
    dependsOn: item.dependsOn.map((d) => roadmap.items.find((i) => i.id === d)?.title ?? d),
    impact: item.impact,
    effort: item.effort,
    evidence: item.evidence,
  };
}

// The level of the scale a roadmap step is part of reaching: the lowest level whose conditions it
// fixes. Steps such as naming an owner serve every level.
function itemLevel(rubric: Rubric, item: RoadmapItem): Level | null {
  // Targets define Level 3, and giving agents work is what produces the PRs it is measured on. A
  // way to drive the app isn't scored, so it is part of no level.
  if (item.template === "drive") return null;
  if (item.template === "targets" || item.kind === "rollout") return 3;
  const conds = item.fixes.map((f) => f.condition);
  if (conds.some((c) => rubric.level1.includes(c))) return 1;
  if (conds.some((c) => rubric.level2.includes(c))) return 2;
  return null;
}

// A not-assessed reason reads after "because": "outside the 6 most active components" needs a subject.
function becauseOf(reason: string): string {
  return /^outside /.test(reason) ? `it's ${reason}` : reason;
}

function compLevel(input: ModelInput, id: string): ComponentResult | undefined {
  return input.levels.get(id);
}

// With nothing assessed, every level rule is vacuously met and every count is 0 of 0.
function noneAssessed(input: ModelInput): boolean {
  return !input.components.some((c) => c.assessed);
}

// No real results, no level: the report says why and plans nothing.
function notAssessed(input: ModelInput): boolean {
  return noneAssessed(input) || Boolean(input.noResults);
}

function nextConds(input: ModelInput): CondId[] {
  const L = input.rollup.level;
  return L === 0 ? input.rubric.level1 : L === 1 ? input.rubric.level2 : [];
}

function capComps(input: ModelInput): string[] {
  return input.rollup.setBy.length ? input.rollup.setBy : [...input.active];
}

function outcomeOf(input: ModelInput): ReportJson["maturity"]["outcome"] {
  if (notAssessed(input)) return "not_assessed";
  const blocked = capComps(input).some((id) => nextConds(input).some((c) => input.states.get(id)?.[c].state === "blocked"));
  return blocked ? "blocked" : "proven";
}

// Each condition that holds the level where it is, by name, so nobody has to infer what stopped it.
function capReasons(input: ModelInput): ReportJson["maturity"]["capReasons"] {
  if (notAssessed(input)) return [];
  const { rubric, rollup } = input;
  if (rollup.level >= 2) return rollup.level < 4 ? rollup.outcomeReasons.map((r) => ({ component: "*", condition: "outcomes", label: outcomeLabel(rollup.level), state: "not_met" as const, reason: r })) : [];
  const out: ReportJson["maturity"]["capReasons"] = [];
  for (const id of capComps(input)) {
    for (const c of nextConds(input)) {
      const s = input.states.get(id)?.[c];
      if (!s || s.state === "met") continue;
      const component = rubric.conditions[c].scope === "repo" ? "*" : id;
      if (out.some((x) => x.component === component && x.condition === c)) continue;
      out.push({ component, condition: c, label: condLabel(rubric, c), state: s.state, reason: s.reason });
    }
  }
  return out;
}

function vmEnvironmentNote(audit: Audit): string {
  const pe = audit.environment.proofEnv;
  const by = pe?.detectedBy?.length ? `, detected by ${pe.detectedBy.join(" and ")}` : "";
  const net = pe?.network === "cut" ? "network cut for the tests" : pe?.network === "on" ? "network on for the tests, because the VM couldn't cut it" : "network not switched";
  return `fresh copy on a disposable VM (no container runtime${by}), ${net}${pe?.proves ? "" : "; this audit's rubric doesn't count a disposable VM as proof"}`;
}

function canaryNote(c: NonNullable<Audit["environment"]["proofEnv"]>["canary"]): string {
  const failed = c.checks.filter((k) => !k.ok);
  return failed.length ? `failed: ${failed.map((k) => `${k.id.replace(/_/g, " ")} (${k.detail})`).join(", ")}; nothing that ran there counts for or against the repo` : `passed: ${c.checks.map((k) => k.id.replace(/_/g, " ")).join(", ")}`;
}

function confidenceOf(input: ModelInput, outcome: ReportJson["maturity"]["outcome"]): ReportJson["maturity"]["confidence"] {
  const { audit } = input;
  const low: string[] = [];
  const medium: string[] = [];
  if (outcome === "not_assessed") low.push(noneAssessed(input) ? "no component could be assessed" : input.noResults!);
  if (outcome === "blocked") low.push(`a check that decides Level ${input.rollup.level + 1} was blocked on this machine`);
  if (outcome !== "not_assessed" && audit.tier === "read-only") low.push("the read-only tier runs no repo code");
  if (undetermined(input)) low.push(`Level 1 is undetermined: ${undeterminedCause(input)}`);
  const vm = audit.environment.proofEnv?.kind === "disposable_vm" && audit.environment.proofEnv.proves ? audit.environment.proofEnv : null;
  if (outcome === "proven" && audit.tier !== "read-only" && !audit.environment.containerRuntime && !vm) low.push("setup ran in a fresh copy on the host, not in a clean container");
  if (outcome === "proven" && vm?.network === "on") medium.push("the tests ran on a disposable VM with the network on, because it couldn't be cut there");
  if (outcome === "proven" && audit.evidence.some((e) => e.network === "on" && e.result === "pass")) medium.push("some tests passed only with the network on");
  if (input.partial.partial) medium.push(`${pct(input.partial.unassessedShare, 1)}% of recent changes aren't assessed`);
  const sampled = input.components.filter((c) => c.notAssessedReason?.startsWith("outside the "));
  if (sampled.length) medium.push(`${sampled.length} supported ${sampled.length === 1 ? "component was" : "components were"} left out to keep the audit short`);
  if (outcome === "proven" && input.rollup.couldBe !== null) medium.push("a check that decides the next level couldn't run");
  const level = low.length ? "low" : medium.length ? "medium" : "high";
  return { level, reasons: [...low, ...medium].length ? [...low, ...medium] : ["every check that decides the level ran"] };
}

const START_FAILED = /container \(([^)\s]+)\) didn't start: (.*?)(?:, and host mode wasn't allowed.*)?$/;

// A container that didn't start, in one plain cause: the runtime's raw error stays in the evidence log.
export function startFailureCause(blocked: string): string | null {
  const m = blocked.match(START_FAILED);
  if (!m) return null;
  const [, image, error] = m;
  const first = image.split("/")[0];
  const host = image.includes("/") && /[.:]/.test(first) ? first : "Docker Hub";
  if (/toomanyrequests|rate limit/i.test(error)) return `${host} refused to send the image ${image} because of its rate limit`;
  if (/manifest unknown|not found|pull access denied|repository does not exist|invalid reference/i.test(error)) return `the image ${image} doesn't exist on ${host} or can't be pulled`;
  if (/dial tcp|lookup |no such host|timeout|timed out|connection refused|connection reset|EOF|TLS|x509|certificate|network|proxy|Client\.Timeout/i.test(error)) return `the image ${image} couldn't be pulled, because ${host} couldn't be reached from this machine`;
  return `the audit's container (${image}) didn't start`;
}

// The replay's no-runtime reason (replay.ts noRuntimeReason) in the headline's shorter words.
function noRuntimeCause(blocked: string): string {
  return blocked.replace(/^no container runtime on this machine: [^,]*(?:answered|didn't answer)/, "this machine has no container runtime").replace(/^no container runtime: this audit was run with container runtimes turned off \([^)]*\)/, "container runtimes were turned off for this audit");
}

// Only the steps a level depends on: a refused start command doesn't explain a missing Level 1. With
// components given, only their own steps and the repo's.
function blockedCauses(input: ModelInput, comps: string[] | null = null): string[] {
  const mine = (c?: string) => !comps || !c || c === "*" || comps.includes(c);
  return [...new Set(input.audit.evidence.filter((e) => e.kind !== "start" && e.kind !== "doctor" && mine(e.component)).map(blockedBy).filter((b): b is string => Boolean(b) && b !== "the install was blocked on this machine").map((b) => startFailureCause(b) ?? noRuntimeCause(b).replace(/, though the repo's declared image .*$/, "")))];
}

// Each is a clause that follows "it" in the headline.
function whyNoneAssessed(input: ModelInput): string[] {
  const skipped = input.components.filter((c) => !c.assessed).sort((a, b) => b.changeShare - a.changeShare);
  if (skipped.length === 0) return ["found no package it supports"];
  const detailed = `skipped ${list(skipped.map((c) => `${c.id} (${pct(c.changeShare, 1)}% of changes) because ${becauseOf(c.notAssessedReason ?? "it isn't supported")}`))}`;
  return [detailed, `skipped ${skipped.length} ${skipped.length === 1 ? "component whose toolchain" : "components whose toolchains"} the audit doesn't support yet`];
}

// When every component is blocked only by the platform it builds on, such as Windows-only .NET or an
// Xcode app, the headline names that need, so the missing level never reads as a missing toolchain
// or a broken repo. Null when any component is skipped for another reason.
function platformBlocked(input: ModelInput): string[] | null {
  const skipped = input.components.filter((c) => !c.assessed).sort((a, b) => b.changeShare - a.changeShare);
  const needs = skipped.map((c) => STACKS.find((s) => s.id === c.stack)?.needs);
  if (!skipped.length || needs.some((n) => !n)) return null;
  const byNeed = new Map<string, string[]>();
  skipped.forEach((c, i) => byNeed.set(needs[i]!, [...(byNeed.get(needs[i]!) ?? []), c.id]));
  const one = skipped.length === 1;
  const tail = `to build; ${one ? "it's" : "they're"} blocked on this machine, not broken`;
  const named = [...byNeed].map(([need, ids]) => `${list(ids)} ${ids.length === 1 ? "needs" : "need"} ${need}`);
  const all = [...byNeed.keys()];
  return [`${list(named)} ${tail}`, `${one ? "its one component needs" : `all ${skipped.length} components need`} ${all.length === 1 ? all[0] : list(all).replace(/ and /, " or ")} ${tail}`];
}

// What would let a rerun give the level, for the cause this audit hit; null when only support for
// the stack would, which the part 1 support line covers.
function rerunAdvice(input: ModelInput, causes: string[], verb: "give one" | "prove it"): string | null {
  if (input.audit.tier === "read-only") return `A local-exec audit can ${verb}.`;
  if (!input.audit.environment.containerRuntime) return `A rerun where Docker or Podman is available, such as CI, can ${verb}.`;
  if (causes.some((c) => NOT_SUPPORTED.test(c))) return null;
  if (causes.some((c) => / couldn't be pulled| can't be pulled| rate limit/.test(c))) return `A rerun where that image can be pulled, or with another image passed with --image, can ${verb}.`;
  if (causes.some((c) => / hit .*network/.test(c))) return `A rerun with open network access can ${verb}.`;
  if (causes.some((c) => /in the audit's image/.test(c))) return `A rerun with an image that has the tool, passed with --image, can ${verb}.`;
  return `A rerun where these checks can run can ${verb}.`;
}

function headlineFor(input: ModelInput, ready: string[], setByShare: number): string {
  const { rollup, rubric } = input;
  const top = input.top;
  const active = [...input.active];
  const fit = (...c: string[]) => c.find((x) => wordCount(x) <= rubric.part1.maxHeadlineWords) ?? c[c.length - 1];
  if (noneAssessed(input)) {
    const platform = platformBlocked(input);
    if (platform) return fit(...platform.map((why) => `No component could be assessed, so this audit can't give a level yet: ${why}.`));
    return fit(...whyNoneAssessed(input).map((why) => `No component could be assessed, so this audit can't give a level yet: it ${why}.`), "No component could be assessed, so this audit can't give a level yet.");
  }
  if (input.noResults) {
    if (input.audit.tier === "read-only") return "This read-only audit ran no repo code, so it gives no level yet. A local-exec audit can give one.";
    const causes = blockedCauses(input);
    const rerun = rerunAdvice(input, causes, "give one");
    const where = input.audit.environment.containerRuntime ? "in the audit's container" : "on this machine";
    const tail = rerun ? ` ${rerun}` : "";
    return fit(...(causes.length ? [`Nothing could be checked ${where}, so this audit gives no level: ${list(causes)}.${tail}`] : []), `Nothing could be checked ${where}, so this audit gives no level.${tail}`);
  }
  if (undetermined(input)) {
    const held = capComps(input);
    const where = held.length <= 3 ? list(held) : `all ${held.length} ${held.length === active.length ? "active " : ""}components`;
    const cause = undeterminedCause(input);
    return fit(`Level 1 is undetermined for ${where}: no check failed for a reason in the repo, but ${cause}.`, `Level 1 is undetermined for ${where}: ${cause}.`, `Level 1 is undetermined for ${where}.`);
  }
  if (unproven(input)) {
    const held = capComps(input);
    const where = held.length <= 3 ? list(held) : `all ${held.length} ${held.length === active.length ? "active " : ""}components`;
    const readOnly = input.audit.tier === "read-only";
    const causes = blockedCauses(input, held);
    const why = readOnly ? "the read-only tier runs no repo code" : !input.audit.environment.containerRuntime ? list(causes.some((c) => /container runtime/.test(c)) ? causes : ["this machine has no container runtime", ...causes]) : causes.length ? list(causes) : "a check that decides it couldn't run here";
    const rerun = rerunAdvice(input, causes, "prove it");
    const tail = rerun ? ` ${rerun}` : "";
    const other = notMachineCause(input);
    if (other) return fit(`Level ${rollup.level + 1} couldn't be proved for ${where}: ${other}.`, `Level ${rollup.level + 1} couldn't be proved for ${where}.`);
    const shortWhy = why.replace(/, and host mode wasn't allowed \(--allow-host\), so no repo command ran outside a container/g, "");
    return fit(`Level ${rollup.level + 1} couldn't be proved for ${where} because ${why}.${tail}`, `Level ${rollup.level + 1} couldn't be proved for ${where} because ${shortWhy}.${tail}`, `Level ${rollup.level + 1} couldn't be proved for ${where} on this machine.${tail}`);
  }
  if (rollup.level >= 2 && (top.length === 0 || top.every((t) => t.kind !== "fix"))) {
    if (rollup.level >= 3) return "Agent PRs meet your Level 3 targets. Keep the weekly recheck running and widen the work agents take.";
    const one = active.length === 1;
    const where = active.length <= 3 ? list(active) : `all ${active.length} active components`;
    // "builds" only when every active component has a build step that passed; many have none.
    const built = active.every((id) => input.audit.contract.some((c) => c.kind === "build" && (c.component === id || c.component === "*") && input.audit.evidence.some((e) => e.contractId === c.id && e.result === "pass")));
    const does = one ? (built ? "it installs, builds and passes its" : "it installs and passes its") : built ? "they install, build and pass their" : "they install and pass their";
    return `Nothing blocks agents in ${where}: from a clean checkout ${does} tests, and ${one ? "its" : "their"} tests caught the planted bugs. Start giving agents work there.`;
  }
  const names = list(rollup.setBy);
  const share = active.length > 1 ? `, and ${pct(setByShare, 1)}% of recent changes land there` : "";
  const readyLine = ready.length ? ` ${list(ready)} ${ready.length > 1 ? "are" : "is"} already at Level 2.` : "";
  const many = rollup.setBy.length > 1;
  const their = many ? "their" : "its";
  if (rollup.level === 0) {
    // Each component is named with the Level 1 condition that failed for it, read from its states,
    // and one whose checks were only blocked is never said to fail.
    const own = rollup.setBy.map((id) => ({ id, ...level0Hold(input, id) }));
    const failed = own.filter((o) => o.cond !== null);
    // An undetermined component is one fact about the repo short of a result, not a machine's limit.
    const undecided = own.filter((o) => o.cond === null && compLevel(input, o.id)?.undetermined).map((o) => o.id);
    const unchecked = own.filter((o) => o.cond === null && !undecided.includes(o.id)).map((o) => o.id);
    const blockers = new Set(failed.map((o) => o.cond));
    if (new Set(failed.map((o) => o.says)).size > 1 || unchecked.length || undecided.length) {
      const names = (ids: string[], other: string) => (ids.length <= 3 ? list(ids) : `${ids.length} ${other} components`);
      const off = [...(unchecked.length ? [`${names(unchecked, "other")} couldn't be checked on this machine`] : []), ...(undecided.length ? [`Level 1 is undetermined for ${names(undecided, "other")}`] : [])];
      const each = list([...failed.map((o) => `${o.id} ${o.says}`), ...off]);
      const eachShort = list(failed.map((o) => `${o.id} ${o.says}`));
      const rest = unchecked.length ? "other components couldn't be checked on this machine" : "Level 1 is undetermined for the others";
      return fit(`${each}, so agents can't check their changes there yet${share}.${readyLine}`, `${each}${share}.`, `${each}.`, `${eachShort}; ${rest}.`);
    }
    const names = list(failed.map((o) => o.id));
    const many = failed.length > 1;
    const their = many ? "their" : "its";
    if (blockers.has("clean.install")) {
      const why = because(input, "clean.install", their);
      return fit(`${names} ${many ? "don't" : "doesn't"} install from a clean checkout${why}, so agents can't build or test ${many ? "them" : "it"} yet.${readyLine}`, `${names} ${many ? "don't" : "doesn't"} install from a clean checkout, so agents can't build or test ${many ? "them" : "it"} yet.${readyLine}`);
    }
    if (blockers.has("clean.test:missing")) return `${names} ${many ? "have" : "has"} no tests, so agents can't check their own changes${share}.${readyLine}`;
    if (blockers.has("clean.build")) return fit(`${names} ${many ? "don't" : "doesn't"} build from a clean checkout${because(input, "clean.build", their)}${share}.${readyLine}`, `${names} ${many ? "don't" : "doesn't"} build from a clean checkout${share}.${readyLine}`);
    // With no cause found, the failing tests the output names are the reader's best lead; the network
    // is named only when the output showed it.
    const cause = because(input, "clean.test", their) || failedTests(input);
    return fit(`Agents can't pass the tests in ${names} from a clean checkout${cause}${share}.${readyLine}`, `Agents can't pass the tests in ${names} from a clean checkout${share}.${readyLine}`);
  }
  const resultOf = (id: string) => {
    const evs = [...input.audit.evidence].reverse().filter((e) => e.contractId === id);
    return (evs.find((e) => e.where === "container" || e.where === "fresh_copy" || e.where === "disposable_vm") ?? evs[0])?.result;
  };
  const failingKinds = [...new Set(input.audit.contract.filter((c) => (rollup.setBy.includes(c.component) || c.component === "*") && ["build", "lint", "typecheck", "test"].includes(c.kind) && resultOf(c.id) === "fail").map((c) => (c.kind === "typecheck" ? "type-check" : c.kind)))];
  const canaryMissed = input.audit.evidence.some((e) => e.canary?.kind === "typecheck" && e.result === "fail" && rollup.setBy.includes(e.component ?? ""));
  const why: Partial<Record<CondId, string>> = {
    commands: failingKinds.length ? `${their} ${list(failingKinds)} ${failingKinds.length > 1 ? "commands fail" : "command fails"}` : canaryMissed ? `${their} type-check passes with a type error planted in the code` : `${their} checks don't all pass`,
    faults: `${their} tests can't yet catch wrong changes`,
    instructions: `${their} agent instructions don't match the repo`,
    safety: input.audit.safety.filter((s) => s.blocking).every((s) => s.kind === "secret") ? "a secret is committed to the repo" : "normal work needs production access",
  };
  // Only a condition that failed is a "but"; one blocked here is named as unchecked, never as failing.
  const stateOf = (c: CondId) => rollup.setBy.map((id) => input.states.get(id)?.[c].state ?? "unknown");
  const failing = rubric.level2.filter((c) => why[c] && stateOf(c).includes("not_met")).map((c) => why[c]!);
  const unchecked = rubric.level2.filter((c) => UNCHECKED[c] && !stateOf(c).includes("not_met") && stateOf(c).some((s) => s === "blocked" || s === "unknown")).map((c) => UNCHECKED[c]!);
  const but = failing.length ? list(failing) : `${their} checks can't yet catch wrong changes`;
  const off = failing.length && unchecked.length ? `; ${list(unchecked)} couldn't run on this machine` : "";
  return fit(`Agents can build and test ${names}, but ${but}${off}${share}.${readyLine}`, `Agents can build and test ${names}, but ${but}${off}${share}.`, `Agents can build and test ${names}, but ${but}${share}.`);
}

const UNCHECKED: Partial<Record<CondId, string>> = { commands: "some of the commands", faults: "planted faults", instructions: "some agent instructions" };

// The Level 1 condition that failed for a component, as a phrase that follows its name; cond is null
// when none failed and its checks were only blocked or not run.
function level0Hold(input: ModelInput, id: string): { cond: string | null; says: string } {
  const s = input.states.get(id);
  if (s?.["clean.install"].state === "not_met") return { cond: "clean.install", says: "doesn't install from a clean checkout" };
  if (s?.["clean.test"].state === "not_met" && s["clean.test"].evidence.length === 0) return { cond: "clean.test:missing", says: "has no tests" };
  if (s?.["clean.build"].state === "not_met") return { cond: "clean.build", says: "doesn't build from a clean checkout" };
  if (s?.["clean.test"].state === "not_met") return { cond: "clean.test", says: "fails its tests from a clean checkout" };
  return { cond: null, says: "couldn't be checked on this machine" };
}

// Below Level 2 with no fix to offer, or with every condition of the next level blocked on this
// machine, means a deciding check couldn't run, not that nothing blocks.
// A condition that failed always holds the level, whatever else couldn't run.
function unproven(input: ModelInput): boolean {
  if (input.rollup.level >= 2) return false;
  const caps = capReasons(input);
  if (caps.some((c) => c.state === "not_met")) return false;
  if (input.top.every((t) => t.kind !== "fix")) return true;
  return caps.length > 0 && caps.every((c) => c.state === "blocked");
}

// Below Level 2 only: from there the caps are outcome targets, which no step of the audit fails.
function anyFailed(input: ModelInput): boolean {
  return input.rollup.level < 2 && capReasons(input).some((c) => c.state === "not_met");
}

// Why the next level couldn't be proved when this machine isn't the reason, or null when it is.
function notMachineCause(input: ModelInput): string | null {
  if (input.audit.tier === "read-only" || !input.audit.environment.containerRuntime) return null;
  const caps = capReasons(input);
  if (caps.length === 0 || caps.some((c) => c.state === "blocked")) return null;
  const reason = caps.find((c) => c.state === "unknown")?.reason;
  if (!reason) return null;
  // Part 1 carries this reason, so the audit's own words for its steps become plain ones, and a
  // reason that still holds one gives way to a plain sentence the seal will accept.
  const plain = reason.replace(/^planted faults skipped by --no-mutants$/, "this run skipped planted faults").replace(/\breplay(ed|s|ing)?\b/gi, (_m, s?: string) => (s?.toLowerCase() === "ed" ? "run" : s?.toLowerCase() === "s" ? "runs" : s?.toLowerCase() === "ing" ? "running" : "run"));
  return input.rubric.part1.bannedTerms.some((t) => plain.toLowerCase().includes(t.toLowerCase())) ? "a check that decides it didn't produce a result" : plain;
}

function because(input: ModelInput, cond: CondId, their: string): string {
  const fails = input.audit.evidence.filter((e) => e.condition === cond && e.result === "fail" && e.diagnosis);
  const d = (fails.filter((e) => input.rollup.setBy.includes(e.component ?? "")).at(-1) ?? fails.at(-1))?.diagnosis;
  if (!d) return "";
  if (d.cause === "service") return ` because ${their} tests need ${serviceLabel(d, (p) => `a service on port ${p}`)} running, which the setup doesn't start`;
  if (d.cause === "registry") return " because private registry credentials weren't provided";
  if (d.cause === "credential") return ` because it ${d.detail}`;
  if (d.cause === "unknown" && !(d.fromTool && quotable(input, d.detail))) return "";
  return ` because ${d.detail}`;
}

// A tool's own words go into part 1 only when they hold none of the terms part 1 never uses.
function quotable(input: ModelInput, text: string): boolean {
  return !input.rubric.part1.bannedTerms.some((t) => text.toLowerCase().includes(t.toLowerCase()));
}

// The failing tests an unexplained test failure names ("X and 5 more failed"), as a clause.
function failedTests(input: ModelInput): string {
  const fails = input.audit.evidence.filter((e) => e.condition === "clean.test" && e.result === "fail" && e.diagnosis?.cause === "unknown");
  const d = (fails.filter((e) => input.rollup.setBy.includes(e.component ?? "")).at(-1) ?? fails.at(-1))?.diagnosis;
  return d && / failed$/.test(d.detail) && !/\s/.test(d.detail.replace(/ and \d+ more failed$| failed$/, "")) && quotable(input, d.detail) ? `: ${d.detail}` : "";
}

function gapText(item: RoadmapItem): string {
  return item.title.replace(/`/g, "");
}

// The level named is the one the step's own conditions belong to, so a Level 2 step never claims
// Level 1 because another component in its unlocks rises to Level 1.
export function blocksText(rubric: Rubric, item: RoadmapItem): string {
  if (item.kind !== "fix") return item.template === "targets" ? "Needs a decision" : "Can start now";
  const own = item.fixes.map((f) => f.component).find((c) => c !== "*");
  const level = itemLevel(rubric, item);
  if (level !== null) {
    const rises = [...item.unlocks.matchAll(/(?:^|, )(\S+) to Level (\d)/g)].filter((x) => Number(x[2]) === level).map((x) => x[1]);
    const who = own && rises.includes(own) ? own : (rises[0] ?? own);
    return who ? `Blocks Level ${level} for ${who}` : `Blocks Level ${level}`;
  }
  const mine = own ? item.unlocks.match(new RegExp(`(?:^|, )${own.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} to Level (\\d)`)) : null;
  if (mine) return `Blocks Level ${mine[1]} for ${own}`;
  const m = item.unlocks.match(/^(.+?) to Level (\d)/);
  if (m) return `Blocks Level ${m[2]} for ${m[1].split(",")[0]}`;
  return "Blocks the next level";
}

function stats3(input: ModelInput): ReportJson["executive"]["numbers"] {
  const { rubric, audit } = input;
  const activeIds = [...input.active];
  const ready = activeIds.filter((id) => (compLevel(input, id)?.level ?? 0) >= 2).length;
  // The third number keeps one meaning on every audit: changes in components below Level 2, the
  // bar for delegating work, so it can be compared with the first and the last audit.
  const bar = 2;
  const isUnproven = (id: string) => {
    const l = compLevel(input, id);
    return Boolean(l) && unprovenLevel1(l!.level, l!.couldBe, componentCaps(input, id));
  };
  const belowComps = input.components.filter((c) => c.assessed && input.active.has(c.id) && (compLevel(input, c.id)?.level ?? 0) < bar);
  const below = belowComps.reduce((s, c) => s + c.changeShare, 0);
  const unprovenOnly = belowComps.length > 0 && belowComps.every((c) => isUnproven(c.id));
  const someUnproven = belowComps.some((c) => isUnproven(c.id));
  const leveled = input.history.filter((h) => h.kind === "audit" && !h.noLevel && typeof h.repoLevel === "number");
  const prev = leveled[leveled.length - 1];
  const first = leveled[0];
  const days = audit.profile?.historyDays ?? 90;
  const readyThen = (h: HistoryLine) => `${h.active.filter((id) => (h.levels[id] ?? 0) >= 2).length} of ${h.active.length}`;
  const belowThen = (h: HistoryLine) => `${pct(h.active.filter((id) => (h.levels[id] ?? 0) < bar).reduce((s, id) => s + (h.shares[id] ?? 0), 0), 1)}%`;
  // Assessed components under the change-share line are left out of the count; say so next to it.
  const inactive = input.components.filter((c) => c.assessed && !input.active.has(c.id)).map((c) => c.id);
  const inactiveNote = inactive.length ? `; ${list(inactive)} ${inactive.length > 1 ? "get" : "gets"} under ${Math.round(rubric.repoLevel.activeShare * 100)}% of changes, so ${inactive.length > 1 ? "they aren't" : "it isn't"} counted` : "";
  let readyComparison = `Level 2 needs ${activeIds.length} of ${activeIds.length}`;
  let belowComparison = `Level ${bar} needs 0%, counting the last ${days} days`;
  if (prev && first && first.id !== prev.id) {
    readyComparison = `First audit: ${readyThen(first)}; last audit: ${readyThen(prev)}`;
    belowComparison = `First audit: ${belowThen(first)}; last audit: ${belowThen(prev)}, counting the last ${days} days`;
  } else if (prev) {
    readyComparison = `Last audit: ${readyThen(prev)}`;
    belowComparison = `Last audit: ${belowThen(prev)}, counting the last ${days} days`;
  }
  const o = audit.outcomes;
  const ciValue = o ? describeRate(rate(o.agent.firstTimeCiPass, o.agent.firstTimeCiKnown, rubric, windowLabel(o))) : "not measured";
  const ciComparison = o ? `${describeRate(rate(o.control.firstTimeCiPass, o.control.firstTimeCiKnown, rubric, windowLabel(o)))}, ${windowLabel(o)}` : "";
  const ci = { label: "Agent PRs that pass CI the first time", value: ciValue, comparison: o ? `Other PRs: ${ciComparison}` : "The audit needs read access to pull requests to compare agent PRs with other PRs" };
  if (noneAssessed(input)) {
    const found = input.components.length;
    return [
      { label: "Components ready for agents", value: "none assessed", comparison: `${found} ${found === 1 ? "component" : "components"} found, and ${found === 1 ? "it can't" : "none can"} be assessed yet` },
      ci,
      { label: "Recent changes this audit couldn't assess", value: `${pct(input.partial.unassessedShare, 1)}%`, comparison: `Counting the last ${days} days; a level needs at least one assessed component` },
    ];
  }
  if (notAssessed(input)) {
    const assessed = input.components.filter((c) => c.assessed);
    const share = assessed.reduce((s, c) => s + c.changeShare, 0);
    return [
      { label: "Components ready for agents", value: "none checked", comparison: `${assessed.length} of ${input.components.length} ${input.components.length === 1 ? "component" : "components"} could be assessed, but no check could run` },
      ci,
      { label: "Recent changes this audit couldn't check", value: `${pct(share + input.partial.unassessedShare, 1)}%`, comparison: `Counting the last ${days} days; a level needs at least one real check result` },
    ];
  }
  return [
    { label: "Components ready for agents", value: `${ready} of ${activeIds.length}`, comparison: readyComparison + inactiveNote },
    ci,
    {
      label: unprovenOnly ? `Recent changes in components not yet proven at Level ${bar}` : someUnproven ? `Recent changes in components below or not yet proven at Level ${bar}` : `Recent changes in components below Level ${bar}`,
      value: `${pct(below, 1)}%`,
      comparison: unprovenOnly ? `Proving Level 1 needs a clean container; counting the last ${days} days` : belowComparison,
    },
  ];
}

// Quadrants run left to right, top then bottom: low effort and high impact first.
export function quadrantOf(rubric: Rubric, x: number, y: number): string {
  const [doFirst, bigUnlocks, quickFills, later] = rubric.matrixQuadrants;
  return y >= 0.5 ? (x < 0.5 ? doFirst : bigUnlocks) : x < 0.5 ? quickFills : later;
}

function outcomeLabel(level: Level): string {
  return level === 3 ? "agent PR volume grows while the targets hold" : "agent PRs meet the team's targets";
}

function nextLine(input: ModelInput): string {
  const { rubric, rollup } = input;
  const L = rollup.level;
  if (L >= 4) return "This is the top of the scale. Keep the weekly recheck running.";
  const next = rubric.scale[L + 1];
  if (noneAssessed(input)) return `Next: Level ${L + 1}, ${next.plain}, once a component can be assessed. No condition has been checked yet.`;
  if (notAssessed(input)) return `Next: Level ${L + 1}, ${next.plain}, once a check can run. No condition has been checked yet.`;
  if (L === 3) return `Next: Level 4, ${next.plain}. ${rollup.outcomeReasons.length ? `${rollup.outcomeReasons[0].replace(/^Level 4 needs/, "It needs")}.` : "It needs agent PR volume to grow while the targets hold."}`;
  if (L >= 2) return `Next: Level ${L + 1}, ${next.plain}. It needs outcome targets your team sets and agent PRs that meet them${rollup.outcomeReasons.length ? `: ${rollup.outcomeReasons[0]}` : ""}.`;
  const conds = L === 0 ? rubric.level1 : rubric.level2;
  const met: string[] = [];
  const unmet: string[] = [];
  const blocked: string[] = [];
  for (const c of conds) {
    const failing = [...input.active].filter((id) => input.states.get(id)?.[c].state !== "met");
    const phrase = condPhrase(input, c, failing.length ? failing : [...input.active]);
    if (phrase === null) continue;
    if (failing.length === 0) {
      met.push(phrase);
      continue;
    }
    const stuck = failing.filter((id) => input.states.get(id)?.[c].state === "blocked");
    const notYet = failing.filter((id) => !stuck.includes(id));
    const name = (ids: string[]) => (rubric.conditions[c].scope === "repo" ? phrase : `${list(ids)} ${phrase}`);
    if (notYet.length) unmet.push(name(notYet));
    if (stuck.length) blocked.push(name(stuck));
  }
  return `Next: Level ${L + 1}, ${next.plain}. ${met.length ? `Met: ${list(met)}. ` : ""}${unmet.length ? `Not yet: ${list(unmet)}.` : ""}${unmet.length && blocked.length ? " " : ""}${blocked.length ? `Blocked on this machine: ${list(blocked)}.` : ""}`.trim();
}

// Part 1's own line for what the level doesn't cover, so an unassessed app or a stack the audit
// doesn't support yet is never only in the coverage footnote.
function unassessedOf(input: ModelInput): ReportJson["executive"]["unassessed"] {
  const skipped = input.components.filter((c) => !c.assessed && c.changeShare > 0).sort((a, b) => b.changeShare - a.changeShare);
  // A step the audit can't run yet, such as a build that needs a sibling package built first.
  const held = input.audit.evidence.filter((e) => e.kind !== "start" && e.kind !== "doctor" && NOT_SUPPORTED.test(blockedBy(e) ?? ""));
  const unsupported = held.length > 0 || input.components.some((c) => !c.assessed && NOT_SUPPORTED.test(c.notAssessedReason ?? ""));
  if (!skipped.length && !unsupported) return null;
  const share = skipped.reduce((s, c) => s + c.changeShare, 0);
  const shown = skipped.slice(0, 3).map((c) => `${c.id} (${pct(c.changeShare, 1)}%), because ${becauseOf(c.notAssessedReason ?? "it isn't assessed")}`);
  const more = skipped.length > 3 ? `; and ${skipped.length - 3} more` : "";
  const heldIds = [...new Set(held.map((e) => (e.component && e.component !== "*" ? e.component : "the repo")))];
  const heldText = held.length ? `${list(heldIds)} ${heldIds.length > 1 ? "have" : "has"} no proven level, because ${blockedBy(held[0])}` : "";
  // An unsupported component with no recent changes still needs its own words, or the line is empty.
  const quiet = skipped.length || held.length ? [] : input.components.filter((c) => !c.assessed && NOT_SUPPORTED.test(c.notAssessedReason ?? ""));
  const quietText = quiet.map((c) => `${c.id} (no recent changes), because ${becauseOf(c.notAssessedReason!)}`).join("; ");
  const text = [skipped.length ? `${pct(share, 1)}% of recent changes aren't assessed: ${shown.join("; ")}${more}` : "", heldText, quietText].filter(Boolean).join(". ");
  return { share: Math.round(share * 1000) / 1000, text, supportDoc: unsupported ? (input.supportDoc ?? SUPPORTED_DOC) : null };
}

function coverageLine(input: ModelInput): string {
  const { components, audit } = input;
  const assessed = components.filter((c) => c.assessed);
  const skipped = components.filter((c) => !c.assessed);
  const parts = [`The level covers ${assessed.length} ${assessed.length === 1 ? "component" : "components"}`];
  if (skipped.length) parts.push(`and ignores ${list(skipped.map((c) => `${c.id} (${pct(c.changeShare, 1)}% of changes, ${c.notAssessedReason})`))}`);
  let line = parts.join(" ") + ".";
  const threshold = input.rubric.repoLevel.activeShare;
  const share = `${Math.round(threshold * 100)}%`;
  const low = assessed.filter((c) => !input.active.has(c.id) && c.changeShare < threshold);
  const held = assessed.filter((c) => !input.active.has(c.id) && c.changeShare >= threshold);
  // The fallback is only the case where no active component reaches the line; one kept active by
  // the two-audit rule is still set by that rule.
  const activeRows = assessed.filter((c) => input.active.has(c.id));
  const fallback = activeRows.length === 1 && activeRows[0].changeShare < threshold && assessed.every((c) => c.changeShare < threshold) ? activeRows : [];
  if (low.length) line += ` ${list(low.map((c) => c.id))} ${low.length > 1 ? "get" : "gets"} under ${share} of changes, so ${low.length > 1 ? "they don't" : "it doesn't"} set the repo level.`;
  if (held.length) line += ` ${list(held.map((c) => c.id))} crossed ${share} of changes in this audit only; ${held.length > 1 ? "they set" : "it sets"} the repo level once ${held.length > 1 ? "they stay" : "it stays"} there for a second audit.`;
  if (fallback.length) line += ` No assessed component gets ${share} of changes, so the largest, ${fallback[0].id}, sets the repo level.`;
  if (input.partial.partial) line += ` Partial coverage: ${pct(input.partial.unassessedShare, 1)}% of changes aren't assessed.`;
  const sampled = sampledScope(audit);
  if (sampled) line += ` Sampled scope: ${sampled}.`;
  if (audit.repo.shallow) line += " The clone is shallow, so change shares come only from the commits it has.";
  if (audit.repo.submodulesMissing?.length) line += ` Submodules not checked out on this machine aren't in the audit: ${list(audit.repo.submodulesMissing)}.`;
  if (audit.repo.lfsPointers) line += ` ${audit.repo.lfsPointers} Git LFS ${audit.repo.lfsPointers === 1 ? "file stayed a pointer" : "files stayed pointers"} in the audit tree.`;
  if (audit.tier !== "read-only" && !audit.environment.containerRuntime && audit.evidence.some((e) => e.where === "fresh_copy")) {
    const declared = audit.profile?.environmentJson?.build?.dockerfile;
    const blockedEv = audit.evidence.filter((e) => blockedBy(e) && e.diagnosis?.cause === "missing_tool");
    const missing = [...new Set(blockedEv.map((e) => e.diagnosis!.detail))];
    const inImage = [...new Set(blockedEv.filter((e) => /declared image/.test(e.blocked ?? "")).map((e) => e.diagnosis!.detail.replace(/ is not installed$/, "")))];
    line += ` Level 1 isn't provable on this machine: it has no container runtime, so setup ran in a fresh copy on the host${declared ? ` and the repo's declared environment image (.cursor/${declared}) couldn't be built` : ""}.`;
    if (missing.length) line += ` On this machine ${list(missing)}, an environment limit rather than a repo defect${inImage.length ? `; the declared image installs ${list(inImage)}` : ""}.`;
    if (audit.evidence.some((e) => /uses sudo/.test(e.blocked ?? ""))) line += " Setup commands that use sudo weren't run on this machine.";
  }
  if (ranTestsInContainer(audit)) line += " Tests and planted faults ran in a clean container with the network switched off, so a test that needs the internet fails here.";
  // Findings that don't block are still named, such as host mode being able to read local files.
  const listed = audit.safety.filter((s) => !s.blocking && !s.waived).sort((a, b) => Number(a.kind === "secret") - Number(b.kind === "secret"));
  if (listed.length) {
    const banned = (t: string) => input.rubric.part1.bannedTerms.some((b) => t.toLowerCase().includes(b.toLowerCase()));
    const shown = listed.slice(0, 5).map((s) => {
      const where = `${s.file}${s.line ? `:${s.line}` : ""}`;
      const text = s.detail.replace(/`/g, "");
      return s.file === "." || banned(where) ? text : `${text} (${where})`;
    }).filter((t) => !banned(t));
    line += ` Listed for review, not blocking: ${shown.join("; ")}${listed.length > 5 ? `; and ${listed.length - 5} more in part 5` : ""}.`;
  }
  const w = audit.waivers;
  if (w) {
    const waived = audit.instructions.filter((i) => i.waived).length + audit.safety.filter((s) => s.waived).length;
    const refused = w.rejected.length ? `; ${w.rejected.length} ${w.rejected.length === 1 ? "waiver was" : "waivers were"} refused` : "";
    line += ` Waivers: ${waived} ${waived === 1 ? "finding is" : "findings are"} treated as a false positive by ${w.file}, as of the audited commit${refused}${w.ignored ? `; ${w.ignored}` : ""}. Part 5 lists each with its reason.`;
  }
  // With no outcomes, the numbers already say agent PRs weren't measured.
  const f = audit.outcomes?.filter;
  if (f) line += ` Agent PRs are matched by ${describeFilter(f)}.`;
  return line;
}

function describeFilter(f: OutcomesSnapshot["filter"]): string {
  const parts: string[] = [];
  if (f.branchPrefixes.length) parts.push(`head branch starting with ${f.branchPrefixes.join(" or ")}`);
  if (f.labels.length) parts.push(`label ${f.labels.join(" or ")}`);
  if (f.authors.length) parts.push(`author ${f.authors.join(" or ")}`);
  if (f.coAuthorTrailers.length) parts.push(`co-author ${f.coAuthorTrailers.join(" or ")}`);
  return parts.join(", or ") || "no filter";
}

function checkResult(input: ModelInput, checkId: string): { result: string; ok: boolean | null } {
  const { audit, rubric } = input;
  const assessed = input.components.filter((c) => c.assessed);
  const byComp = (conds: CondId[]) => {
    const passed: string[] = [];
    const failed: string[] = [];
    const unproven: string[] = [];
    const blocked: string[] = [];
    for (const c of assessed) {
      const s = input.states.get(c.id)!;
      if (conds.some((k) => s[k].state === "not_met")) failed.push(c.id);
      else if (conds.some((k) => s[k].state === "blocked")) blocked.push(c.id);
      else if (conds.some((k) => s[k].state === "unknown")) unproven.push(c.id);
      else passed.push(c.id);
    }
    const parts: string[] = [];
    if (failed.length) parts.push(`failed: ${list(failed)}`);
    if (passed.length) parts.push(`passed: ${list(passed)}`);
    if (blocked.length) parts.push(`blocked on this machine: ${list(blocked)}`);
    if (unproven.length) parts.push(`not proven: ${list(unproven)}`);
    return { result: parts.join("; "), ok: failed.length ? false : unproven.length || blocked.length ? null : true };
  };
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (checkId === "scope.profile") return { result: `${plural(input.components.length, "component")} found, ${assessed.length} assessed`, ok: null };
  if (checkId === "scope.agent_assets") {
    const authors = new Set(audit.assets.flatMap((a) => a.authors.map((x) => x.name)));
    return { result: `${plural(audit.assets.length, "asset")}, ${plural(authors.size, "author")}`, ok: null };
  }
  if (checkId === "bootstrap.cold_replay") {
    const r = byComp(rubric.level1);
    const repoState = [...input.states.values()][0];
    const extra: string[] = [];
    if (repoState?.toolchain.state === "not_met") extra.push(`toolchain: ${repoState.toolchain.reason}`);
    if (repoState?.lockfile.state === "not_met") extra.push(`lockfile: ${repoState.lockfile.reason}`);
    return { result: [r.result, ...extra].filter(Boolean).join("; "), ok: extra.length ? false : r.ok };
  }
  if (checkId === "verify.canonical_interface") return byComp(["commands"]);
  if (checkId === "verify.behavioral_oracle") {
    const parts = assessed.map((c) => {
      const ev = [...audit.evidence].reverse().find((e) => e.condition === "faults" && e.component === c.id);
      return `${c.id}: ${ev ? ev.summary.replace(/ \(.*$/, "").replace(/; missed.*$/, "") : "not run"}`;
    });
    const r = byComp(["faults"]);
    return { result: parts.join("; "), ok: r.ok };
  }
  if (checkId === "context.instructions_verified") {
    const k = checkCounts(audit, checkId);
    const total = k.passed + k.failed + k.notRun;
    const gating = audit.instructions.filter((i) => gatingInstruction(input.rubric, i));
    const listed = audit.instructions.filter((i) => i.result === "fail").length - gating.filter((i) => i.result === "fail").length;
    const wrong = k.failed - listed;
    return { result: `${k.passed} of ${total} instruction items check out${wrong ? `, ${wrong} wrong` : ""}${listed ? `, ${listed} wrong outside the agent files, listed` : ""}${k.notRun ? `, ${k.notRun} not run` : ""}`, ok: wrong ? false : gating.some((i) => i.result === "not_run" && i.category === "replay") ? null : true };
  }
  if (checkId === "safety.execution_boundary") {
    const blocking = audit.safety.filter((s) => s.blocking);
    const listed = audit.safety.filter((s) => !s.blocking);
    return { result: `${blocking.length ? `failed: ${list(blocking.map((b) => b.detail))}` : "passed"}${listed.length ? `; ${listed.length} ${listed.length === 1 ? "item" : "items"} listed for review` : ""}`, ok: blocking.length === 0 };
  }
  return { result: "", ok: null };
}

export function buildReport(input: ModelInput): ReportJson {
  const { audit, rubric, roadmap, top, startNow } = input;
  const L = input.rollup.level;
  const ready = [...input.active].filter((id) => (compLevel(input, id)?.level ?? 0) >= 2 && !input.rollup.setBy.includes(id));
  const setByShare = input.components.filter((c) => input.rollup.setBy.includes(c.id)).reduce((s, c) => s + c.changeShare, 0);
  const none = notAssessed(input);
  const outcome = outcomeOf(input);
  const caps = capReasons(input);
  const noBlocker = !none && !unproven(input) && !anyFailed(input) && top.every((t) => t.kind !== "fix");
  const failedCap = L < 2 ? caps.find((c) => c.state === "not_met") : undefined;
  const narr = audit.narration ?? {};
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const gaps = top.map((t, i) => ({ rank: i + 1, text: (narr.gaps?.[t.id] ?? gapText(t)).trim().replace(/\.+$/, ""), blocks: t.status === "start_now" ? `Can start now; ${lower(blocksText(rubric, t))}` : blocksText(rubric, t), itemId: t.id }));
  const first = top[0];
  const skippedIds = input.components.filter((c) => !c.assessed).map((c) => c.id);
  const defaultAsk = noneAssessed(input)
    ? `Decision needed: which component this audit should cover${skippedIds.length ? `, since it can't assess ${list(skippedIds)}` : ", since it found none it supports"}.`
    : none
    ? audit.tier === "read-only"
      ? "Decision needed: whether to allow a local-exec audit, which runs the repo's commands in a container."
      : "Decision needed: where to rerun this audit so its checks can run, for example a CI job with Docker or Podman."
    : undetermined(input)
    ? `Decision needed: who settles Level 1 for ${list(capComps(input))}: ${lower(settleByOf(input, capReasons(input))!.text.replace(/`/g, "").replace(/\.$/, ""))}.`
    : unproven(input) && notMachineCause(input)
    ? `Decision needed: how the audit can check Level ${L + 1} in ${list(capComps(input))}, since ${lower(notMachineCause(input)!)}.`
    : unproven(input)
    ? `Decision needed: where to rerun this audit so it can prove Level ${L + 1}, for example a CI job.${top.some((t) => t.status === "start_now") ? ` Meanwhile, ${lower(gapText(top.find((t) => t.status === "start_now")!))} can start now.` : ""}`
    : first?.decision
      ? `Decision needed: ${lower(first.decision)}.`
        : noBlocker
        ? "Decision needed: which work goes to agents first."
        : first
          ? `Decision needed: who takes on "${gapText(first)}", the first step in part 3.`
          : `Decision needed: who fixes what holds ${failedCap && failedCap.component !== "*" ? failedCap.component : "the repo"} at Level ${L}: ${lower(failedCap?.label ?? "the conditions in part 5")}.`;
  let ask = (narr.ask ?? defaultAsk).trim();
  if (!/[.!?]$/.test(ask)) ask += ".";
  if (!roadmap.owner && !/\bowner\b/i.test(ask)) ask += " Also name an owner for agent readiness.";
  const actions: ReportAction[] = top.map((t, i) => action(t, i + 1, rubric, roadmap, t.status === "start_now", audit.outcomes));
  if (startNow) actions.push(action(startNow, actions.length + 1, rubric, roadmap, true, audit.outcomes));
  // From 2026-11-alpha, impact is placed against the largest action's, so the top recommendation
  // sits in the top half and is never filed under "Later" just because every share is small.
  const relative = rubric.matrixImpact === "relative";
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const maxImpact = Math.max(0, ...actions.map((a) => a.impact));
  const points = actions.map((a, i) => {
    const x = Math.round(Math.min(0.95, rubric.effortX[a.effort] + i * (relative ? 0.02 : 0.04)) * 1000) / 1000;
    // With no action moving a level on its own, the actions only unblock together, so they share
    // the top half instead of all reading as no impact.
    const together = roadmap.items.find((i) => i.id === a.itemId)?.unlocks.includes(" together with ") ?? false;
    const raw = relative ? Math.max(maxImpact > 0 ? a.impact / maxImpact : 0, together ? 0.75 : 0) : a.impact;
    const y = Math.round(clamp(raw) * 1000) / 1000;
    return { label: `${a.rank}. ${a.title}`, x, y, impact: clamp(a.impact), quadrant: quadrantOf(rubric, x, y), itemId: a.itemId };
  });
  const o = audit.outcomes;
  const w = o ? windowLabel(o) : "";
  const series = o
    ? [
        { label: "Agent PRs", s: o.agent, w },
        { label: "Other PRs", s: o.control, w },
        ...(input.previousOutcomes ? [{ label: `Agent PRs, ${input.previousOutcomes.window}`, s: input.previousOutcomes.agent, w: input.previousOutcomes.window }] : []),
      ].map((x) => ({
        label: x.label,
        opened: x.s.opened,
        merged: rate(x.s.merged, x.s.opened, rubric, x.w),
        firstTimeCi: rate(x.s.firstTimeCiPass, x.s.firstTimeCiKnown, rubric, x.w),
        changesRequested: rate(x.s.changesRequested, x.s.opened, rubric, x.w),
        medianDaysToMerge: x.s.medianDaysToMerge,
        ...(rubric.outcomes.revertDays !== undefined ? { reverted: x.s.revertKnown === undefined ? null : rate(x.s.reverted ?? 0, x.s.revertKnown, rubric, x.w) } : {}),
      }))
    : [];
  const prevAudits = input.history.filter((h) => h.kind === "audit");
  const allLines = [...input.history, input.currentLine];
  const progress =
    prevAudits.length > 0
      ? {
          history: allLines.map((h) => ({ date: h.date, kind: h.kind, result: h.result, note: h.note ?? null, levels: Object.fromEntries(Object.entries(h.levels ?? {}).map(([k, v]) => [k, h.noLevel || typeof v !== "number" ? null : v])), repoLevel: h.noLevel || typeof h.repoLevel !== "number" ? null : h.repoLevel, rubric: h.rubric })),
          closed: roadmap.items
            .filter((i) => i.status === "done" && i.closedAt && i.kind === "fix")
            .map((i) => ({
              title: `${i.order}. ${i.title}`,
              closed: i.closedAt as string,
              expected: `${i.expected.outcome} Watch: ${metricLabel(i.expected.watch.metric, i.expected.watch.scope)}, ${i.expected.watch.baseline}.`,
              observed: i.observed ? `${i.observed.value}${i.observed.sharedWith.length ? ` (closed with ${list(i.observed.sharedWith.map((s) => `step ${roadmap.items.find((x) => x.id === s)?.order ?? s}`))})` : ""}` : "not measurable yet: needs a full outcome window after the fix",
            })),
          weakening: input.weakening,
          rubricChanges: allLines.slice(1).filter((h, i) => h.rubric !== allLines[i].rubric).map((h, i) => ({ date: h.date, from: allLines[i].rubric, to: h.rubric })),
        }
      : null;
  const report: ReportJson = {
    schema: "agent-readiness/report@1",
    repo: audit.repo.name,
    ...(PREVIEW ? { preview: PREVIEW } : {}),
    audit: {
      id: audit.id,
      date: audit.createdAt.slice(0, 10),
      commit: audit.repo.commit.slice(0, 7),
      dirtyTree: audit.repo.dirtyTree,
      rubric: audit.rubric,
      tier: audit.tier,
      scriptsDigest: audit.skill.scriptsDigest,
      seedPinned: audit.seed.pinned,
      sealStatus: input.sealStatus,
      staleCopy: input.staleCopy,
      previous: prevAudits.length ? prevAudits[prevAudits.length - 1].id : null,
      storedAt: input.storedAt,
    },
    scale: rubric.scale,
    scenarios: (audit.scenarios ?? []).map((s) => ({ id: s.id, label: rubric.scenarios.find((x) => x.id === s.id)!.label, components: s.components })),
    maturity: {
      level: L,
      rule: `The repo level is ${rubric.repoLevel.rule}.`,
      couldBe: input.rollup.couldBe,
      couldBeReason: input.rollup.couldBe !== null ? "a check that would decide it couldn't run here" : null,
      setBy: input.rollup.setBy,
      partialCoverage: input.partial.partial,
      assessedComponents: input.components.filter((c) => c.assessed).length,
      outcome,
      confidence: confidenceOf(input, outcome),
      capReasons: caps,
      unproven: !none && unprovenLevel1(L, input.rollup.couldBe, caps),
      ...(rubricStatus(input) ? { status: levelStatus(none, undetermined(input), unprovenLevel1(L, input.rollup.couldBe, caps)), settleBy: settleByOf(input, caps) } : {}),
      next: L < 4 ? { level: (L + 1) as Level, name: rubric.scale[L + 1].name, met: [], unmet: [] } : null,
    },
    components: componentsOf(input),
    executive: {
      heading: noneAssessed(input)
        ? "Not assessed: none of the components found can be assessed yet"
        : none
          ? `Not assessed: ${audit.tier === "read-only" ? "the read-only tier runs no repo code" : "no check could run on this machine"}`
          : `${undetermined(input) ? undeterminedHeading(caps) : !none && unprovenLevel1(L, input.rollup.couldBe, caps) ? unprovenHeading(caps) : `Level ${L} of 4, ${rubric.scale[L].plain}${outcome === "blocked" ? (failedCap ? `; Level ${L + 1} isn't met, and some of its checks were blocked on this machine` : `; Level ${L + 1} is blocked on this machine`) : ""}`}${mostlyUnassessed(input) ? `; it covers only ${pct(1 - input.partial.unassessedShare, 1)}% of recent changes, and the rest isn't assessed` : ""}`,
      headline: narr.headline ?? headlineFor(input, ready, setByShare),
      numbers: stats3(input),
      nextLine: nextLine(input),
      gaps,
      ask,
      coverage: coverageLine(input),
      noBlocker,
      unassessed: unassessedOf(input),
    },
    actions,
    matrix: { quadrants: rubric.matrixQuadrants, points },
    roadmap: {
      owner: roadmap.owner,
      doneCount: roadmap.items.filter((i) => i.status === "done").length,
      total: roadmap.items.length,
      items: roadmap.items.map((i) => {
        // Several steps can be next at once; only the first says so, the others say which one they run alongside.
        const firstNext = roadmap.items.find((x) => x.status === "next");
        const text = i.status === "next" && firstNext && firstNext.id !== i.id ? `next, alongside step ${firstNext.order}` : statusText(i, roadmap);
        return { id: i.id, order: i.order, title: i.title, status: i.status, statusText: text, unlocks: i.unlocks, decision: i.decision, level: itemLevel(rubric, i) };
      }),
    },
    progress,
    details: {
      steps: actions.map((a) => {
        const item = roadmap.items.find((i) => i.id === a.itemId)!;
        const waivable = item.fixes.map((f) => WAIVABLE_CHECK[f.condition]).find(Boolean);
        return { itemId: a.itemId, title: a.title, steps: waivable ? [...item.steps, waiverStep(waivable)] : item.steps };
      }),
      checks: rubric.checks.map((c) => {
        const r = checkResult(input, c.id);
        if (c.id === "verify.canonical_interface") {
          const ids = new Set([...input.states.values()].flatMap((s) => s.commands.evidence));
          const evs = audit.evidence.filter((e) => ids.has(e.id));
          const counts = { passed: evs.filter((e) => e.result === "pass").length, failed: evs.filter((e) => e.result === "fail").length, notRun: evs.filter((e) => e.result === "not_run").length };
          return { id: c.id, name: c.title, why: c.why, sources: c.sources, result: r.result, ok: r.ok, counts, evidence: evs.map((e) => e.id) };
        }
        return { id: c.id, name: c.title, why: c.why, sources: c.sources, result: r.result, ok: r.ok, counts: checkCounts(audit, c.id), evidence: audit.evidence.filter((e) => e.checkId === c.id).map((e) => e.id) };
      }),
      notAssessed: rubric.notAssessed,
      levelRules: {
        level1: `Level 1 needs: ${list(rubric.level1.map((c) => condLabel(rubric, c)))}`,
        level2: `Level 2 needs: ${list(rubric.level2.map((c) => condLabel(rubric, c)))}`,
        scenarios: rubric.scenarios.filter((s) => (audit.scenarios ?? []).some((x) => x.id === s.id)).map((s) => ({ id: s.id, label: s.label, bar: `Level 2 needs: ${list(s.level2.map((c) => condLabel(rubric, c)))}` })),
      },
      outcomes: o
        ? {
            window: w,
            filter: describeFilter(o.filter),
            source: o.source === "gh" ? "GitHub through gh" : "a recorded PR file",
            series,
            byComponent: input.components
              .filter((c) => c.assessed)
              .map((c) => {
                const s = o.byComponent[c.id];
                return { component: c.id, prs: s?.opened ?? 0, firstTimeCi: rate(s?.firstTimeCiPass ?? 0, s?.firstTimeCiKnown ?? 0, rubric, w), changesRequested: rate(s?.changesRequested ?? 0, s?.opened ?? 0, rubric, w) };
              }),
            multiComponentNote: o.multiComponentPrs ? `${o.multiComponentPrs} agent ${o.multiComponentPrs === 1 ? "PR" : "PRs"} touched more than one component, so the component rows can add up to more than the total.` : "No agent PR touched more than one component.",
            matchedPrs: o.matchedAgentPrs,
            caveat: input.previousOutcomes ? "A trend, not attribution. Model updates or a different mix of tasks could account for part of the change." : "A baseline, not proof that readiness explains these numbers. Model updates and the mix of tasks move them too.",
            ...(o.reverts ? { reverts: { days: o.reverts.days, note: revertNote(o.reverts), agent: o.reverts.agent } } : {}),
          }
        : null,
      assets: audit.assets.map((a: Asset) => ({ kind: a.kind, path: a.path, authors: a.authors.map((x) => x.name), lastChanged: a.lastChanged, status: a.status, ok: a.ok })),
      missingAssets: missingList(audit.assets),
      signals: audit.signals ?? [],
      evidence: audit.evidence.map((e) => {
        const blocked = blockedBy(e);
        return {
          id: e.id,
          check: e.checkId,
          component: e.component && e.component !== "*" ? e.component : null,
          ran: e.command ?? e.summary,
          where: e.result === "not_run" ? "not run" : rubric.strengthLabels[e.strength],
          result: blocked ? "blocked" : e.result,
          summary: blocked && e.result === "fail" ? `${e.kind ?? "step"} blocked: ${blocked}` : blocked && !e.summary.includes(blocked) ? `${e.summary}; blocked: ${blocked}` : e.summary,
        };
      }),
      record: [
        { label: "Audit", value: audit.id },
        { label: "Commit", value: `${audit.repo.commit.slice(0, 7)}${audit.repo.dirtyTree ? " (uncommitted changes were not audited)" : " (clean tree)"}` },
        { label: "Rubric", value: audit.rubric },
        { label: "Permission tier", value: audit.tier },
        { label: "Seal", value: input.sealStatus },
        { label: "Skill digest", value: audit.skill.scriptsDigest.slice(0, 12) },
        { label: "Planted faults", value: plantedFaultsRecord(audit, rubric) },
        {
          label: "Replay environment",
          value: audit.environment.notRun
            ? `none: ${audit.environment.notRun}`
            : audit.environment.containerRuntime
              ? (imagesUsed(audit.environment)
                  ? `${audit.environment.containerRuntime} containers, ${imagesUsed(audit.environment)}`
                  : `${audit.environment.containerRuntime} container, ${audit.environment.image}`) + toolchainsNote(audit.environment) + userEntryNote(audit.environment) + networkNote(audit)
              : audit.evidence.some((e) => e.where === "disposable_vm")
                ? vmEnvironmentNote(audit)
                : audit.evidence.some((e) => e.where === "fresh_copy")
                  ? "fresh copy on the host (no container runtime)"
                  : `none: no repo command ran${noneAssessed(input) ? ", because no component could be assessed" : ""}`,
        },
        ...(audit.environment.proofEnv?.canary.checks.length ? [{ label: "Environment self-check", value: canaryNote(audit.environment.proofEnv.canary) }] : []),
        ...(audit.environment.registryEnv.length ? [{ label: "Registry variables", value: `${audit.environment.registryEnv.join(", ")}, passed to the setup steps by name; their values are never recorded` }] : []),
        { label: "Stored in", value: input.storedAt },
      ],
    },
  };
  if (report.progress) report.progress.changes = input.previousReport ? changesOf(input.previousReport, report, rubric) : null;
  report.notices = noticesOf(input);
  report.waivers = waiversOf(audit);
  report.explanations = explanationsOf(input, report);
  return report;
}

const WAIVABLE_CHECK: Partial<Record<CondId, string>> = { instructions: "context.instructions_verified", safety: "safety.execution_boundary" };

// A finding the team has reviewed as wrong is waived in the repo, not fixed, so the step that fixes
// findings says how.
function waiverStep(check: string): { title: string; detail: string } {
  return {
    title: "Waive a finding that is a false positive",
    detail: `If a finding is wrong, don't change the repo to satisfy it: commit an entry to ${WAIVER_FILE} with "check": "${check}", "match" (the file or file:line), "reason" (why it is a false positive) and "by" (who reviewed it). The next audit reads the file from its commit and lists each waiver in part 5. A waiver can't cover a Level 1 check.`,
  };
}

// Most of the repo's recent changes sit in components the audit doesn't assess, such as a Go
// backend next to a small web UI, so the level speaks for the minority and the heading says so.
function mostlyUnassessed(input: ModelInput): boolean {
  return !notAssessed(input) && input.partial.partial && input.partial.unassessedShare > 0.5;
}

// Only what the reader should act on reaches page 1, phrased as the action. An eval seed, a recorded
// PR file and an unkeyed seal need no action from a reader and stay in "About this report".
function noticesOf(input: ModelInput): { text: string }[] {
  const { audit } = input;
  const out: string[] = [];
  const release = input.sealStatus.match(/differ from release (\S+?);/)?.[1];
  if (release) out.push(`This audit ran with scripts that differ from the released skill (${release}), so it isn't a released result. Reinstall the released skill and rerun the audit.`);
  else if (input.sealStatus.startsWith("Seal not verified: no release manifest")) out.push("This copy of the skill ships no release manifest, so its scripts can't be checked against a release. Install a released copy and rerun the audit.");
  if (input.staleCopy) out.push(`${input.staleCopy} Update the installed skill and rerun the audit.`);
  if (audit.tier === "read-only") out.push("This audit ran at the read-only tier, so it ran no repo command. Rerun it with --tier local-exec to get a level.");
  else if (!audit.environment.containerRuntime && audit.evidence.some((e) => e.where === "fresh_copy")) out.push("This audit ran without a container runtime, so Level 1 is unproven. Install Docker or Podman, or run it in CI, and rerun the audit.");
  if (audit.repo.dirtyTree) out.push("Uncommitted changes weren't audited. Commit them and rerun the audit to include them.");
  return out.map((text) => ({ text }));
}

// What changed since the previous audit, read from its sealed report and this one only.
export function changesOf(prev: ReportJson, now: ReportJson, rubric: Rubric): ReportChanges {
  // An unproven result is no level: its 0 is only there for the rollup's minimum, never to compare.
  const repoLevel = (r: ReportJson) => (r.maturity.outcome === "not_assessed" || r.maturity.unproven || r.maturity.status === "undetermined" ? null : r.maturity.level);
  const levels = (r: ReportJson) => new Map(r.components.included.map((c) => [c.id, c.unproven ? null : c.level] as [string, Level | null]));
  const before = levels(prev);
  const after = levels(now);
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  const components = ids.map((id) => ({ id, from: before.get(id) ?? null, to: after.get(id) ?? null })).filter((c) => c.from !== c.to);
  // The level a condition is needed for: a failing Level 1 condition only regresses a component that had reached Level 1.
  const condLevel = (c: string) => (rubric.level1.includes(c as CondId) ? 1 : rubric.level2.includes(c as CondId) ? 2 : 3);
  const caps = (r: ReportJson) => new Map(r.components.included.flatMap((c) => c.capReasons.map((k) => [`${c.id}\u0000${k.condition}`, { component: c.id, condition: k.condition, label: k.label, reason: k.reason, state: k.state }] as const)));
  const was = caps(prev);
  const is = caps(now);
  const held = (id: string) => (after.get(id) ?? -1) >= (before.get(id) ?? 0);
  const nowMet = [...was.entries()].filter(([k, v]) => !is.has(k) && after.get(v.component) != null && held(v.component)).map(([, v]) => ({ component: v.component, label: v.label }));
  const nowFailing = [...is.entries()].filter(([k, v]) => !was.has(k) && v.state === "not_met" && (before.get(v.component) ?? -1) >= condLevel(v.condition)).map(([, v]) => ({ component: v.component, label: v.label, reason: v.reason }));
  const okBefore = new Map(prev.details.checks.map((c) => [c.id, c.ok]));
  const checks = now.details.checks.filter((c) => okBefore.has(c.id) && okBefore.get(c.id) !== c.ok && (okBefore.get(c.id) === false || c.ok === false)).map((c) => ({ id: c.id, name: c.name, from: okBefore.get(c.id) ?? null, to: c.ok }));
  return { since: { audit: prev.audit.id, date: prev.audit.date }, repo: { from: repoLevel(prev), to: repoLevel(now) }, components, nowMet, nowFailing, checks };
}

function plantedFaultsRecord(audit: Audit, rubric: Rubric): string {
  const faults = audit.evidence.filter((e) => e.condition === "faults");
  if (faults.length > 0 && faults.every((e) => e.skipped)) return `not planted: ${faults[0].skipped} skipped them, so no fault check ran`;
  if (audit.seed.pinned) return "seed pinned (eval run; not a production result)";
  return rubric.mutation.seedFrom === "code" ? "chosen from the code, so they stay the same until the component's code or tests change" : "fresh seed for this audit";
}

// Held at Level 0 only because this machine couldn't check Level 1: nothing that ran failed.
// Every Level 1 condition left is blocked here, and a blocked step may have run (a build cut off by
// the network), so the heading says none failed rather than that every one that ran passed.
export function unprovenHeading(caps: { condition: string; state: string }[]): string {
  const n = new Set(caps.filter((c) => c.state === "blocked").map((c) => c.condition)).size;
  return `Level 1 unproven on this machine: no Level 1 check failed, and ${n} ${n === 1 ? "was" : "were"} blocked here`;
}

// No level is named: the heading's level would be one the audit couldn't decide.
export function undeterminedHeading(caps: { condition: string; state: string }[]): string {
  const n = new Set(caps.filter((c) => c.state === "unknown").map((c) => c.condition)).size;
  return `Undetermined: no Level 1 check failed for a reason in the repo, and ${n} couldn't be decided`;
}

function undetermined(input: ModelInput): boolean {
  return !notAssessed(input) && Boolean(input.rollup.undetermined);
}

// Status and settleBy are reported from the rubric that can make a level undetermined.
function rubricStatus(input: ModelInput): boolean {
  return attributes(input.rubric);
}

function levelStatus(none: boolean, undet: boolean, unproven: boolean): LevelStatus {
  return none ? "not_assessed" : undet ? "undetermined" : unproven ? "unproven" : "proven";
}

// The first condition the audit couldn't decide, in plain words for part 1.
function undeterminedCause(input: ModelInput): string {
  const reason = capReasons(input).find((c) => c.state === "unknown" && c.reason.startsWith(UNDETERMINED))?.reason ?? capReasons(input).find((c) => c.state === "unknown")?.reason;
  const plain = (reason ?? "").replace(UNDETERMINED, "").replace(/`/g, "").replace(/\s*\([^)]*\)/g, "");
  return plain && quotable(input, plain) ? plain : "a check that decides it didn't produce a result";
}

// What settles an unproven or undetermined level, from the reasons that hold it.
export function settleByOf(input: ModelInput, caps: { component: string; state: string; reason: string }[]): SettleBy | null {
  const open = caps.filter((c) => c.state === "unknown" || c.state === "blocked");
  if (!open.length) return null;
  const comp = open.find((c) => c.component !== "*")?.component ?? "<component>";
  const why = open.map((c) => c.reason).join("; ");
  if (/couldn't tell how its tests run/.test(why)) return { kind: "add_command", text: `Add the command the repo runs ${comp}'s tests with, \`readiness contract add --kind test --component ${comp} --cmd "<command>"\`, and rerun the audit.` };
  if (/test runner \S+ wasn't there/.test(why)) return { kind: "add_command", text: `Add the install command that brings in ${comp}'s test runner, \`readiness contract add --kind install --component ${comp} --cmd "<command>"\`, and rerun the audit.` };
  if (/image the audit picked|in the audit's image/.test(why)) return { kind: "declare_env", text: `Declare the image ${comp} builds in, in .cursor/environment.json or with --image, and rerun the audit.` };
  if (open.every((c) => c.state === "blocked")) return { kind: "rerun", text: rerunAdvice(input, open.map((c) => c.reason), "prove it") ?? "Rerun the audit where these checks can run." };
  return { kind: "rerun", text: "Rerun the audit; if the result holds, add the command that decides it with `readiness contract add`." };
}

export function unprovenLevel1(level: Level | null, couldBe: Level | null, caps: { state: string }[]): boolean {
  return level === 0 && couldBe === 1 && caps.length > 0 && caps.every((c) => c.state === "blocked");
}

function componentCaps(input: ModelInput, id: string): ComponentLevel["capReasons"] {
  const l = compLevel(input, id);
  if (!l || notAssessed(input)) return [];
  if (l.level >= 2) return l.level < 4 ? l.outcomeReasons.map((r) => ({ component: id, condition: "outcomes", label: outcomeLabel(l.level), state: "not_met" as const, reason: r })) : [];
  const conds = l.level === 0 ? input.rubric.level1 : input.rubric.level2;
  return conds.flatMap((c) => {
    const s = input.states.get(id)?.[c];
    return s && s.state !== "met" ? [{ component: id, condition: c, label: condLabel(input.rubric, c), state: s.state, reason: s.reason }] : [];
  });
}

// Tier 2 and tier 3: every component found, its standard level, and the scenarios added for it.
function componentsOf(input: ModelInput): ReportJson["components"] {
  const comps = input.components;
  const none = notAssessed(input);
  const row = (c: Component) => ({ id: c.id, path: c.path, toolchain: c.toolchain ?? toolchainOf(c), manifest: c.manifest, lockfile: c.lockfile ?? null, changeShare: c.changeShare });
  const sampled = comps.some((c) => c.notAssessedReason?.startsWith("outside the "));
  const ownership = input.audit.profile?.ownership;
  return {
    shape: sampled ? "sampled_monorepo" : input.audit.profile?.repoType === "monorepo" ? "monorepo" : "single",
    included: comps
      .filter((c) => c.assessed)
      .map((c) => {
        const l = compLevel(input, c.id);
        const caps = componentCaps(input, c.id);
        const level = none || !l ? null : l.level;
        const couldBe = none || !l ? null : l.couldBe;
        const unproven = unprovenLevel1(level, couldBe, caps);
        const undet = !none && Boolean(l?.undetermined);
        const status = rubricStatus(input) ? { status: levelStatus(none || !l, undet, unproven), settleBy: undet || unproven ? settleByOf(input, caps) : null } : {};
        const scenarios = [...(input.scenarioLevels.get(c.id) ?? new Map<ScenarioId, LevelResult>()).entries()].map(([sid, s]) => ({ id: sid, label: input.rubric.scenarios.find((x) => x.id === sid)!.label, level: none ? null : s.level, couldBe: none ? null : s.couldBe, unproven: unproven && s.level === 0 && s.couldBe === 1 }));
        return { ...row(c), placement: "component" as const, active: input.active.has(c.id), level: undet ? null : level, couldBe, unproven, ...status, capReasons: caps, scenarios };
      }),
    excluded: [
      ...comps.filter((c) => !c.assessed).map((c) => ({ ...row(c), placement: "component" as const, reason: c.notAssessedReason ?? "not assessed" })),
      ...(input.audit.profile?.satellites ?? []).map((s) => ({ id: s.path.split("/").pop() || s.path, path: s.path, toolchain: s.toolchain, manifest: s.manifest, lockfile: null, changeShare: s.changeShare ?? 0, placement: "satellite" as const, reason: `not a component: ${s.reason}` })),
      ...(input.audit.profile?.units ?? []).filter((u) => u.placement === "unplaced").map((u) => ({ id: u.path.split("/").pop() || u.path, path: u.path, toolchain: "unknown", manifest: u.manifest, lockfile: null, changeShare: 0, placement: "unplaced" as const, reason: `not placed: ${u.reason}` })),
    ],
    ...(ownership ? { unownedShare: ownership.unownedShare, unownedTop: ownership.unownedTop } : {}),
  };
}

// A test that reaches the internet fails in the audit even when it passes on a laptop, so the report
// says the network was off for it.
export const NETWORK_OFF_NOTE = "the network is on for the install and build and switched off for tests, type-checks and planted faults, so a test that needs the internet fails here";

function ranTestsInContainer(audit: Audit): boolean {
  return audit.evidence.some((e) => e.where === "container" && e.kind === "test" && e.result !== "not_run");
}

function networkNote(audit: Audit): string {
  return ranTestsInContainer(audit) ? `; ${NETWORK_OFF_NOTE}` : "";
}

// Each toolchain the audit copied in beside the image's own, and why the build needs it.
export function toolchainsNote(env: Audit["environment"]): string {
  return (env.toolchains ?? [])
    .map((t) => (t.added ? `; added ${t.spec} from ${t.image}, because ${t.reason}` : `; couldn't add ${t.spec} from ${t.image}, needed because ${t.reason}`))
    .join("");
}

function userEntryNote(env: Audit["environment"]): string {
  const m = env.userEntryMissing;
  return m ? `; uid ${m.uid} has no /etc/passwd entry in ${m.images.join(", ")}, and the image's user couldn't add one` : "";
}

function toolchainOf(c: Component): string {
  return LANGUAGE_LABELS[c.language] ?? "unknown";
}

function missingList(assets: Asset[]): string[] {
  const missing: string[] = [];
  if (!assets.some((a) => a.kind === "agents_md")) missing.push("an AGENTS.md");
  if (!assets.some((a) => a.kind === "environment")) missing.push("an environment setup");
  if (!assets.some((a) => a.kind === "skill")) missing.push("skills");
  if (!assets.some((a) => a.kind === "hooks")) missing.push("hooks");
  return missing;
}
