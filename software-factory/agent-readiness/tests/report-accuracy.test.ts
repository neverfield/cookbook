import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { blocksText, startFailureCause } from "../skill/agent-readiness/scripts/lib/model.ts";
import { headlineCauseErrors, renderMarkdown, validatePart1 } from "../skill/agent-readiness/scripts/lib/render.ts";
import { renderHtml } from "../skill/agent-readiness/scripts/lib/render-html.ts";
import { latestRubricVersion, loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import type { Audit, HistoryLine, ReportJson, RoadmapItem } from "../skill/agent-readiness/scripts/lib/types.ts";
import { instruction, makeAudit, reportFor } from "./helpers.ts";

const rubric = loadRubric(latestRubricVersion());

const lineFor = (r: ReportJson, id: string, date: string): HistoryLine => ({
  id,
  kind: "audit",
  date,
  commit: "abc",
  rubric: r.audit.rubric,
  scriptsDigest: "x",
  result: "sealed",
  levels: Object.fromEntries(r.components.included.map((c) => [c.id, c.level ?? 0])),
  repoLevel: r.maturity.level,
  scenarioLevels: {},
  ...(r.maturity.unproven ? { noLevel: true, unproven: true } : {}),
  shares: Object.fromEntries(r.components.included.map((c) => [c.id, c.changeShare])),
  active: r.components.included.filter((c) => c.active).map((c) => c.id),
  seedPinned: false,
});

// The audit a machine without a container runtime gives: every Level 1 step blocked, none failed.
function noRuntime(id: string): Audit {
  const audit = makeAudit({ id, components: [{ id: "app", share: 1, where: "fresh_copy", faults: "pass" }], createdAt: "2026-11-10T15:00:00.000Z" });
  audit.environment.containerRuntime = null;
  return audit;
}

describe("an unproven re-audit is never compared as Level 0", () => {
  const first = reportFor(makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] }));
  const firstLine = lineFor(first, first.audit.id, "2026-10-27");

  test("Level 2, then a rerun without Docker: no level, not a drop", () => {
    assert.equal(first.maturity.level, 2);
    const r = reportFor(noRuntime("aud-2"), [firstLine], null, first);
    assert.equal(r.maturity.unproven, true);
    assert.deepEqual(r.progress!.changes!.repo, { from: 2, to: null });
    assert.deepEqual(r.progress!.changes!.components, [{ id: "app", from: 2, to: null }]);
    const md = renderMarkdown(r, rubric);
    assert.doesNotMatch(md, /Down from Level 2|Level 2 to Level 0|to Level 0/);
    assert.match(md, /Level 2 at the audit on Oct 27; this audit couldn't prove a level on this machine, so it isn't a change in the repo/);
    assert.match(md, /- \*\*Repo level:\*\* Level 2 to unproven on this machine \(no level, so not a drop\)\./);
    const html = renderHtml(r);
    assert.doesNotMatch(html, /Changed since|Down from/);
    assert.match(html, /couldn&#39;t prove a level on this machine|couldn't prove a level on this machine/);
    assert.match(html, /not compared/);
  });

  test("a second rerun without Docker says there is no level to compare, not Level 0 to Level 0", () => {
    const second = reportFor(noRuntime("aud-2"), [firstLine], null, first);
    const r = reportFor(noRuntime("aud-3"), [firstLine, lineFor(second, "aud-2", "2026-11-10")], null, second);
    assert.deepEqual(r.progress!.changes!.repo, { from: null, to: null });
    const md = renderMarkdown(r, rubric);
    assert.doesNotMatch(md, /Level 0 to Level 0/);
    assert.match(md, /No level to compare: neither this audit nor the one on Nov 10 gave one/);
  });
});

