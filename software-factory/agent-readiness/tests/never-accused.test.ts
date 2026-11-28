import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { accusations } from "../support/evals/lib/expected.ts";
import { makeAudit, reportFor } from "./helpers.ts";

describe("expected.json's neverAccused", () => {
  test("names a condition not met and a blocking finding, and nothing for a healthy audit", () => {
    const healthy = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] });
    assert.deepEqual(accusations(reportFor(healthy), healthy), []);
    const failing = makeAudit({ components: [{ id: "app", share: 1, test: "fail", faults: "not_run" }], safety: [{ id: "saf-001", kind: "secret", file: "src/config.ts", line: 3, detail: "AWS access key", blocking: true }] });
    const found = accusations(reportFor(failing), failing);
    assert.ok(found.some((a) => a.startsWith("app clean.test not met")), JSON.stringify(found));
    assert.ok(found.includes("blocking src/config.ts: AWS access key"), JSON.stringify(found));
  });
});
