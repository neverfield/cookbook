import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { addEvidence, currentEvidence, evidenceKey } from "../skill/agent-readiness/scripts/lib/evidence.ts";
import { evidenceLog } from "../skill/agent-readiness/scripts/lib/format.ts";
import { Progress, budgetSummary } from "../skill/agent-readiness/scripts/lib/progress.ts";
import { renderMarkdown } from "../skill/agent-readiness/scripts/lib/render.ts";
import type { Executor } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { newBudget } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { latestRubricVersion, loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import type { Audit, ReportJson } from "../skill/agent-readiness/scripts/lib/types.ts";
import { ACCELERATOR, materialize, readiness } from "../support/tools/fixture.ts";
import { makeAudit, reportFor } from "./helpers.ts";

const LIB = join(ACCELERATOR, "skill/agent-readiness/scripts/lib");
const rubric = loadRubric(latestRubricVersion());
const HOST = { SA_READINESS_ALLOW_HOST: "1" };

function rowOf(e: Audit["evidence"][number]) {
  const { id: _id, at: _at, supersededBy: _by, ...rest } = e;
  return rest;
}

// Value imports, as module paths; `import type` lines and type-only names are left out.
function valueImports(file: string): string[] {
  const text = readFileSync(join(LIB, file), "utf8");
  return [...text.matchAll(/^(?:import|export) (?!type\b)[^;]*?from "([^"]+)";/gm)].map((m) => m[1]);
}

function sealed(repo: string): { report: ReportJson; audit: Audit; md: string } {
  const report = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8")) as ReportJson;
  const audit = JSON.parse(readFileSync(join(repo, report.audit.storedAt, "audit.json"), "utf8")) as Audit;
  return { report, audit, md: readFileSync(join(repo, ".agent-readiness/latest/report.md"), "utf8") };
}

describe("one report model, pure renderers", () => {
  test("the renderers import only types and formatters, so neither can derive a fact of its own", () => {
    for (const file of ["render.ts", "render-html.ts"]) assert.deepEqual(valueImports(file).filter((m) => m !== "./format.ts"), [], `${file} imports values from outside format.ts`);
    assert.deepEqual(valueImports("format.ts").filter((m) => !["./util.ts", "./outcomes.ts", "./waivers.ts"].includes(m)), [], "format.ts reaches into the model");
  });

  test("every level carries its status, where it was proven and what would settle it", () => {
    const proven = reportFor(makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] }));
    assert.deepEqual([proven.maturity.status, proven.maturity.provenIn, proven.maturity.settleBy], ["proven", "container", null]);
    assert.deepEqual(proven.components.included.map((c) => [c.status, c.provenIn, c.settleBy]), [["proven", "container", null]]);

    const audit = makeAudit({ components: [{ id: "app", share: 1, where: "fresh_copy", faults: "pass" }] });
    audit.environment.containerRuntime = null;
    const unproven = reportFor(audit);
    assert.deepEqual([unproven.maturity.status, unproven.maturity.provenIn], ["unproven", null]);
    assert.equal(unproven.maturity.settleBy?.kind, "rerun");
    assert.match(unproven.maturity.settleBy!.text, /Docker or Podman/);
    assert.deepEqual(unproven.components.included.map((c) => [c.status, c.settleBy?.kind]), [["unproven", "rerun"]]);
    assert.match(unproven.executive.heading, /^Unproven on this machine: /, "an unproven result names no level, as the ladder marks none");

    const none = reportFor(makeAudit({ components: [{ id: "infra", share: 1, assessed: false }] }));
    assert.equal(none.maturity.status, "not_assessed");
  });

  test("a command this machine blocked reads as blocked in the explanations, never as failed", () => {
    const audit = makeAudit({ components: [{ id: "zap", share: 1, test: "pass", lint: "fail" }] });
    Object.assign(audit.evidence.find((e) => e.kind === "lint")!, { blocked: "golangci-lint isn't installed on this machine" });
    const text = JSON.stringify(reportFor(audit).explanations);
    assert.doesNotMatch(text, /`npm run lint` \(fail\)/);
    assert.match(text, /`npm run lint` \(blocked\)/);
  });

  test("skipped instruction items have their own count, apart from the ones not run", () => {
    const audit = makeAudit({
      components: [{ id: "app", share: 1, faults: "pass" }],
      instructions: [
        { id: "ins-1", source: "AGENTS.md", line: 3, kind: "command", text: "npm test", category: "replay", staticResult: "pass", result: "pass" },
        { id: "ins-2", source: "AGENTS.md", line: 4, kind: "command", text: "npx skills add x", category: "skipped", staticResult: "pass", result: "not_run", reason: "adds a package" },
        { id: "ins-3", source: "AGENTS.md", line: 5, kind: "command", text: "make deploy", category: "risky", staticResult: "pass", result: "not_run", reason: "risky" },
      ],
    });
    const r = reportFor(audit);
    const check = r.details.checks.find((c) => c.id === "context.instructions_verified")!;
    assert.equal(check.result, "1 of 3 instruction items check out, 1 not run, 1 skipped");
    assert.deepEqual(check.counts, { passed: 1, failed: 0, notRun: 1, skipped: 1 });
    assert.doesNotMatch(renderMarkdown(r, rubric), /\b2 not run\b/);
  });
});

