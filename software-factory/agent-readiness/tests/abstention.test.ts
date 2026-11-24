import assert from "node:assert/strict";
import { describe } from "node:test";
import type { ReportJson } from "../skill/agent-readiness/scripts/lib/types.ts";
import { auditFiles } from "../support/holdout/observe.ts";
import { guards } from "../support/tools/known-failures.ts";
import { materialize, readiness } from "../support/tools/fixture.ts";
import { makeAudit, reportFor } from "./helpers.ts";

// When the audit doesn't know something, it says so rather than answering against the repo. Level 0
// ("not bootable") needs a Level 1 check that failed and that the repo is to blame for; a test entry
// point the scan missed, or a failure in an install the audit chose, is undetermined instead.
const guard = guards(import.meta.url);
const NOW = "2026-11-24T12:00:00Z";

type Comp = ReportJson["components"]["included"][number] & { status?: string };
const levelZero = (c: Comp) => c.level === 0 && !c.unproven && c.status !== "undetermined";

describe("abstention: undetermined, not Level 0", () => {
  for (const name of ["make-test-unit", "tox-test-dir"]) {
    guard(`${name}: tests a task runner runs are never "no tests" or Level 0`, () => {
      const repo = materialize(name, { now: NOW });
      const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none"], { SA_READINESS_EVAL_SEED: "fixture-seed", SA_READINESS_NOW: NOW });
      assert.equal(r.code, 0, r.out);
      const report = auditFiles(repo).report as ReportJson;
      assert.deepEqual(report.components.included.filter(levelZero).map((c) => c.id), [], `heading: ${report.executive.heading}`);
      assert.doesNotMatch(report.executive.heading, /not bootable/i);
      assert.doesNotMatch(JSON.stringify(report.maturity.capReasons), /no test command|has no tests/i);
    });
  }

  guard("tests that fail because the audit's install left out the test runner are undetermined, not Level 0", () => {
    const audit = makeAudit({ components: [{ id: "pricing", share: 1, test: "fail", reason: "python -m pytest failed: /usr/local/bin/python: No module named pytest" }] });
    const c = reportFor(audit).components.included[0] as Comp;
    assert.ok(!levelZero(c), `pricing is Level 0 on a failure the audit's own install caused`);
  });

  guard("with nothing run, no component is Level 0", () => {
    const audit = makeAudit({ components: [{ id: "web", share: 1, test: "missing" }] });
    audit.environment.containerRuntime = null;
    audit.evidence = audit.evidence.map((e) => ({ ...e, result: "not_run", blocked: "no container runtime on this machine" }));
    const report = reportFor(audit);
    assert.deepEqual(report.components.included.filter((c) => levelZero(c as Comp)).map((c) => c.id), [], `heading: ${report.executive.heading}`);
  });
});
