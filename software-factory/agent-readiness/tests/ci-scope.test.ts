import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { isDocs, scopeOf } from "../support/tools/ci-scope.ts";
import { sideOf } from "../support/tools/instrument-freeze.ts";

const A = "software-factory/agent-readiness/";
const ci = readFileSync(join(import.meta.dirname, "..", "..", "..", ".github/workflows/agent-readiness.yml"), "utf8");

describe("the docs-only scope", () => {
  test("only the root README and CHANGELOG, docs/ and support/*.md are docs", () => {
    for (const p of ["README.md", "CHANGELOG.md", "docs/sample-report.png", "docs/a/b.md", "support/README.md", "support/AGENTS.md", "support/RELEASE.md"]) assert.ok(isDocs(A + p), p);
    for (const p of ["skill/agent-readiness/SKILL.md", "skill/agent-readiness/references/checks.md", "skill/agent-readiness/README.md", "support/evals/README.md", "support/trials/notes.md", "support/fixtures/x/repo/README.md", "examples/sample-report.md", "tests/README.md", "package.json", "AGENTS.md", "support/README.txt"]) assert.ok(!isDocs(A + p), p);
    for (const p of ["README.md", ".github/workflows/agent-readiness.yml", "voice-agents/README.md", "software-factory/README.md"]) assert.ok(!isDocs(p), `${p} is outside the accelerator`);
  });

  test("one path off the list, or none at all, means the full run", () => {
    assert.equal(scopeOf([A + "README.md", A + "docs/x.md"]).scope, "docs-only");
    assert.equal(scopeOf([A + "README.md", A + "skill/agent-readiness/SKILL.md"]).scope, "full");
    assert.equal(scopeOf([A + "README.md", ".github/workflows/agent-readiness.yml"]).scope, "full");
    assert.equal(scopeOf([]).scope, "full");
  });

  test("the list is instrument, so a scripts PR can't widen it", () => {
    assert.equal(sideOf("support/tools/ci-scope.ts"), "instrument");
  });

  test("CI computes it from the base's copy and skips only the trials and negative evals, failing closed", () => {
    assert.match(ci, /git show "origin\/\$\{\{ github\.base_ref \}\}:software-factory\/agent-readiness\/support\/tools\/ci-scope\.ts"/);
    assert.match(ci, /if \[ "\$\{\{ github\.event_name \}\}" != "pull_request" \]; then[\s\S]*?scope=full/);
    const jobs = ci.split(/\n  (?=[a-z-]+:\n)/).slice(1);
    const named = (n: string) => jobs.find((j) => j.startsWith(`${n}:`)) ?? "";
    const gate = "    needs: scope\n    if: ${{ !cancelled() && needs.scope.outputs.scope != 'docs-only' }}\n";
    for (const n of ["trials", "negative-evals"]) assert.ok(named(n).includes(gate), `${n} runs unless the scope is exactly docs-only`);
    for (const j of jobs.filter((j) => !/^(scope|trials|negative-evals):/.test(j))) assert.doesNotMatch(j, /needs\.scope/, `only the trials and negative evals skip: ${j.split("\n")[0]}`);
  });
});