describe("headline causes match the condition states", () => {
  // changesets: docs has no test command; cli's tests were blocked by a sibling package not built first.
  function changesets(): Audit {
    const audit = makeAudit({ components: [{ id: "docs", share: 0.64, test: "missing", testFiles: 0 }, { id: "cli", share: 0.19, test: "not_run" }, { id: "logger", share: 0.17, faults: "fail" }] });
    Object.assign(audit.evidence.find((e) => e.component === "cli" && e.kind === "test")!, { result: "fail", summary: "test blocked", blocked: "a sibling package the audit didn't build first, which isn't supported yet" });
    return audit;
  }

  test("changesets: an unproven component is never said to fail its tests", () => {
    const r = reportFor(changesets());
    const cli = r.components.included.find((c) => c.id === "cli")!;
    assert.equal(cli.unproven, true);
    assert.deepEqual(r.maturity.setBy.sort(), ["cli", "docs"]);
    assert.doesNotMatch(r.executive.headline, /cli fails its tests/);
    assert.match(r.executive.headline, /^docs has no tests and cli couldn't be checked on this machine/);
    assert.deepEqual(headlineCauseErrors(r), []);
    assert.deepEqual(validatePart1(r, rubric, null), []);
  });

  test("the check catches the headline the pinned changesets trial recorded before", () => {
    const r = reportFor(changesets());
    r.executive.headline = "docs has no tests and cli fails its tests from a clean checkout, so agents can't check their changes there yet, and 83% of recent changes land there.";
    assert.deepEqual(headlineCauseErrors(r), ["the headline says cli fails its tests, but its clean.test condition is blocked"]);
    r.executive.headline = "Level 1 couldn't be proved for docs on this machine.";
    assert.deepEqual(headlineCauseErrors(r), ["the headline says Level couldn't be proved for docs, but a condition failed for it"]);
  });

  test("microsoft/TypeScript: a failed Level 2 condition is named; a blocked one isn't a fail, and a 0% component's advice isn't used", () => {
    const audit = makeAudit({ components: [{ id: "tsc", share: 1, faults: "not_run" }, { id: "typescript-wasip1-wasm", share: 0, test: "fail" }], instructions: [instruction("fail", "go generate ./...", "fails at the root")] });
    Object.assign(audit.evidence.find((e) => e.component === "tsc" && e.condition === "faults")!, { blocked: "the time budget ran out" });
    Object.assign(audit.evidence.find((e) => e.component === "typescript-wasip1-wasm" && e.kind === "test")!, { summary: "test blocked", diagnosis: { cause: "missing_tool", detail: "wasmtime is not installed" }, blocked: "wasmtime isn't in the audit's image" });
    const r = reportFor(audit);
    assert.equal(r.maturity.level, 1);
    assert.deepEqual(r.maturity.setBy, ["tsc"]);
    assert.equal(r.executive.headline, "Agents can build and test tsc, but its agent instructions don't match the repo; planted faults couldn't run on this machine.");
    assert.doesNotMatch(r.executive.headline + r.executive.heading, /--image|is blocked on this machine/);
    assert.match(r.executive.heading, /^Level 1 of 4, bootable; Level 2 isn't met, and some of its checks were blocked on this machine$/);
    assert.equal(r.executive.noBlocker, false);
    assert.deepEqual(headlineCauseErrors(r), []);
  });

  test("opentelemetry-go: Go modules held only by a blocked install are named as unchecked, never as failing", () => {
    const audit = makeAudit({ components: [{ id: "log", share: 0.6, faults: "pass" }, { id: "app", share: 0.4, test: "missing", testFiles: 0 }] });
    Object.assign(audit.evidence.find((e) => e.kind === "install")!, { command: "pip install -r requirements.txt", result: "fail", summary: "install blocked", diagnosis: { cause: "network", detail: "a TLS or certificate error" }, blocked: "the install hit a TLS or certificate error" });
    const r = reportFor(audit);
    assert.equal(r.components.included.find((c) => c.id === "log")!.unproven, true);
    assert.match(r.executive.headline, /^app has no tests and log couldn't be checked on this machine/);
    assert.deepEqual(headlineCauseErrors(r), []);
  });
});

describe("a container that never started", () => {
  function notStarted(image: string, error: string): Audit {
    const audit = makeAudit({ components: [{ id: "C-Sharp", share: 1, test: "not_run" }] });
    const why = `the audit's docker container (${image}) didn't start: ${error}, and host mode wasn't allowed (--allow-host), so no repo command ran outside a container`;
    audit.environment.notRun = why;
    audit.environment.image = image;
    for (const e of audit.evidence) Object.assign(e, { result: "not_run", summary: `not run: ${why}`, blocked: why });
    return audit;
  }

  test("the headline names the cause, and nothing says it ran in that container", () => {
    const r = reportFor(notStarted("mcr.microsoft.com/dotnet/sdk:8.0", 'Error response from daemon: Head "https://mcr.microsoft.com/v2/dotnet/sdk/manifests/8.0": EOF'));
    assert.equal(r.maturity.unproven, true);
    assert.equal(r.executive.headline, "Level 1 couldn't be proved for C-Sharp because the image mcr.microsoft.com/dotnet/sdk:8.0 couldn't be pulled, because mcr.microsoft.com couldn't be reached from this machine. A rerun where that image can be pulled, or with another image passed with --image, can prove it.");
    const record = r.details.record.find((x) => x.label === "Replay environment")!.value;
    assert.match(record, /^none: the audit's docker container \(mcr\.microsoft\.com\/dotnet\/sdk:8\.0\) didn't start/);
    for (const e of r.explanations ?? []) assert.doesNotMatch(e.where, /in a clean .*container/, `${e.subject}: ${e.where}`);
    assert.ok((r.explanations ?? []).some((e) => e.kind === "level" && /^(not run|nowhere: )/.test(e.where)));
  });

  test("start errors in one plain cause each", () => {
    assert.equal(startFailureCause("the audit's docker container (nope:does-not-exist) didn't start: Unable to find image 'nope:does-not-exist' locally: pull access denied for nope"), "the image nope:does-not-exist doesn't exist on Docker Hub or can't be pulled");
    assert.equal(startFailureCause("the audit's docker container (node:22) didn't start: toomanyrequests: You have reached your pull rate limit"), "Docker Hub refused to send the image node:22 because of its rate limit");
    assert.equal(startFailureCause("the install hit a network error"), null);
  });

  test("with no container runtime, the where-cell never reads \"container container\"", () => {
    const r = reportFor(noRuntime("aud-x"));
    for (const e of r.explanations ?? []) assert.doesNotMatch(e.where, /container container/);
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "not_run" }] });
    audit.environment.containerRuntime = null;
    for (const e of audit.evidence) Object.assign(e, { result: "not_run", blocked: "no container runtime" });
    for (const e of reportFor(audit).explanations ?? []) assert.doesNotMatch(e.where, /container container|in a clean/);
  });
});

