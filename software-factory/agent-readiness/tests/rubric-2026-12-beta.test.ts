import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { inventory } from "../skill/agent-readiness/scripts/lib/assets.ts";
import { discoverContract } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { componentLevel, partialCoverage, statesOf, targetsMet } from "../skill/agent-readiness/scripts/lib/levels.ts";
import { TYPE_CANARIES, typeCanarySite, withCanary } from "../skill/agent-readiness/scripts/lib/mutate.ts";
import { computeOutcomes, matchReverts, stats } from "../skill/agent-readiness/scripts/lib/outcomes.ts";
import { buildProfile } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { renderMarkdown } from "../skill/agent-readiness/scripts/lib/render.ts";
import { updateRoadmap, watchFor } from "../skill/agent-readiness/scripts/lib/roadmap.ts";
import { latestRubricVersion, loadRubric, rubricDir } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { CANARY_MISSING, componentStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import { compute } from "../skill/agent-readiness/scripts/lib/seal.ts";
import { staticSignals } from "../skill/agent-readiness/scripts/lib/signals.ts";
import type { Audit, Component, Evidence, PrRecord } from "../skill/agent-readiness/scripts/lib/types.ts";
import { makeAudit, reportFor } from "./helpers.ts";

const next = loadRubric("2026-12-beta");
const beta = loadRubric("2026-11-beta");
const DAY = 86400000;

function gitRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "readiness-1212-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Contributor A", "-c", "user.email=a@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "initial"], { cwd: dir });
  return dir;
}

const DONE_WHEN = ["commands", "faults", "instructions"];

