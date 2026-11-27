import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LANGUAGES } from "../skill/agent-readiness/scripts/lib/languages/index.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { guards } from "../support/tools/known-failures.ts";
import { PINNED_WORKFLOWS, quickstartMismatch, workflowMismatch } from "../support/tools/release-manifest.ts";

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

const guard = guards(import.meta.url);

describe("the README Quickstart agrees with the release", () => {
  guard("the Quickstart clones the release RELEASE.json names, and never says no tag exists", () => {
    const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
    const release = JSON.parse(read("RELEASE.json")) as { tag: string };
    const clone = readme.split("\n").find((l) => /^git clone .*cursor\/cookbook/.test(l)) ?? "";
    assert.ok(clone.includes(`--branch ${release.tag}`) || /\b[0-9a-f]{40}\b/.test(clone), `the Quickstart clones an unpinned ref: ${clone}`);
    assert.doesNotMatch(readme, /No release tag exists yet/, `README says no release tag exists, but RELEASE.json names ${release.tag}`);
  });

  test("the release manifest script refuses a Quickstart that clones another ref or says no tag exists", () => {
    const tag = "agent-readiness-v0.2.0";
    assert.match(quickstartMismatch("git clone --depth 1 https://github.com/cursor/cookbook /tmp/cookbook\n", tag) ?? "", /not --branch agent-readiness-v0\.2\.0/);
    assert.match(quickstartMismatch(`git clone --depth 1 --branch ${tag} https://github.com/cursor/cookbook /tmp/cookbook\nNo release tag exists yet.`, tag) ?? "", /says no release tag exists/);
    const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
    assert.equal(quickstartMismatch(readme, (JSON.parse(read("RELEASE.json")) as { tag: string }).tag), null);
  });

  test("the example workflows name the release RELEASE.json names, and the manifest script refuses one that doesn't", () => {
    const tag = (JSON.parse(read("RELEASE.json")) as { tag: string }).tag;
    for (const name of PINNED_WORKFLOWS) {
      const text = readFileSync(join(import.meta.dirname, "..", "support", "examples", "github-workflows", name), "utf8");
      assert.equal(workflowMismatch(name, text, tag), null);
    }
    assert.match(workflowMismatch("static-checks.yml", `# ${tag}\n# No release tag exists yet, so pin that commit.\n`, tag) ?? "", /says no release tag exists/);
    assert.match(workflowMismatch("static-checks.yml", "# agent-readiness-v0.1.0\n", tag) ?? "", /doesn't name agent-readiness-v0\.2\.0/);
  });
});
