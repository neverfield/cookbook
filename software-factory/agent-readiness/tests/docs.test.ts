import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LANGUAGES } from "../skill/agent-readiness/scripts/lib/languages/index.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";

const SKILL = join(import.meta.dirname, "..", "skill/agent-readiness");
const read = (rel: string) => readFileSync(join(SKILL, rel), "utf8");
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

describe("the skill's docs agree with the code", () => {
  test("SKILL.md's examples of stacks with no level are the recognized-only stacks, and name no supported one", () => {
    const example = read("SKILL.md").match(/outside the supported tier \(for example ([^)]*)\)/)?.[1];
    assert.ok(example, "SKILL.md has no examples of stacks outside the supported tier");
    const stacks = LANGUAGES.flatMap((l) => l.stacks);
    for (const s of stacks.filter((x) => x.tier === "not_assessed")) assert.ok(example.includes(s.label), `${s.label} is recognized only, but SKILL.md doesn't name it`);
    for (const s of stacks.filter((x) => x.tier === "supported" && !/\s/.test(x.label))) {
      const named = new RegExp(`(^|[\\s,])${s.label.replace(".", "\\.")}([\\s,]|$)`);
      assert.ok(!named.test(example), `SKILL.md says ${s.label} gets no level, but it's supported`);
    }
  });

  test("supported.md samples as many components as the current rubric assesses", () => {
    const rubric = loadRubric();
    const max = rubric.components.maxAssessed;
    const line = read("references/supported.md").split("\n").find((l) => l.includes("is sampled"));
    assert.ok(line, "supported.md doesn't say how a repo is sampled");
    assert.match(line, new RegExp(`more than ${WORDS[max]} supported components is sampled: the ${WORDS[max]} with the largest share`));
  });

  test("checks.md and levels.md use examples that are still true", () => {
    const checks = read("references/checks.md");
    assert.doesNotMatch(checks, /A Python, PHP or Ruby app next to a root `package.json` is its own component, not assessed/);
    const levels = read("references/levels.md");
    const example = levels.match(/Components the audit can't assess, such as ([^,]+), never set/)?.[1];
    assert.ok(example, "levels.md has no example of a component the audit can't assess");
    const supported = LANGUAGES.flatMap((l) => l.stacks).filter((s) => s.tier === "supported").map((s) => s.label);
    for (const label of supported.filter((l) => !/\s/.test(l))) assert.ok(!example.includes(label), `levels.md says ${label} can't be assessed`);
  });
});