describe("rubric 2026-12-beta", () => {
  test("is the rubric new audits use, and lists what changed", () => {
    assert.equal(latestRubricVersion(), "2026-12-beta");
    assert.equal((next.changes ?? []).length, 12);
  });

  test("is written as JSON.stringify(rubric, null, 2), so a reformat never moves its digest", () => {
    const text = readFileSync(join(rubricDir(), "2026-12-beta.json"), "utf8");
    assert.equal(JSON.stringify(JSON.parse(text), null, 2) + "\n", text);
  });

  test("changes only the type-check canary, the revert window, where a pass proves Level 1, the fault estimate, secret classes, instruction severities, three templates, three done-whens, one check's why, the not-assessed list, the unowned share, the folder-name hint's share and the Level 0 attribution rule", () => {
    const strip = (r: typeof next) => {
      const c = structuredClone(r) as Partial<typeof next> & Record<string, unknown>;
      delete c.version;
      delete c.changes;
      delete c.canary;
      delete c.proof;
      delete c.safety;
      delete c.severities;
      delete c.attribution;
      const { killRate: _k, estimate: _e, caughtRuns: _r, scoped: _s, identity: _i, timeoutFactor: _t, minRunSec: _m, ...mutation } = r.mutation;
      c.mutation = mutation as typeof r.mutation;
      c.outcomes = { ...r.outcomes, revertDays: undefined, metrics: r.outcomes.metrics.filter((m) => m !== "reverted_within_days") };
      const { "commands:canary": _c, drive: _d, "safety:secret": _s2, ...templates } = r.templates;
      // The done-when and the step that proves it, for the steps whose done-when names a new audit.
      for (const id of DONE_WHEN) templates[id] = { ...templates[id], doneWhen: "", steps: templates[id].steps.map((s) => (/^Prove it/.test(s.title) ? { ...s, detail: "" } : s)) };
      c.templates = templates;
      c.checks = r.checks.map((k) => (k.id === "verify.canonical_interface" ? { ...k, why: "" } : k));
      c.notAssessed = r.notAssessed.filter((n) => n !== "Whether the lint command catches anything");
      c.components = { ...r.components, unowned: undefined, satelliteHintShare: undefined };
      return JSON.parse(JSON.stringify(c));
    };
    assert.deepEqual(strip(next), strip(beta));
    assert.deepEqual([next.canary?.typecheck, next.outcomes.revertDays, beta.canary, beta.outcomes.revertDays], [true, 14, undefined, undefined]);
    assert.deepEqual([next.proof?.environments, beta.proof], [["container", "disposable_vm"], undefined]);
    assert.deepEqual([next.mutation.killRate, beta.mutation.killRate, next.mutation.caughtRuns, next.mutation.scoped, next.mutation.identity, next.severities?.instructions], [undefined, 0.6, 1, true, "fault", "agent_commands"]);
    assert.deepEqual(next.safety?.blockingSecretClasses, ["provider_token", "private_key", "url_credential"]);
    assert.deepEqual(next.templates["safety:secret"].steps.map((s) => s.title), ["Rotate first", "Move the values out", "Prove it"]);
    assert.equal(Object.keys(next.templates).indexOf("drive"), Object.keys(next.templates).indexOf("delegate") + 1, "the drive step comes right after giving agents work");
    assert.deepEqual([next.components.unowned, next.components.satelliteHintShare, beta.components.unowned, beta.components.satelliteHintShare], ["counted", 0.5, undefined, undefined]);
    assert.deepEqual([next.attribution, beta.attribution], [{ level0: "attributed", reruns: ["network", "tool"] }, undefined]);
  });

  // Production-readiness review B6: the printed bar has to be the rule the estimate applies, and the
  // re-audit step has to say what mutation.identity "fault" does.
  test("each done-when names a new audit and the faults step states the estimate's own bar", () => {
    for (const id of DONE_WHEN) {
      const t = next.templates[id];
      assert.doesNotMatch(`${t.doneWhen} ${t.steps.map((s) => s.detail).join(" ")}`.replace(/Run `readiness run --component \{component\}` and read/, ""), /readiness run/, `${id}: a done-when never depends on host mode`);
      assert.match(t.doneWhen, /new audit|audit after the change/, id);
    }
    const faults = next.templates.faults;
    assert.match(faults.doneWhen, /rates \{component\}'s tests strong: at least 60% of planted faults caught, over enough faults to be sure/);
    assert.doesNotMatch(faults.doneWhen, /catches at least 60% of the faults/, "60% of too few faults is inconclusive, so it can't be the bar");
    const prove = faults.steps.find((s) => /new audit/.test(s.title))!.detail;
    assert.doesNotMatch(prove, /plants different faults/);
    assert.match(prove, /never redraws them/);
    assert.match(prove, /missed again first/);
    assert.equal(next.mutation.identity, "fault", "the step's wording holds only while faults are ranked by their own identity");
  });

  test("changes no component holds count toward partial coverage, where 2026-11-beta leaves them out", () => {
    const comps = [{ id: "app", path: "app", language: "ts", manifest: "app/package.json", scripts: {}, changes: 7, changeShare: 0.7, assessed: true }] as Component[];
    const ownership = { changes: 10, unowned: 3, unownedShare: 0.3, unownedTop: ["docs/"], counted: true };
    assert.deepEqual(partialCoverage(next, comps, ownership), { partial: true, unassessedShare: 0.3 });
    assert.deepEqual(partialCoverage(beta, comps, { ...ownership, counted: false }), { partial: false, unassessedShare: 0 });
  });
});

describe("revert rate (reported, never scored)", () => {
  const now = Date.now();
  const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
  const pr = (n: number, head: string, extra: Partial<PrRecord> = {}): PrRecord => ({ number: n, headRefName: head, author: "someone", labels: [], createdAt: iso(20), mergedAt: iso(18), state: "MERGED", files: ["app/x.js"], firstCheck: "success", changesRequested: false, revertedAt: null, ...extra });
  const filter = { branchPrefixes: ["cursor/"], labels: [], authors: [], coAuthorTrailers: [] };
  const comps = () => makeAudit({ components: [{ id: "app", share: 1 }] }).profile!.components;

  test("counts merged PRs reverted within revertDays of merging, for agent and other PRs alike", () => {
    const prs = [
      pr(1, "cursor/a", { revertedAt: iso(17), revertedBy: "#9" }),
      pr(2, "cursor/b", { revertedAt: iso(1), revertedBy: "commit 1a2b3c4" }),
      pr(3, "cursor/c"),
      pr(4, "cursor/d", { mergedAt: null, state: "OPEN" }),
      pr(5, "feature/e", { revertedAt: iso(16) }),
      pr(6, "feature/f"),
    ];
    const o = computeOutcomes(prs, comps(), next, filter, 30, "file");
    assert.deepEqual([o.agent.reverted, o.agent.revertKnown], [1, 3], "#2 was reverted 17 days after merging, past the 14-day window; the open PR isn't counted");
    assert.deepEqual([o.control.reverted, o.control.revertKnown], [1, 2]);
    assert.deepEqual(o.reverts, { days: 14, agent: [{ number: 1, by: "#9" }], mergedRecently: 0 });
  });

  test("without revert fields, or under an older rubric, nothing is counted as not reverted", () => {
    const bare = [pr(1, "cursor/a", { revertedAt: undefined }), pr(2, "feature/b", { revertedAt: undefined })];
    const o = computeOutcomes(bare, comps(), next, filter, 30, "file");
    assert.equal(o.agent.revertKnown, undefined);
    assert.equal(o.reverts?.unavailable, "the recorded PR file has no revertedAt fields");
    const old = computeOutcomes([pr(1, "cursor/a", { revertedAt: iso(17) })], comps(), beta, filter, 30, "file");
    assert.deepEqual([old.agent.reverted, old.reverts], [undefined, undefined]);
    assert.match(watchFor("reverted", "repo", o, next).baseline, /^not measured \(the recorded PR file has no revertedAt fields\)$/);
  });

  test("matches revert PR bodies and titles and revert commits, only after the merge", () => {
    const targets = [
      { number: 10, title: "Fix rounding", mergedAt: "2026-11-01T00:00:00Z", mergeSha: "aaaaaaa1111111111111111111111111111111aa" },
      { number: 11, title: "Add retries", mergedAt: "2026-11-02T00:00:00Z", mergeSha: "bbbbbbb2222222222222222222222222222222bb" },
      { number: 12, title: "Cache totals", mergedAt: "2026-11-03T00:00:00Z", mergeSha: "ccccccc3333333333333333333333333333333cc" },
      { number: 13, title: "Other repo's", mergedAt: "2026-11-03T00:00:00Z", mergeSha: null },
    ];
    const found = matchReverts(
      "example-org/shop",
      targets,
      [
        { number: 20, title: "Revert \"Fix rounding\"", body: "Reverts example-org/shop#10\n\nBroke checkout.", mergedAt: "2026-11-04T00:00:00Z" },
        { number: 21, title: "Revert \"Add retries\"", body: "Retries looped.", mergedAt: "2026-11-05T00:00:00Z" },
        { number: 22, title: "Revert upstream", body: "Reverts other-org/shop#13", mergedAt: "2026-11-05T00:00:00Z" },
      ],
      [
        { oid: "ddddddd4444444444444444444444444444444dd", message: "Revert \"Cache totals\"\n\nThis reverts commit ccccccc3333333333333333333333333333333cc.", committedDate: "2026-11-06T00:00:00Z" },
        { oid: "eeeeeee5555555555555555555555555555555ee", message: "Revert an older change\n\nThis reverts commit aaaaaaa1.", committedDate: "2026-10-01T00:00:00Z" },
      ],
    );
    assert.deepEqual(Object.fromEntries(found), {
      10: { at: "2026-11-04T00:00:00Z", by: "#20" },
      11: { at: "2026-11-05T00:00:00Z", by: "#21" },
      12: { at: "2026-11-06T00:00:00Z", by: "commit ddddddd" },
    });
  });

  test("no level or target reads it: a window with every agent PR reverted still meets the Level 3 targets", () => {
    const agent = { ...stats([pr(1, "cursor/a")], next, []), opened: 20, merged: 20, firstTimeCiPass: 20, firstTimeCiKnown: 20, reverted: 20, revertKnown: 20 };
    const control = { ...agent, reverted: 0 };
    assert.deepEqual(targetsMet(next, { mergeRate: 0.7, firstPass: 0.6, maxChangesRequested: 0.3, minAgentPrs: 20 }, { agent, control }), { met: true, reasons: [] });
  });

  test("part 3 shows the row, how reverts were found, and which agent PRs were reverted", () => {
    const prs = [pr(1, "cursor/a", { revertedAt: iso(17), revertedBy: "#9" }), ...Array.from({ length: 5 }, (_, i) => pr(2 + i, "cursor/b", { mergedAt: iso(3) })), ...Array.from({ length: 5 }, (_, i) => pr(10 + i, "feature/c"))];
    const audit = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] });
    audit.outcomes = computeOutcomes(prs, audit.profile!.components, next, filter, 30, "file");
    const r = reportFor(audit);
    assert.deepEqual(r.details.outcomes!.series.map((s) => s.reverted?.count), [1, 0]);
    const md = renderMarkdown(r, next);
    assert.match(md, /\| Reverted within 14 days \| 17% \(1 of 6\) \| 0% \(0 of 5\) \|/);
    assert.match(md, /these are detected reverts\. 5 of the merged agent PRs merged less than 14 days before the window ended, so they had less time to be reverted\. Reported only: no level or target uses it yet\. Reverted agent PRs: #1 \(by #9\)\./);
  });
});