describe("current evidence", () => {
  test("a new result for the same check, component and command supersedes the old one; a host run never supersedes a replay", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1 }] });
    const before = audit.evidence.length;
    const first = audit.evidence.find((e) => e.kind === "test")!;
    const again = addEvidence(audit, { ...rowOf(first), result: "fail", summary: "test failed" });
    assert.equal(first.supersededBy, again.id);
    const host = addEvidence(audit, { ...rowOf(first), where: "host", strength: "executed", summary: "test passed on the host" });
    assert.equal(again.supersededBy, undefined, "a diagnostic host run is a separate result");
    assert.equal(host.supersededBy, undefined);
    assert.equal(currentEvidence(audit).length, before + 1);
    assert.equal(evidenceKey({ checkId: "scope.profile", where: "static" }), null, "a recorded observation is a result of its own");
  });

  test("the log folds superseded rows under the current one", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] });
    const first = audit.evidence.find((e) => e.kind === "test")!;
    addEvidence(audit, { ...rowOf(first), summary: "test passed again" });
    const r = reportFor(audit);
    const log = evidenceLog(r);
    const at = log.findIndex((x) => x.row.id === first.id);
    assert.equal(log[at].current, false);
    assert.equal(log[at - 1].row.id, first.supersededBy, "the old row sits right under its replacement");
    assert.match(renderMarkdown(r, rubric), new RegExp(`\\| \`${first.id}\` \\|[^\\n]*superseded by \`${first.supersededBy}\``));
  });

  test("a second replay with a changed PATH replaces the first: nothing stale reaches the report, and the levels are a single replay's", () => {
    const fake = mkdtempSync(join(tmpdir(), "no-npm-"));
    writeFileSync(join(fake, "npm"), "#!/bin/sh\necho \"bash: npm: command not found\" >&2\nexit 127\n");
    chmodSync(join(fake, "npm"), 0o755);
    const twice = materialize("healthy-node");
    for (const args of [["init", "--tier", "local-exec"], ["scan"]]) assert.equal(readiness(twice, args).code, 0);
    const first = readiness(twice, ["replay", "--runtime", "none", "--no-mutants"], { ...HOST, PATH: `${fake}:${process.env.PATH}` });
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /npm is not installed|blocked/);
    for (const args of [["replay", "--runtime", "none", "--no-mutants"], ["seal"]]) {
      const r = readiness(twice, args, HOST);
      assert.equal(r.code, 0, r.out);
    }
    const once = materialize("healthy-node");
    assert.equal(readiness(once, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"], HOST).code, 0);
    const a = sealed(twice);
    const b = sealed(once);
    assert.deepEqual(a.report.components.included.map((c) => [c.id, c.level, c.status]), b.report.components.included.map((c) => [c.id, c.level, c.status]));
    assert.deepEqual(a.report.maturity.capReasons, b.report.maturity.capReasons);
    assert.deepEqual(a.report.details.checks.map((c) => [c.id, c.counts]), b.report.details.checks.map((c) => [c.id, c.counts]));
    const stale = a.audit.evidence.filter((e) => /npm is not installed/.test(`${e.summary} ${e.blocked ?? ""}`));
    assert.ok(stale.length > 0, "the first replay recorded the missing npm");
    assert.ok(stale.every((e) => e.supersededBy), "every row from the first replay is superseded");
    const shown = JSON.stringify({ ex: a.report.executive, maturity: a.report.maturity, components: a.report.components, explanations: a.report.explanations, checks: a.report.details.checks });
    assert.doesNotMatch(shown, /npm is not installed/);
    assert.match(a.md, /superseded by `ev-\d+`/);
  });
});

