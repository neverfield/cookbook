import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderHtml } from "../skill/agent-readiness/scripts/lib/render-html.ts";
import { renderMarkdown } from "../skill/agent-readiness/scripts/lib/render.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import type { AuditFiles } from "../support/holdout/observe.ts";
import { factConflicts } from "../support/holdout/observe.ts";
import { makeAudit, reportFor } from "./helpers.ts";

// The holdout's K6 check reads a blocked command's word only where the report speaks of that
// command: the explanations about its own component. Another package running the same command line
// and failing on its own isn't a conflict.
function twoPackages(): AuditFiles {
  const audit = makeAudit({ components: [{ id: "web", share: 0.5, test: "pass", lint: "fail" }, { id: "api", share: 0.5, test: "pass", lint: "fail" }] });
  audit.evidence.find((e) => e.kind === "lint" && e.component === "web")!.blocked = "eslint is not installed in the audit's image (node:22)";
  const report = reportFor(audit);
  const rubric = loadRubric(audit.rubric);
  return { report: report as never, audit: audit as never, markdown: renderMarkdown(report, rubric), html: renderHtml(report) };
}

describe("K6: a blocked command's word, by contract and component", () => {
  test("one package's blocked lint beside another's real lint failure is no conflict", () => {
    const f = twoPackages();
    assert.match(f.markdown, /`npm run lint` \(fail\)/, "api's own failure is in the report");
    assert.deepEqual(factConflicts(f).filter((c) => c.includes("blocked in the evidence")), []);
  });

  test("the blocked package's own explanation saying fail is still a conflict", () => {
    const f = twoPackages();
    const lines = f.markdown.split("\n").map((l) => (l.startsWith("| web") ? l.replace("`npm run lint` (blocked)", "`npm run lint` (fail)") : l));
    const forged = { ...f, markdown: lines.join("\n") };
    assert.notEqual(forged.markdown, f.markdown, "the fixture has a row to forge");
    assert.deepEqual(factConflicts(forged).filter((c) => c.includes("blocked in the evidence")), ['cmd-web-lint: blocked in the evidence, "fail" in report.md']);
  });
});