describe("type-check canary", () => {
  const typecheck = (audit: Audit, result: "pass" | "fail" = "pass") => {
    audit.contract.push({ id: "cmd-app-typecheck", kind: "typecheck", component: "app", cwd: "app", command: "npm run typecheck", source: "package.json scripts.typecheck", reason: "typecheck", timeoutSec: 600 });
    audit.evidence.push({ id: "ev-080", checkId: "verify.canonical_interface", condition: "commands", component: "app", kind: "typecheck", contractId: "cmd-app-typecheck", strength: "clean_replay", where: "container", result, command: "npm run typecheck", summary: `typecheck ${result}`, at: audit.createdAt });
  };
  const canary = (audit: Audit, result: Evidence["result"], extra: Partial<Evidence> = {}) =>
    audit.evidence.push({ id: "ev-081", checkId: "verify.canonical_interface", condition: "commands", component: "app", strength: "clean_replay", where: "container", result, command: "npm run typecheck", summary: `canary ${result}`, canary: { kind: "typecheck", file: "app/src/a.ts", line: TYPE_CANARIES[0].line }, at: audit.createdAt, ...extra });
  const commands = (audit: Audit) => componentStates(audit, loadRubric(audit.rubric), "app").commands;
  const level = (audit: Audit) => componentLevel(loadRubric(audit.rubric), statesOf(componentStates(audit, loadRubric(audit.rubric), "app"))).level;

  test("a type-check that passes with the planted error in place doesn't meet the commands condition", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] });
    typecheck(audit);
    canary(audit, "fail", { summary: "the type-check (`npm run typecheck`) passed with a type error planted in app/src/a.ts, so it doesn't check that file" });
    assert.deepEqual([commands(audit).state, commands(audit).reason], ["not_met", "the type-check (`npm run typecheck`) passed with a type error planted in app/src/a.ts, so it doesn't check that file"]);
    assert.equal(level(audit), 1);
    const r = reportFor(audit);
    assert.deepEqual(r.roadmap.items.filter((i) => i.status === "next" && i.id !== "owner").map((i) => i.id), ["commands:canary:app"]);
    assert.match(r.actions[0].title, /^Make app's type-check cover app\/src\/a\.ts$/);
    assert.match(r.executive.headline, /its type-check passes with a type error planted in the code/);
    const why = r.explanations!.find((e) => e.subject === "app: build, lint, type-check and test commands pass")!;
    assert.match(why.rule, /counts only once it fails on a known type error the audit adds/);
  });

  test("one that failed on it and passed again meets it; with no file to plant in, the exit code alone decides", () => {
    const caught = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] });
    typecheck(caught);
    canary(caught, "pass");
    assert.deepEqual([commands(caught).state, commands(caught).reason], ["met", "2 commands pass, and the type-check failed on a planted type error"]);
    const exempt = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] });
    typecheck(exempt);
    canary(exempt, "not_run", { summary: "no type error was planted: app's tests import no TypeScript or Python file, so its type-check counts on its exit code alone", canary: { kind: "typecheck", file: null, exempt: true } });
    assert.equal(commands(exempt).state, "met");
    assert.match(commands(exempt).reason, /counts on its exit code alone$/);
    assert.equal(level(exempt), 2);
  });

  test("an unfinished canary leaves it unproven, a blocked one blocked, and a failing type-check decides alone", () => {
    const missing = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] });
    typecheck(missing);
    assert.deepEqual([commands(missing).state, commands(missing).reason], ["unknown", CANARY_MISSING]);
    const blocked = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] });
    typecheck(blocked);
    canary(blocked, "not_run", { blocked: "the time budget ran out" });
    assert.equal(commands(blocked).state, "blocked");
    const failing = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] });
    typecheck(failing, "fail");
    assert.deepEqual([commands(failing).state, commands(failing).reason], ["not_met", "typecheck fail"]);
  });

  test("released rubrics ignore it: under 2026-11-beta exit 0 is still enough", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }], rubric: "2026-11-beta" });
    typecheck(audit);
    canary(audit, "fail");
    assert.equal(commands(audit).state, "met");
  });

  test("goes in the most recently changed TypeScript or Python file the tests import, keeping its line endings", () => {
    const repo = gitRepo({
      "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { test: "node --test", typecheck: "tsc" } }),
      "package-lock.json": "{}",
      "tsconfig.json": "{}",
      "src/old.ts": "export const a = 1;\n",
      "src/types.d.ts": "export type T = number;\n",
      "test/a.test.ts": 'import { a } from "../src/old.ts";\nimport { b } from "../src/new.ts";\n',
      "src/new.ts": "export const b = 2;\r\n",
    });
    const env = { ...process.env, GIT_AUTHOR_DATE: "2030-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z" };
    writeFileSync(join(repo, "src/new.ts"), "export const b = 3;\r\n");
    execFileSync("git", ["-c", "user.name=Contributor A", "-c", "user.email=a@example.com", "-c", "commit.gpgsign=false", "commit", "-qam", "change new"], { cwd: repo, env });
    const comp = buildProfile(repo, repo, next).components[0];
    const site = typeCanarySite(repo, repo, comp);
    assert.deepEqual(site, { file: "src/new.ts", line: TYPE_CANARIES[0].line });
    assert.equal(withCanary("export const b = 3;\r\n", site!.line), `export const b = 3;\r\n${site!.line}\r\n`);
    assert.equal(withCanary("x = 1", "y"), "x = 1\ny\n");
    const js = gitRepo({ "package.json": JSON.stringify({ name: "lib", scripts: { test: "node --test" } }), "package-lock.json": "{}", "src/a.js": "export const a = 1;\n", "test/a.test.js": 'import { a } from "../src/a.js";\n' });
    assert.equal(typeCanarySite(js, js, buildProfile(js, js, next).components[0]), null, "JavaScript gets no canary: a type-check of its .d.ts files would fail it unfairly");
  });
});

