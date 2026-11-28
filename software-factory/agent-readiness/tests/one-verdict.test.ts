import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { replayInstructions } from "../skill/agent-readiness/scripts/lib/instructions.ts";
import type { Executor } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { newBudget } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { componentStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import { instructionItems } from "../skill/agent-readiness/scripts/lib/static.ts";
import { buildProfile } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { verdictOf } from "../skill/agent-readiness/scripts/lib/verdict.ts";
import type { Audit, Evidence } from "../skill/agent-readiness/scripts/lib/types.ts";
import { commitAll, materialize, readiness } from "../support/tools/fixture.ts";
import { instruction, makeAudit, reportFor } from "./helpers.ts";

const HOST = { SA_READINESS_ALLOW_HOST: "1" };

// A component whose type-check failed in a clean container, beside a lint the given row describes.
function lintAndTypecheck(lint: Partial<Evidence>): Audit {
  const audit = makeAudit({ components: [{ id: "app", share: 1, test: "pass", lint: "fail" }] });
  const row = audit.evidence.find((e) => e.kind === "lint")!;
  Object.assign(row, lint);
  audit.contract.push({ id: "cmd-app-typecheck", kind: "typecheck", component: "app", cwd: "app", command: "npx tsc --noEmit", source: "package.json scripts.typecheck", reason: "typecheck", timeoutSec: 600 });
  audit.evidence.push({ id: "ev-090", checkId: "verify.canonical_interface", condition: "commands", component: "app", kind: "typecheck", contractId: "cmd-app-typecheck", strength: "clean_replay", where: "container", result: "fail", command: "npx tsc --noEmit", summary: "typecheck failed: src/a.ts(1,7): error TS2322", diagnosis: { cause: "compile", detail: "src/a.ts(1,7): error TS2322" }, at: "2026-10-27T15:00:00.000Z" });
  return audit;
}

describe("one verdict word per row", () => {
  test("a blocked lint beside a failing type-check: only the type-check reads as failing", () => {
    const r = reportFor(lintAndTypecheck({ blocked: "eslint is not installed in the audit's image (node:22)" }));
    assert.match(r.executive.headline, /type-check command fails/);
    assert.doesNotMatch(r.executive.headline, /lint/, "a blocked lint isn't named as failing");
    const counts = r.details.checks.find((c) => c.id === "verify.canonical_interface")!.counts;
    assert.deepEqual([counts.failed, counts.blocked], [1, 1]);
    assert.ok(r.actions.every((a) => !/\blint\b/.test(a.title)), JSON.stringify(r.actions.map((a) => a.title)));
    assert.ok(r.actions.some((a) => /typecheck/.test(a.title)), JSON.stringify(r.actions.map((a) => a.title)));
    const lintRow = r.details.evidence.find((e) => e.ran === "npm run lint")!;
    assert.equal(lintRow.result, "blocked");
  });

  test("only a blocked lint: nothing counts as failed", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "pass", lint: "fail" }] });
    audit.evidence.find((e) => e.kind === "lint")!.blocked = "eslint is not installed in the audit's image (node:22)";
    const counts = reportFor(audit).details.checks.find((c) => c.id === "verify.canonical_interface")!.counts;
    assert.deepEqual([counts.failed, counts.blocked], [0, 1]);
  });

  test("an undetermined test failure reads as undetermined, never as fail", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "fail", diagnosis: { cause: "missing_library", detail: "libGL.so.1 is missing" } }] });
    const r = reportFor(audit);
    const row = r.details.evidence.find((e) => e.ran === "npm test")!;
    assert.equal(row.result, "undetermined");
    const counts = r.details.checks.find((c) => c.id === "bootstrap.cold_replay")!.counts;
    assert.deepEqual([counts.failed, counts.undetermined], [0, 1]);
    const explained = JSON.stringify(r.explanations);
    assert.match(explained, /`npm test` \(undetermined\)/);
    assert.doesNotMatch(explained, /`npm test` \(fail\)/);
  });

  test("a released rubric keeps its words: a failure is a failure", () => {
    const audit = makeAudit({ rubric: "2026-11-beta", components: [{ id: "app", share: 1, test: "fail", diagnosis: { cause: "missing_library", detail: "libGL.so.1 is missing" } }] });
    assert.equal(reportFor(audit).details.evidence.find((e) => e.ran === "npm test")!.result, "fail");
  });
});

