import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { HOOKS_FILE, guardDecision, installGuard, probeGuard, uninstallGuard } from "../skill/agent-readiness/scripts/lib/guard.ts";
import { startSession } from "../skill/agent-readiness/scripts/lib/session.ts";
import { materialize, readiness } from "../support/tools/fixture.ts";

// Fixes for the should-fix items S1 to S17 of the offline production-readiness review of 0.2.

describe("S1: the guard refuses nothing outside a session, and leaves the repo as it was", () => {
  test("outside a session a repo's own seed.txt, mutants.json and the work folder are readable; in one only the audit's folders are held", () => {
    const repo = materialize("healthy-node");
    const reads = [join(repo, "db/seed.txt"), join(repo, "test/mutants.json"), join(repo, "fixtures/draft.digest")];
    for (const f of reads) assert.equal(guardDecision({ file_path: f, cwd: repo }, {}).permission, "allow", f);
    for (const cmd of ["cat db/seed.txt", "cat .agent-readiness/work/CURRENT", "ls /tmp/readiness-aud-x/"]) assert.equal(guardDecision({ command: cmd, cwd: repo }, {}).permission, "allow", `no session: ${cmd}`);
    startSession(repo);
    for (const f of reads) assert.equal(guardDecision({ file_path: f, cwd: repo }, {}).permission, "allow", `in a session the repo's own ${f} is still the repo's`);
    assert.equal(guardDecision({ file_path: "/tmp/readiness-aud-2026-11-23-abc1234-0f0f-Xy12/seed.txt", cwd: repo }, {}).permission, "deny");
    assert.equal(guardDecision({ file_path: "/tmp/readiness-aud-2026-11-23-abc1234-0f0f-Xy12/tree/src/a.ts", cwd: repo }, {}).permission, "allow", "the audited tree is a copy of the repo");
    assert.equal(guardDecision({ command: "find / -name mutants.json", cwd: repo }, {}).permission, "deny", "a command that searches by name still finds the store");
  });

  test("the refusal while a draft is open says how to get out", () => {
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"]).code, 0);
    assert.match(guardDecision({ command: "npm test", cwd: repo }, {}).agent_message ?? "", /`readiness session end` or `readiness init --force`/);
  });

  test("uninstall puts a hooks.json without a version, in its own layout, back byte for byte", () => {
    const repo = materialize("healthy-node");
    mkdirSync(join(repo, ".cursor"), { recursive: true });
    const before = '{"hooks":{"afterFileEdit":[{"command":"./fmt.sh"}]}}';
    writeFileSync(join(repo, HOOKS_FILE), before);
    assert.equal(installGuard(repo).status, "installed");
    assert.notEqual(readFileSync(join(repo, HOOKS_FILE), "utf8"), before);
    assert.equal(uninstallGuard(repo).status, "removed");
    assert.equal(readFileSync(join(repo, HOOKS_FILE), "utf8"), before);
  });

  test("guard status runs the hook, and says so when it can't start", () => {
    const repo = materialize("healthy-node");
    installGuard(repo);
    assert.equal(probeGuard(repo).answers, true);
    assert.match(readiness(repo, ["guard", "status"]).out, /installed in \.cursor\/hooks\.json/);
    const cfg = JSON.parse(readFileSync(join(repo, HOOKS_FILE), "utf8"));
    for (const step of Object.keys(cfg.hooks)) cfg.hooks[step] = cfg.hooks[step].map((h: { command: string }) => ({ command: h.command.replace(/^node /, "no-such-node ") }));
    writeFileSync(join(repo, HOOKS_FILE), JSON.stringify(cfg));
    assert.equal(probeGuard(repo).answers, false);
    assert.match(readiness(repo, ["guard", "status"]).out, /the hook didn't answer \(exit 127\).*enforces nothing/);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }), "", "the probe changes no repo file");
  });
});
