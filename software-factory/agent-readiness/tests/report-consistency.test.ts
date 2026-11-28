import assert from "node:assert/strict";
import { before, describe } from "node:test";
import { renderHtml } from "../skill/agent-readiness/scripts/lib/render-html.ts";
import { renderMarkdown } from "../skill/agent-readiness/scripts/lib/render.ts";
import { latestRubricVersion, loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { auditFiles, factConflicts } from "../support/holdout/observe.ts";
import type { AuditFiles } from "../support/holdout/observe.ts";
import { guards } from "../support/tools/known-failures.ts";
import { fixtureNames, materialize, readiness } from "../support/tools/fixture.ts";
import { makeAudit, reportFor } from "./helpers.ts";

// One fact, one value: each state, count and level reads the same in report.json, report.md and
// report.html. The checker is the holdout adapter's (K6), run over every conformance fixture audited
// as on a machine with no container runtime, and over audits built for the cases that need a run.
const guard = guards(import.meta.url);
const NOW = "2026-11-24T12:00:00Z";

function conflictsOf(files: AuditFiles[], match: RegExp): string[] {
  return files.flatMap((f) => factConflicts(f).filter((c) => match.test(c)).map((c) => `${f.report?.repo ?? "?"}: ${c}`));
}

describe("one fact, one value across report.json, report.md and report.html", () => {
  let audited: AuditFiles[] = [];
  before(() => {
    audited = fixtureNames().map((name) => {
      const repo = materialize(name, { now: NOW });
      readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none"], { SA_READINESS_EVAL_SEED: "fixture-seed", SA_READINESS_NOW: NOW });
      return auditFiles(repo);
    });
  });

  guard("every fixture seals without a container runtime, so each is checked", () => {
    assert.deepEqual(audited.filter((f) => f.audit?.state !== "sealed").map((f) => f.report?.repo ?? "unsealed"), []);
  });

  guard("the level the heading names is the level both ladders mark", () => {
    assert.deepEqual(conflictsOf(audited, /^level:/), []);
  });

  guard("the heading's count of blocked checks is the count the components hold", () => {
    assert.deepEqual(conflictsOf(audited, /^blocked checks:/), []);
  });

  guard("an instruction listed as skipped isn't also counted as not run", () => {
    assert.deepEqual(conflictsOf(audited, /^instructions:/), []);
  });

  guard("a command a limit of this machine blocked never reads as failed", () => {
    const audit = makeAudit({ components: [{ id: "zap", share: 1, test: "pass", lint: "fail", where: "host" }] });
    const lint = audit.evidence.find((e) => e.kind === "lint")!;
    lint.blocked = "golangci-lint isn't installed on this machine";
    lint.summary = "make lint couldn't run: golangci-lint isn't installed";
    const report = reportFor(audit);
    const rubric = loadRubric(latestRubricVersion());
    const files: AuditFiles = { report: report as never, audit: audit as never, markdown: renderMarkdown(report, rubric), html: renderHtml(report) };
    assert.deepEqual(factConflicts(files).filter((c) => c.includes("blocked in the evidence")), []);
  });

  // sentry-javascript: browser-integration-tests was blocked and bundler-plugin-integration-tests
  // failed, both `corepack pnpm run test` in their own folders, and both read as that one command.
  guard("the same command line in two folders, one blocked and one failing, reads with its folder and its own result", () => {
    const repo = materialize("same-command-two-folders", { now: NOW });
    const r = readiness(repo, ["audit", "--tier", "local-exec"], { SA_READINESS_EVAL_SEED: "fixture-seed", SA_READINESS_NOW: NOW, SA_READINESS_RUNTIME: "none", SA_READINESS_ALLOW_HOST: "1" });
    assert.equal(r.code, 0, r.out.slice(-3000));
    const files = auditFiles(repo);
    const tests = (files.audit!.evidence as { kind?: string; cwd?: string; command?: string; result: string; blocked?: string; supersededBy?: string }[]).filter((e) => e.kind === "test" && !e.supersededBy);
    assert.deepEqual(tests.map((e) => [e.cwd, e.command, e.result, Boolean(e.blocked)]).sort(), [["apps/checkout", "npm run test", "fail", true], ["apps/pricing", "npm run test", "fail", false]]);
    assert.deepEqual(factConflicts(files), []);
    assert.match(files.markdown, /`npm run test` in `apps\/checkout` \(blocked\)/);
    assert.match(files.markdown, /`npm run test` in `apps\/pricing` \(fail\)/);
  });
});
