import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, test } from "node:test";
import { freezeProblems, sideOf } from "../support/tools/instrument-freeze.ts";
import { ACCELERATOR, SKILL } from "../support/tools/fixture.ts";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (n === "node_modules" ? [] : statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
}

describe("the instrument freeze", () => {
  test("the scripts side is the eval binding's scripts digest: the skill but its rubrics and RELEASE.json", () => {
    for (const f of walk(SKILL).map((p) => relative(ACCELERATOR, p).split(sep).join("/"))) {
      const want = f.startsWith("skill/agent-readiness/rubric/") || f === "skill/agent-readiness/RELEASE.json" ? "other" : "scripts";
      assert.equal(sideOf(f), want, f);
    }
  });

  test("graders are instrument, fixture inputs and the collision log are not", () => {
    for (const f of ["support/evals/lib/grade.ts", "support/evals/cases/negative.ts", "support/evals/run.ts", "support/tools/fixture.ts", "support/fixtures/healthy-node/expected.json", "support/fixtures/make-test-unit/truth.json", "support/holdout/score.ts", "support/holdout/observe.ts", "support/trials/truth/zap.json", "support/trials/trials.test.ts"]) assert.equal(sideOf(f), "instrument", f);
    for (const f of ["support/fixtures/make-test-unit/repo/Makefile", "support/fixtures/make-test-unit/history.json", "support/holdout/collision-log.json", "support/holdout/records/commitment.json", "support/trials/trials.json", "tests/levels.test.ts", "README.md", "skill/agent-readiness/rubric/2026-11-beta.json"]) assert.notEqual(sideOf(f), "instrument", f);
  });

  test("fails a change to both unless the description names the exception", () => {
    const both = ["skill/agent-readiness/scripts/lib/profile.ts", "support/fixtures/healthy-node/expected.json"];
    assert.equal(freezeProblems(both, "Fixes discovery.").length, 2);
    assert.deepEqual(freezeProblems(both, "Fixes discovery.\n\nInstrument-freeze exception: the expected level moves because the root app is now found"), []);
    assert.equal(freezeProblems(both, "Instrument-freeze exception: ").length, 2, "an exception needs a reason");
    assert.deepEqual(freezeProblems(["skill/agent-readiness/scripts/lib/profile.ts", "support/fixtures/new-shape/repo/package.json", "tests/discovery.test.ts"], ""), [], "a fix may land with new fixture inputs and tests");
    assert.deepEqual(freezeProblems(["support/holdout/observe.ts", "support/evals/lib/grade.ts"], ""), []);
  });

  test("CI runs it on every pull request, rerunning when the description changes", () => {
    const wf = readFileSync(join(ACCELERATOR, "..", "..", ".github", "workflows", "agent-readiness-freeze.yml"), "utf8");
    assert.match(wf, /types: \[opened, synchronize, reopened, edited\]/);
    assert.match(wf, /SA_PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
    assert.match(wf, /instrument-freeze\.ts --base "origin\/\$\{\{ github\.base_ref \}\}"/);
    assert.match(wf, /fetch-depth: 0/);
  });
});
