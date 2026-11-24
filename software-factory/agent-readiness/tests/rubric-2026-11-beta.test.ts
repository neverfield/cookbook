import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { faultsVerdict } from "../skill/agent-readiness/scripts/lib/mutate.ts";
import { latestRubricVersion, loadRubric, rubricDir } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { rateTable } from "../support/tools/kill-rate.ts";
import type { Tally } from "../support/tools/kill-rate.ts";
import { SUPPORT } from "../support/tools/fixture.ts";

const beta = loadRubric("2026-11-beta");
const alpha = loadRubric("2026-11-alpha");

describe("rubric 2026-11-beta", () => {
  test("was the rubric new audits used until 2026-12-beta, and lists what changed", () => {
    assert.notEqual(latestRubricVersion(), "2026-11-beta");
    assert.ok((beta.changes ?? []).length >= 3);
  });

  test("is written as JSON.stringify(rubric, null, 2), so a reformat never moves its digest", () => {
    const text = readFileSync(join(rubricDir(), "2026-11-beta.json"), "utf8");
    assert.equal(JSON.stringify(JSON.parse(text), null, 2) + "\n", text);
  });

  test("changes only the kill rate, the code seed, the component cap, the languages it can score and the fault wording", () => {
    const strip = (r: typeof beta) => {
      const c = structuredClone(r) as Partial<typeof beta> & Record<string, unknown>;
      delete c.version;
      delete c.changes;
      c.components = { ...r.components, maxAssessed: 0 };
      c.mutation = { ...r.mutation, killRate: undefined, seedFrom: undefined, languages: [], targeting: "" };
      c.templates = { ...r.templates, faults: { ...r.templates.faults, doneWhen: "", steps: [] } };
      return JSON.parse(JSON.stringify(c));
    };
    assert.deepEqual(strip(beta), strip(alpha));
    assert.deepEqual([beta.mutation.killRate, beta.mutation.seedFrom, beta.components.maxAssessed], [0.6, "code", 10]);
    assert.deepEqual([alpha.mutation.killRate, alpha.mutation.seedFrom, alpha.components.maxAssessed], [undefined, undefined, 6]);
    assert.deepEqual(beta.mutation.languages, [...alpha.mutation.languages, "go", "rust", "java", "kotlin", "csharp", "php", "ruby"]);
  });

  test("every component that can reach the active share is assessed", () => {
    assert.ok(beta.components.maxAssessed >= Math.ceil(1 / beta.repoLevel.activeShare));
  });

  test("the fault check passes at 3 of 5, where 2026-11-alpha needs all 5", () => {
    assert.equal(faultsVerdict(3, 5, beta.mutation), "pass");
    assert.equal(faultsVerdict(2, 5, beta.mutation), "fail");
    assert.equal(faultsVerdict(2, 2, beta.mutation), "not_run", "too few clear results decide nothing");
    assert.equal(faultsVerdict(4, 5, alpha.mutation), "fail");
  });

  test("on the calibration, the kill rate fails fewer reasonable suites than needing every fault, and flips no more verdicts between draws", () => {
    const cal = JSON.parse(readFileSync(join(SUPPORT, "evals", "calibration", "kill-rate.json"), "utf8")) as { rubric: string; perComponent: number; rows: Tally[] };
    assert.equal(cal.rubric, "2026-11-beta");
    assert.equal(cal.perComponent, beta.mutation.perComponent);
    const [rate, every] = rateTable(cal.rows, [beta.mutation.killRate!, 1], beta.mutation.minForPass);
    assert.ok(rate.pass > every.pass, `${rate.pass} vs ${every.pass} of ${rate.decided}`);
    assert.ok(rate.unstable.length <= every.unstable.length);
  });
});
