import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, test } from "node:test";
import { freezeProblems, leaves, ledgerOf, ledgerProblems, lessMoves, negativeCases, onlyRemoves, sideOf } from "../support/tools/instrument-freeze.ts";
import type { Tree } from "../support/tools/instrument-freeze.ts";
import { ACCELERATOR, SKILL } from "../support/tools/fixture.ts";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (n === "node_modules" ? [] : statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
}

const WORKFLOWS = join(ACCELERATOR, "..", "..", ".github", "workflows");

describe("the instrument freeze", () => {
  test("the scripts side is the eval binding's scripts digest: the skill but its rubrics and RELEASE.json", () => {
    for (const f of walk(SKILL).map((p) => relative(ACCELERATOR, p).split(sep).join("/"))) {
      const want = f.startsWith("skill/agent-readiness/rubric/") || f === "skill/agent-readiness/RELEASE.json" ? "other" : "scripts";
      assert.equal(sideOf(f), want, f);
    }
  });

  test("graders, the trials' recordings, the known failures and the gate's workflows are instrument; fixture inputs and the collision log are not", () => {
    for (const f of ["support/evals/lib/grade.ts", "support/evals/cases/negative.ts", "support/evals/run.ts", "support/tools/fixture.ts", "support/fixtures/healthy-node/expected.json", "support/fixtures/make-test-unit/truth.json", "support/holdout/score.ts", "support/holdout/observe.ts", "support/trials/truth/zap.json", "support/trials/trials.test.ts", "support/trials/trials.json", "tests/known-failures.json", "../../.github/workflows/agent-readiness.yml", "../../.github/workflows/agent-readiness-freeze.yml"]) assert.equal(sideOf(f), "instrument", f);
    for (const f of ["support/fixtures/make-test-unit/repo/Makefile", "support/fixtures/make-test-unit/history.json", "support/holdout/collision-log.json", "support/holdout/records/commitment.json", "tests/levels.test.ts", "README.md", "skill/agent-readiness/rubric/2026-11-beta.json", "../../.github/workflows/other.yml", "../../README.md"]) assert.notEqual(sideOf(f), "instrument", f);
  });

  test("every agent-readiness workflow in the repo is instrument", () => {
    const names = readdirSync(WORKFLOWS).filter((n) => n.startsWith("agent-readiness"));
    assert.ok(names.length >= 2, names.join(", "));
    for (const n of names) assert.equal(sideOf(`../../.github/workflows/${n}`), "instrument", n);
  });

  test("fails a change to both unless the description names the exception", () => {
    const both = ["skill/agent-readiness/scripts/lib/profile.ts", "support/fixtures/healthy-node/expected.json"];
    assert.equal(freezeProblems(both, "Fixes discovery.").length, 2);
    assert.deepEqual(freezeProblems(both, "Fixes discovery.\n\nInstrument-freeze exception: the expected level moves because the root app is now found"), []);
    assert.equal(freezeProblems(both, "Instrument-freeze exception: ").length, 2, "an exception needs a reason");
    assert.deepEqual(freezeProblems(["skill/agent-readiness/scripts/lib/profile.ts", "support/fixtures/new-shape/repo/package.json", "tests/discovery.test.ts"], ""), [], "a fix may land with new fixture inputs and tests");
    assert.deepEqual(freezeProblems(["support/holdout/observe.ts", "support/evals/lib/grade.ts"], ""), []);
    assert.equal(freezeProblems(["skill/agent-readiness/scripts/lib/replay.ts", "support/trials/trials.json"], "").length, 2, "a scripts PR can't re-record a trial unannounced");
    assert.equal(freezeProblems(["skill/agent-readiness/scripts/lib/replay.ts", "../../.github/workflows/agent-readiness.yml"], "").length, 2, "nor edit the gate");
  });

  test("a scripts PR may take its own entries out of the known failures, and nothing else", () => {
    const fix = ["skill/agent-readiness/scripts/lib/levels.ts", "tests/known-failures.json"];
    const a = { file: "tests/x.test.ts", test: "a", finding: "1", fixedBy: "B" };
    const b = { file: "tests/x.test.ts", test: "b", finding: "2", fixedBy: "C" };
    const list = (...f: unknown[]) => JSON.stringify({ about: "", failures: f });
    assert.ok(onlyRemoves(list(a, b), list(b)));
    assert.ok(!onlyRemoves(list(a), list(a, b)), "adding one isn't removal");
    assert.ok(!onlyRemoves(list(a), list({ ...a, fixedBy: "H" })), "moving one to a later PR isn't removal");
    assert.ok(!onlyRemoves(null, list()), "a new list isn't removal");
    assert.deepEqual(freezeProblems(fix, "", ["tests/known-failures.json"]), []);
    assert.equal(freezeProblems(fix, "").length, 2);
  });

  test("CI runs the base's copy on every pull request, rerunning when the description changes, and on every gate workflow change", () => {
    const wf = readFileSync(join(WORKFLOWS, "agent-readiness-freeze.yml"), "utf8");
    assert.match(wf, /types: \[opened, synchronize, reopened, edited\]/);
    assert.match(wf, /SA_PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
    assert.match(wf, /--base "origin\/\$\{\{ github\.base_ref \}\}"/);
    assert.match(wf, /fetch-depth: 0/);
    assert.match(wf, /paths: \["software-factory\/agent-readiness\/\*\*", "\.github\/workflows\/agent-readiness\*\.yml"\]/);
    assert.match(wf, /git show "origin\/\$\{\{ github\.base_ref \}\}:software-factory\/agent-readiness\/support\/tools\/instrument-freeze\.ts"/);
  });
});

function trialsJson(trials: object[]): string {
  return JSON.stringify({ now: "", seed: "", trials });
}

const RUBRIC = JSON.stringify({ budgets: { commandTimeoutSec: 600, componentMinutes: 15, totalMinutes: 60 } });
const recorded = { any: { exit: 0, sealed: true, level: 2, components: { a: { level: 2, unproven: false } }, notAssessed: [], headline: "h" } };

function tree(trials: object[], extra: Partial<Tree> = {}): Tree {
  return { trials: trialsJson(trials), truth: {}, knownFailures: JSON.stringify({ failures: [] }), workflow: null, rubric: RUBRIC, ...extra };
}

describe("the assertion ledger", () => {
  const base = tree([{ id: "a", falseInstructionFindings: 2, recorded }, { id: "b", falseInstructionFindings: 0, recorded, tracking: { R2: "x" } }]);

  test("counts leaves, an empty array or object as one", () => {
    assert.equal(leaves(recorded), 7);
    assert.equal(leaves({ a: [], b: {}, c: [1, 2] }), 4);
  });

  test("totals what the trials, the known failures and the negative evals assert", () => {
    const l = ledgerOf({ ...base, truth: { a: JSON.stringify({ rows: [1, 2, 3] }) }, knownFailures: JSON.stringify({ failures: [{}, {}] }), workflow: "    env:\n      NEGATIVE_CASES: >-\n        a/x,a/y,\n        b/z\n    steps:\n" });
    assert.deepEqual({ ...l, trials: undefined }, { trials: undefined, assertedFields: 14, truthFields: 3, ceilingTotal: 2, tracking: 1, scans: 0, knownFailures: 2, negativeCases: 3 });
  });

  test("the same tree moves nowhere, and a new trial is more, not less", () => {
    assert.deepEqual(lessMoves(ledgerOf(base), ledgerOf(base)), []);
    const more = tree([...JSON.parse(base.trials!).trials, { id: "c", falseInstructionFindings: 40, tier: "read-only", tracking: { R1: "y" }, recorded }]);
    assert.deepEqual(lessMoves(ledgerOf(base), ledgerOf(more)), []);
  });

  test("names each move toward asserting less", () => {
    const { headline: _, ...noHeadline } = recorded.any;
    const head = tree([
      { id: "a", falseInstructionFindings: 3, recorded: { any: noHeadline }, tier: "read-only", budgetComponentMinutes: 10 },
      { id: "b", falseInstructionFindings: 0, recorded, tracking: { R2: "x", R3: "y" } },
    ], { knownFailures: JSON.stringify({ failures: [{}] }) });
    const moves = lessMoves(ledgerOf(base), ledgerOf(head));
    assert.deepEqual(moves, [
      "a asserts 6 recorded fields, down from 7",
      "a's false-finding ceiling rises from 2 to 3",
      "a turns from an executed trial into a read-only scan",
      "a's componentMinutes budget falls from 15 to 10",
      "b moves R3 to tracking",
      "known failures rise from 0 to 1",
    ]);
    assert.deepEqual(lessMoves(ledgerOf(base), ledgerOf(tree([{ id: "a", falseInstructionFindings: 2, recorded }]))), ["trial b is removed"]);
  });

  test("a lower default budget in the latest rubric lowers every trial's", () => {
    const lower = { ...base, rubric: JSON.stringify({ budgets: { commandTimeoutSec: 600, componentMinutes: 15, totalMinutes: 45 } }) };
    assert.deepEqual(lessMoves(ledgerOf(base), ledgerOf(lower)), ["a's totalMinutes budget falls from 60 to 45", "b's totalMinutes budget falls from 60 to 45"]);
    const raised = tree([{ id: "a", falseInstructionFindings: 2, recorded, budgetComponentMinutes: 30 }, { id: "b", falseInstructionFindings: 0, recorded, tracking: { R2: "x" } }]);
    assert.deepEqual(lessMoves(ledgerOf(base), ledgerOf(raised)), [], "a longer budget asserts more");
    assert.deepEqual(lessMoves(ledgerOf(raised), ledgerOf(base)), ["a's componentMinutes budget falls from 30 to 15"]);
  });

  test("fails a move toward asserting less unless the description says why", () => {
    const head = tree([{ id: "a", falseInstructionFindings: 5, recorded }, { id: "b", falseInstructionFindings: 0, recorded, tracking: { R2: "x" } }]);
    assert.equal(ledgerProblems(ledgerOf(base), ledgerOf(head), "Re-records a.").length, 2);
    assert.equal(ledgerProblems(ledgerOf(base), ledgerOf(head), "Asserting less: ").length, 2, "the line needs a reason");
    assert.deepEqual(ledgerProblems(ledgerOf(base), ledgerOf(head), "Re-records a.\nAsserting less: a's README gained three user-facing install lines"), []);
  });

  test("reads CI's real negative-eval list", () => {
    assert.ok(negativeCases(readFileSync(join(WORKFLOWS, "agent-readiness.yml"), "utf8")).length >= 20);
  });
});