describe("a scripted way to drive the app (informational)", () => {
  const signal = (repo: string) => {
    const profile = buildProfile(repo, repo, next);
    return staticSignals(repo, profile, discoverContract(profile, repo, next, [])).find((s) => s.id === "drive_app")!;
  };
  const app = { "package.json": JSON.stringify({ name: "web", scripts: { test: "vitest run", dev: "vite" } }), "package-lock.json": "{}", "src/a.js": "export const a = 1;\n" };

  test("an app with nothing to drive it is a gap, a library has nothing to drive, and a harness or verify skill counts", () => {
    const bare = signal(gitRepo(app));
    assert.deepEqual([bare.found, bare.undriven], [false, [{ id: "web", surface: "a `dev` script" }]]);
    assert.match(bare.detail, /^none: no Playwright, Cypress or WebdriverIO specs, verify skill, smoke script or terminal harness, though there is an app to run in web \(a `dev` script\)$/);
    const lib = signal(gitRepo({ "package.json": JSON.stringify({ name: "lib", scripts: { test: "node --test" } }), "package-lock.json": "{}", "src/a.js": "export const a = 1;\n" }));
    assert.equal(lib.found, null);
    const pw = signal(gitRepo({ ...app, "playwright.config.ts": "export default {};\n" }));
    assert.deepEqual([pw.found, pw.detail, pw.undriven], [true, "Playwright config (playwright.config.ts)", undefined]);
    const skill = gitRepo({ ...app, ".cursor/skills/verify-web/SKILL.md": "---\nname: verify-web\ndescription: Drive the web app.\n---\n\n## Launch\n", ".cursor/skills/verify-web/features/checkout.md": "# Checkout\n", ".cursor/skills/verify-web/features/login.md": "# Login\n" });
    assert.deepEqual([signal(skill).found, signal(skill).detail], [true, "a verify skill with a feature map of 2 features (.cursor/skills/verify-web/SKILL.md)"]);
    assert.match(inventory(skill, skill, []).find((a) => a.path === ".cursor/skills/verify-web/SKILL.md")!.status, /; a verify skill, with a feature map of 2 features$/);
    const drafted = signal(gitRepo({ ...app, ".cursor/skills/verify/SKILL.md": "---\nname: verify\ndescription: Commands.\n---\n\n## Verify\n" }));
    assert.equal(drafted.found, false, "the audit's own drafted verify skill only runs commands, so it doesn't drive the app");
  });

  test("adds a later roadmap step after giving agents work, sets no level, and isn't in released rubrics", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] });
    audit.signals = [{ id: "drive_app", label: "A scripted way to drive the app", found: false, detail: "none", undriven: [{ id: "app", surface: "a `dev` script" }] }];
    const r = reportFor(audit);
    assert.equal(r.maturity.level, 2);
    const ids = r.roadmap.items.map((i) => i.id);
    assert.ok(ids.indexOf("drive:app") > ids.indexOf("delegate:app"), ids.join(", "));
    const step = r.roadmap.items.find((i) => i.id === "drive:app")!;
    assert.deepEqual([step.status, step.level, step.title], ["later", null, "Give agents a way to drive app"]);
    assert.ok(!r.actions.some((a) => a.itemId === "drive:app"), "never one of part 1's actions");
    assert.match(renderMarkdown(r, next), /Only the drive-the-app signal can add a roadmap step: a later one, for a component already at Level 2\./);
    const older = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }], rubric: "2026-11-beta" });
    older.signals = audit.signals;
    assert.ok(!reportFor(older).roadmap.items.some((i) => i.id === "drive:app"), "released rubrics have no drive step");
  });

  test("the step closes once the next audit finds a way to drive the component", () => {
    const ctx = (signals: Audit["signals"]) => {
      const audit = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] });
      audit.signals = signals;
      const c = compute(audit, next, [], null);
      return { audit, rubric: next, components: audit.profile!.components, states: c.states, active: c.active, outcomes: null };
    };
    const first = updateRoadmap(null, ctx([{ id: "drive_app", label: "A scripted way to drive the app", found: false, detail: "none", undriven: [{ id: "app", surface: "a `dev` script" }] }])).roadmap;
    assert.equal(first.items.find((i) => i.id === "drive:app")?.status, "later");
    const second = updateRoadmap(first, ctx([{ id: "drive_app", label: "A scripted way to drive the app", found: true, detail: "Playwright config (playwright.config.ts)" }])).roadmap;
    assert.equal(second.items.find((i) => i.id === "drive:app")?.status, "done");
  });
});
