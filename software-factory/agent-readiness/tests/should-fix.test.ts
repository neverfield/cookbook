import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { detectRuntime } from "../skill/agent-readiness/scripts/lib/container.ts";
import { HOOKS_FILE, guardDecision, installGuard, probeGuard, uninstallGuard } from "../skill/agent-readiness/scripts/lib/guard.ts";
import { reproOf } from "../skill/agent-readiness/scripts/lib/model.ts";
import { renderHtml } from "../skill/agent-readiness/scripts/lib/render-html.ts";
import { renderMarkdown } from "../skill/agent-readiness/scripts/lib/render.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { startSession } from "../skill/agent-readiness/scripts/lib/session.ts";
import { materialize, readiness } from "../support/tools/fixture.ts";
import { makeAudit, reportFor } from "./helpers.ts";

// Fixes for the should-fix items S1 to S17 of the offline production-readiness review of 0.2.
const runtime = detectRuntime("auto");
const docker = { skip: runtime ? false : "no container runtime: this needs docker", timeout: 5 * 60 * 1000 };

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

describe("S2: a rerun command runs the step as the audit did", () => {
  const audit = makeAudit({ components: [{ id: "app", share: 1 }] });
  for (const e of audit.evidence) e.image = "node:22-bookworm";
  const test1 = audit.evidence.find((e) => e.kind === "test")!;

  test("the pinned image, the host's user, the audit's home and CI=1, and the image's PATH kept past the login profile", () => {
    const repro = reproOf(audit, test1)!;
    assert.match(repro, /^docker run --rm --user "\$\(id -u\):\$\(id -g\)" -e HOME=\/tmp\/home -e CI=1 -v "\$PWD":\/work -w \/work node:22-bookworm@sha256:[0-9a-f]{64} bash -c /);
    assert.match(repro, /SA_READINESS_IMAGE_PATH="\$PATH" exec bash -lc/);
    assert.doesNotMatch(repro, /bash -lc 'npm/, "no plain login shell, which drops the image's PATH");
    assert.match(repro, /npm ci.*&&.*npm test/);
  });

  test("the report says above the list that the network stays on and to use a fresh clone", () => {
    const r = reportFor(audit);
    const md = renderMarkdown(r, loadRubric(audit.rubric));
    assert.match(md, /Rerun a step from a clean checkout of `[^`]+`\. Each command keeps the network on, where the audit ran tests and planted faults offline.*fresh clone/);
    assert.match(renderHtml(r), /Each command keeps the network on/);
  });

  test("pasted into a clean checkout, it runs and leaves no root-owned file", docker, () => {
    const dir = mkdtempSync(join(tmpdir(), "rerun-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "node -e \"require('fs').writeFileSync('out.txt', process.version)\"" } }));
    const e = { ...test1, cwd: "." };
    const repro = reproOf({ ...audit, evidence: [e] }, e)!;
    const r = spawnSync("bash", ["-c", repro], { cwd: dir, encoding: "utf8", timeout: 4 * 60 * 1000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /^v22\./);
    assert.equal(statSync(join(dir, "out.txt")).uid, process.getuid!());
  });
});