describe("visible runs", () => {
  test("a slow command prints a line at least every interval, then how long it took", async () => {
    const lines: string[] = [];
    const ex = { where: "fresh_copy", strength: "executed", image: null, imageSource: null, root: "/", offline: () => false, networkOff: null, close: () => {}, exec: () => new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0, timedOut: false, durationMs: 700, output: "" }), 700)) } as unknown as Executor;
    const progress = new Progress((s) => lines.push(s), 150);
    progress.watch(ex);
    await ex.exec("npm test", "packages/web", 60);
    const beats = lines.filter((l) => l.includes("still running `npm test` in packages/web"));
    assert.ok(beats.length >= 3, lines.join("\n"));
    assert.match(lines.at(-1)!, /`npm test` in packages\/web took /);
    assert.equal(progress.times.length, 1);
  });

  test("the budget summary names the largest consumer and the flag that gives it more", () => {
    const b = newBudget(15, 60);
    b.used.set("web", 9 * 60000);
    b.used.set("api", 40000);
    b.used.set("*", 5000);
    const fine = budgetSummary(b, 15, { components: [], total: false });
    assert.match(fine[0], /^Time by component: web 9 min 0 s, api 40 s, the repo-wide steps 5 s\.$/);
    assert.match(fine[1], /^web used the most \(9 min 0 s of its 15-minute budget\); if its checks are cut off, rerun with --budget-component 30\.$/);
    assert.match(budgetSummary(b, 15, { components: ["web"], total: false })[1], /^web ran out of its time budget\. Rerun with --budget-component 30/);
    assert.match(budgetSummary(b, 15, { components: [], total: true })[1], /--budget-total 120/);
    assert.deepEqual(budgetSummary(newBudget(15, 60), 15, { components: [], total: false }), []);
  });

  test("an audit of a slow test suite prints progress while it runs and names where the time went", () => {
    const repo = materialize("healthy-node");
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    pkg.scripts.test = `node -e "setTimeout(() => {}, 3500)" && ${pkg.scripts.test}`;
    writeFileSync(join(repo, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    execFileSync("git", ["-c", "user.name=Contributor A", "-c", "user.email=a@example.com", "commit", "-qam", "slow tests"], { cwd: repo });
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"], { ...HOST, SA_READINESS_PROGRESS_SEC: "1" });
    assert.equal(r.code, 0, r.out);
    const beats = r.out.split("\n").filter((l) => /still running `npm (run )?test`/.test(l));
    assert.ok(beats.length >= 2, r.out);
    assert.match(r.out, /\btest\s+\S+\s+(pass|fail|blocked) in \d+ s/);
    assert.match(r.out, /^Time by component: /m);
    assert.match(r.out, /--budget-component \d+/);
    const dir = join(repo, ".agent-readiness/history/audits");
    const audit = JSON.parse(readFileSync(join(dir, readdirSync(dir).sort().pop()!, "audit.json"), "utf8")) as Audit;
    const test = audit.evidence.find((e) => e.kind === "test")!;
    assert.ok((test.durationMs ?? 0) >= 3000, `the test row records how long it took: ${test.durationMs}`);
  });
});