describe("the report says tests ran with the network off", () => {
  test("in the coverage line, the environment record and the test condition's rule", () => {
    const r = reportFor(makeAudit({ components: [{ id: "pocketbase", share: 1, test: "fail", faults: "not_run" }] }));
    assert.match(r.executive.coverage, /Tests and planted faults ran in a clean container with the network switched off/);
    assert.match(r.details.record.find((x) => x.label === "Replay environment")!.value, /switched off for tests/);
    assert.doesNotMatch(r.executive.headline, /network/, "the headline names the network only when the output showed it");
    const cond = (r.explanations ?? []).find((e) => e.kind === "condition" && e.subject.startsWith("pocketbase: ") && /test/i.test(e.subject) && /network switched off/.test(e.rule));
    assert.ok(cond, "the test condition's rule names the network");
    assert.deepEqual(validatePart1(r, rubric, null), []);
  });

  test("not when nothing ran in a container", () => {
    assert.doesNotMatch(reportFor(noRuntime("aud-y")).executive.coverage, /network switched off/);
  });
});

describe("a step claims the level its own conditions block", () => {
  const item = (fixes: RoadmapItem["fixes"], unlocks: string) => ({ id: "x", order: 1, kind: "fix", template: "instructions", title: "x", status: "next", fixes, unlocks, impact: 0, effort: "small", size: "", ownerRole: "", decision: null, dependsOn: [], why: "", doneWhen: "", steps: [], expected: { outcome: "", watch: { metric: "merged", scope: "repo", baseline: "" } }, evidence: [], createdAt: "", createdBy: "", closedAt: null, closedBy: null, observed: null }) as unknown as RoadmapItem;

  test("an instruction fix that unlocks another component's Level 1 together with an install fix blocks Level 2, not Level 1", () => {
    const fix = item([{ component: "*", condition: "instructions" } as RoadmapItem["fixes"][number]], "docs to Level 1, app to Level 2 together with Fix the install in docs");
    assert.equal(blocksText(rubric, fix), "Blocks Level 2 for app");
  });

  test("a Level 1 fix names Level 1 for its own component, and a Level 2 one for the component it lifts", () => {
    assert.equal(blocksText(rubric, item([{ component: "docs", condition: "clean.test" } as RoadmapItem["fixes"][number]], "docs to Level 2")), "Blocks Level 1 for docs");
    assert.equal(blocksText(rubric, item([{ component: "app", condition: "faults" } as RoadmapItem["fixes"][number]], "app to Level 2, web to Level 2")), "Blocks Level 2 for app");
  });

  test("part 1's gap in markdown and HTML says the instruction step blocks Level 2", () => {
    const r = reportFor(makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }], instructions: [instruction("fail", "npm run typecheck", 'no "typecheck" script')] }));
    assert.match(r.executive.gaps[0].blocks, /^Blocks Level 2/);
    assert.match(renderMarkdown(r, rubric), /\.\*\* Blocks Level 2/);
    assert.match(renderHtml(r), /Blocks Level 2/);
    assert.doesNotMatch(renderMarkdown(r, rubric) + renderHtml(r), /Blocks Level 1/);
  });
});

describe("the step that fixes findings says how to waive a false positive", () => {
  test("instructions: in report.json, the markdown step and the HTML step", () => {
    const r = reportFor(makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }], instructions: [instruction("fail", "npm run typecheck", 'no "typecheck" script')] }));
    const step = r.details.steps.find((s) => s.itemId === r.actions[0].itemId)!;
    assert.match(step.steps.at(-1)!.detail, /\.agent-readiness\/waivers\.json with "check": "context\.instructions_verified"/);
    assert.match(renderMarkdown(r, rubric), /- \*\*False positives:\*\* If a finding is a false positive, waive it in `\.agent-readiness\/waivers\.json`/);
    assert.match(renderHtml(r), /<dt>False positives<\/dt><dd>If a finding is a false positive, waive it in \.agent-readiness\/waivers\.json/);
  });

  test("not on a step a waiver can't cover", () => {
    const r = reportFor(makeAudit({ components: [{ id: "app", share: 1, faults: "fail" }] }));
    assert.doesNotMatch(renderMarkdown(r, rubric), /False positives/);
  });
});
