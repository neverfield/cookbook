import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadCases, planJobs, select } from "../support/evals/lib/plan.ts";
import type { Arm } from "../support/evals/lib/types.ts";

const EXAMPLES = join(import.meta.dirname, "..", "support/examples/github-workflows");
const workflow = readFileSync(join(EXAMPLES, "skill-evals.yml"), "utf8");
const ci = readFileSync(join(import.meta.dirname, "..", "..", "..", ".github/workflows/agent-readiness.yml"), "utf8");

function flag(line: string, name: string): number {
  const m = line.match(new RegExp(`--${name} (\\d+)`));
  assert.ok(m, `the skill-evals step has no --${name}`);
  return Number(m[1]);
}

describe("the example GitHub workflow", () => {
  test("the skill-evals step's --max-runs covers the full suite with every arm it can be given", async () => {
    const line = workflow.split("\n").find((l) => l.includes("npm run evals -- --tag ${{ steps.set.outputs.tag }}"));
    assert.ok(line, "no skill-evals step");
    const repeats = flag(line, "repeats");
    const cap = flag(line, "max-runs");
    const all = await loadCases();
    for (const tag of ["smoke", "full"]) {
      for (const arms of [["agent"], ["agent", "scripted"], ["agent", "scripted", "skill-off"]] as Arm[][]) {
        const runs = planJobs(select(all, { tag }), arms, ["model"], repeats).length;
        assert.ok(runs <= cap, `--tag ${tag} --arm ${arms.join(",")} plans ${runs} runs at ${repeats} repeats, over --max-runs ${cap}`);
      }
    }
  });
});

describe("the example workflows that run a pinned accelerator", () => {
  for (const name of ["static-checks.yml", "scheduled-recheck.yml"]) {
    const text = readFileSync(join(EXAMPLES, name), "utf8");
    test(`${name} ships no pin and stops until one is set`, () => {
      // No release tag exists, so any shipped ref would point at nothing.
      assert.match(text, /^  SA_ACCELERATOR_REF: ""$/m);
      assert.match(text, /if \[ -z "\$SA_ACCELERATOR_REF" \]; then[\s\S]*?exit 1/);
      assert.ok(text.indexOf("Check the pin") < text.indexOf("Check out the pinned accelerator"), "the pin is checked before the checkout");
    });
  }

  test("scheduled-recheck.yml has nothing to do, rather than failing, before the first history push", () => {
    const text = readFileSync(join(EXAMPLES, "scheduled-recheck.yml"), "utf8");
    assert.match(text, /if git fetch origin agent-readiness\/history:agent-readiness\/history; then\s+echo "found=true"[\s\S]*?else[\s\S]*?echo "found=false"/);
    const steps = text.split(/\n      - /).slice(1);
    const after = steps.slice(steps.findIndex((s) => s.includes("id: history")) + 1).filter((s) => !s.startsWith("name: Check the pin"));
    assert.ok(after.length >= 4);
    for (const s of after) assert.match(s, /steps\.history\.outputs\.found == 'true'/, `step runs without history: ${s.split("\n")[0]}`);
  });
});

describe("CI's scripted negative evals", () => {
  const listed = ci.match(/NEGATIVE_CASES: >-\n([\s\S]*?)\n    steps:/)![1].replace(/\s/g, "").split(",");
  // Each needs a package registry: Debian or PyPI.
  const LEFT_OUT = ["remediation/compose-env-honest", "remediation/draft-env-service-honest", "scenarios/scenario-repo-wide-honest"];

  test("cover every negative case but the documented ones, and all need no API key", async () => {
    const negative = select(await loadCases(), { tag: "negative" });
    for (const id of listed) {
      const c = negative.find((x) => x.id === id);
      assert.ok(c, `${id} isn't a negative case`);
      assert.ok(c.attack, `${id} is agent-driven and needs an API key`);
    }
    assert.deepEqual(negative.map((c) => c.id).filter((id) => !listed.includes(id)).sort(), [...LEFT_OUT].sort());
    for (const id of LEFT_OUT) assert.match(ci, new RegExp(id.replace("/", "\\/")), `${id} left out without a reason in the workflow`);
  });
});