describe("a place where a pass proves nothing can't prove a failure", () => {
  const rubric = loadRubric("2026-12-beta");

  test("a test that fails in host mode is blocked there, not the repo's", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "fail", where: "fresh_copy", diagnosis: { cause: "unknown", detail: "1 test failed" } }] });
    const s = componentStates(audit, rubric, "app");
    assert.equal(s["clean.test"].state, "blocked");
    assert.match(s["clean.test"].reason, /in host mode/);
    const r = reportFor(audit);
    assert.notEqual(r.maturity.outcome, "proven", "no proven Level 0 from host mode");
    assert.match(r.executive.heading, /^Unproven on this machine/);
  });

  test("on a disposable VM the rubric doesn't count, a failure is blocked too", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "fail", where: "disposable_vm", diagnosis: { cause: "unknown", detail: "1 test failed" } }] });
    assert.equal(componentStates(audit, rubric, "app")["clean.test"].state, "blocked");
  });

  test("an experiment in host mode still shows the repo's fault", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "fail", where: "fresh_copy" }] });
    audit.evidence.find((e) => e.kind === "test")!.attribution = { verdict: "repo", basis: "experiment", changed: "network", detail: "the tests failed again with the network on" };
    assert.equal(componentStates(audit, rubric, "app")["clean.test"].state, "not_met");
  });

  test("a lint that fails in host mode still counts, since a pass there counts for the commands check", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "pass", lint: "fail", where: "fresh_copy" }] });
    const lint = audit.evidence.find((e) => e.kind === "lint")!;
    assert.equal(verdictOf(lint, rubric), "repo_fault");
  });

  test("a released rubric keeps Level 0 for a host failure", () => {
    const audit = makeAudit({ rubric: "2026-11-beta", components: [{ id: "app", share: 1, test: "fail", where: "fresh_copy" }] });
    assert.equal(componentStates(audit, loadRubric("2026-11-beta"), "app")["clean.test"].state, "not_met");
  });

  test("end to end: a host-mode audit whose tests need a service reads as unproven, and its recheck isn't failed", () => {
    const repo = materialize("hidden-service");
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"], HOST);
    assert.equal(r.code, 0, r.out);
    const report = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    assert.equal(report.maturity.unproven, true, report.executive.heading);
    assert.match(report.executive.heading, /^Unproven on this machine/);
    const re = readiness(repo, ["recheck", "--runtime", "none"], HOST);
    assert.equal(re.code, 0, re.out);
    assert.match(re.out, /Recheck rck-\S+: blocked/);
    const dir = join(repo, ".agent-readiness/history/rechecks");
    const record = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    const testRow = record.results.find((x: { kind: string }) => x.kind === "test");
    assert.equal(testRow.status, "blocked", JSON.stringify(testRow));
    assert.ok(testRow.reason, "the record says why");
  });
});

describe("instructions are judged by the same gate", () => {
  test("an instruction that fails in the audit's image on a missing system library is unproven, not wrong", async () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "pass" }], instructions: [instruction("pass", "npm run e2e")] });
    const ex: Executor = {
      where: "container",
      strength: "clean_replay",
      image: "node:22-bookworm-slim",
      imageSource: "audit",
      root: mkdtempSync(join(tmpdir(), "ex-")),
      exec: async () => ({ exitCode: 127, output: "chrome: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory\n", timedOut: false, durationMs: 1 }),
      offline: () => false,
      networkOff: null,
      close: () => {},
    };
    await replayInstructions(audit, ex, ex.root, newBudget(30, 60), [], null);
    const item = audit.instructions[0];
    assert.equal(item.result, "not_run", JSON.stringify(item));
    assert.match(item.reason!, /^not proven: /);
    assert.notEqual(componentStates(audit, loadRubric(audit.rubric), "app").instructions.state, "not_met");
  });

  function makeTree(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "make-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    return dir;
  }

  const makeItem = (files: Record<string, string>) => {
    const dir = makeTree({ "AGENTS.md": "# Agents\n\nRun `make test` before you push.\n", ...files });
    const rubric = loadRubric("2026-12-beta");
    return instructionItems(dir, buildProfile(dir, dir, rubric)).find((i) => i.text === "make test")!;
  };

  test("GNUmakefile and a lowercase makefile are makefiles", () => {
    for (const name of ["GNUmakefile", "makefile"]) {
      const item = makeItem({ [name]: "test:\n\tnode --test\n" });
      assert.notEqual(item.staticResult, "fail", `${name}: ${item.staticReason}`);
    }
  });

  test("a target in an included file is found; one behind an include the audit can't read is left to the replay", () => {
    assert.notEqual(makeItem({ Makefile: "include mk/test.mk\n", "mk/test.mk": "test:\n\tnode --test\n" }).staticResult, "fail");
    assert.notEqual(makeItem({ Makefile: "include $(ROOT)/rules.mk\n" }).staticResult, "fail");
    const missing = makeItem({ Makefile: "build:\n\techo build\n" });
    assert.equal(missing.staticResult, "fail");
    assert.match(missing.staticReason!, /has no "test" target/);
  });

  test("readiness run --instructions on the host never marks an instruction wrong", () => {
    const repo = materialize("healthy-node");
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, "check-env": "exit 3" } }, null, 2));
    writeFileSync(join(repo, "AGENTS.md"), "# Agents\n\nRun `npm run check-env` before you push.\n");
    commitAll(repo, "An instruction that fails on this machine");
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"]).code, 0);
    assert.equal(readiness(repo, ["scan"]).code, 0);
    const run = readiness(repo, ["run", "--instructions", "--id", "none"], HOST);
    assert.match(run.out, /npm run check-env: not proven, failed on this machine/, run.out);
    const status = JSON.parse(readiness(repo, ["status", "--json"]).out);
    assert.deepEqual(status.instructionsWrong, []);
  });

  test("scan --strict fails only on instructions that gate", () => {
    const repo = materialize("healthy-node");
    writeFileSync(join(repo, "README.md"), "# healthy-node\n\n## Development\n\n```bash\nnpm run no-such-script\n```\n");
    commitAll(repo, "A wrong README line");
    assert.equal(readiness(repo, ["init", "--tier", "read-only"]).code, 0);
    const scan = readiness(repo, ["scan", "--strict"]);
    assert.match(scan.out, /0 wrong, 1 wrong outside the agent files, listed/, "the README line is still found wrong and listed");
    assert.equal(scan.code, 0, scan.out);
  });
});
