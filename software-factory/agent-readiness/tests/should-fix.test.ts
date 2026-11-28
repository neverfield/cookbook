import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ContainerSession, detectRuntime, pullTimeoutMs } from "../skill/agent-readiness/scripts/lib/container.ts";
import { changeCounts } from "../skill/agent-readiness/scripts/lib/discover/ownership.ts";
import { diagnose, privatePackage } from "../skill/agent-readiness/scripts/lib/diagnose.ts";
import { MASKED_COMMAND } from "../skill/agent-readiness/scripts/lib/seal.ts";
import { HOOKS_FILE, guardDecision, installGuard, probeGuard, uninstallGuard } from "../skill/agent-readiness/scripts/lib/guard.ts";
import { reproOf } from "../skill/agent-readiness/scripts/lib/model.ts";
import type { Executor, Executors } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { checkExecutors, declaredBuildFailure, hostExecutor, mountHint, mountUnseen, openWithMountRetry, replay } from "../skill/agent-readiness/scripts/lib/replay.ts";
import type { VmDetection } from "../skill/agent-readiness/scripts/lib/proofenv.ts";
import { vmNotDetectedNote } from "../skill/agent-readiness/scripts/lib/proofenv.ts";
import { loadDraft, saveDraft } from "../skill/agent-readiness/scripts/lib/workspace.ts";
import { DOTNET_INSTALL_SCRIPT, dotnet } from "../skill/agent-readiness/scripts/lib/languages/dotnet.ts";
import { redact } from "../skill/agent-readiness/scripts/lib/redact.ts";
import { renderHtml } from "../skill/agent-readiness/scripts/lib/render-html.ts";
import { renderMarkdown } from "../skill/agent-readiness/scripts/lib/render.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { startSession } from "../skill/agent-readiness/scripts/lib/session.ts";
import { TEMP_MARK, tempDir } from "../skill/agent-readiness/scripts/lib/teardown.ts";
import type { Audit } from "../skill/agent-readiness/scripts/lib/types.ts";
import { SKILL_ROOT, assertFreeSpace, freeSpaceProblem, treeBytes } from "../skill/agent-readiness/scripts/lib/util.ts";
import { commitAll, materialize, readiness } from "../support/tools/fixture.ts";
import { makeAudit, reportFor } from "./helpers.ts";

// Fixes for the should-fix items S1 to S17 of the offline production-readiness review of 0.2.
const TESTS = dirname(fileURLToPath(import.meta.url));
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

function draftAudit(repo: string): Audit {
  const work = join(repo, ".agent-readiness", "work");
  return JSON.parse(readFileSync(join(work, readFileSync(join(work, "CURRENT"), "utf8").trim(), "audit.json"), "utf8")) as Audit;
}

describe("S3: the skill excludes itself in any agent's skills folder", () => {
  for (const at of [".claude/skills/agent-readiness", ".agents/skills/agent-readiness"]) {
    test(`installed under ${at}, none of its files counts as the repo's`, () => {
      const repo = materialize("healthy-node");
      const scan = () => {
        assert.equal(readiness(repo, ["init", "--tier", "read-only", "--force"]).code, 0);
        const r = readiness(repo, ["scan"]);
        assert.equal(r.code, 0, r.out);
        return draftAudit(repo);
      };
      const before = scan();
      cpSync(SKILL_ROOT, join(repo, at), { recursive: true, filter: (src) => !src.includes("node_modules") });
      writeFileSync(join(repo, at, "references", "token-example.md"), `npx tool --token ghp_${"x".repeat(36)}\n`);
      commitAll(repo, "Install the readiness skill");
      const after = scan();
      const inSkill = (f: string | undefined) => Boolean(f?.startsWith(`${at}/`));
      assert.deepEqual(after.instructions.filter((i) => inSkill(i.source)), [], "its SKILL.md isn't the repo's instructions");
      assert.deepEqual(after.assets.filter((a) => inSkill(a.path)), [], "it isn't one of the repo's assets");
      assert.deepEqual(after.safety.filter((s) => inSkill(s.file)), [], "its examples aren't the repo's secrets");
      assert.equal(after.profile!.totalChanges, before.profile!.totalChanges, "installing it isn't work in the repo");
    });
  }
});

function sealedAudit(repo: string): { audit: Audit; md: string } {
  const audits = join(repo, ".agent-readiness", "history", "audits");
  const dir = join(audits, readdirSync(audits).sort().pop()!);
  return { audit: JSON.parse(readFileSync(join(dir, "audit.json"), "utf8")) as Audit, md: readFileSync(join(dir, "report.md"), "utf8") };
}

describe("S4: host mode keeps a record of the user's yes", () => {
  const hostAudit = ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants", "--allow-host"];

  test("a yes recorded with allow-host is quoted in the sealed audit and the report", () => {
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["allow-host", "--note", "yes, run npm test on this laptop"]).code, 0);
    const r = readiness(repo, hostAudit);
    assert.equal(r.code, 0, r.out);
    const { audit, md } = sealedAudit(repo);
    assert.equal(audit.environment.hostConsent?.note, "yes, run npm test on this laptop");
    assert.match(md, /Host mode\W+the repo's commands ran on this machine on the user's yes, recorded at [^:]+:\S*: "yes, run npm test on this laptop"/);
  });

  test("host mode on the flag alone says no yes was recorded", () => {
    const repo = materialize("healthy-node");
    const r = readiness(repo, hostAudit);
    assert.equal(r.code, 0, r.out);
    const { audit, md } = sealedAudit(repo);
    assert.equal(audit.environment.hostConsent, null);
    assert.match(md, /with no recorded yes: --allow-host was passed/);
  });
});

describe("S5: a container that can't see the temp folder gets a second folder, and a reason", () => {
  // An executor whose work tree the "runtime" sees, or doesn't.
  const fakeEx = (sees: boolean, root: string): Executor => ({
    where: "container",
    strength: "clean_replay",
    image: "node:22-bookworm",
    imageSource: "audit",
    root,
    exec: async () => ({ exitCode: 0, timedOut: false, durationMs: 1, output: sees ? canaryLines(true) : canaryLines(false) }),
    offline: () => true,
    networkOff: null,
    close: () => {},
    runUser: null,
  });
  const canaryLines = (visible: boolean) => [visible ? "readiness-canary mount_visible ok" : "readiness-canary mount_visible fail the work tree is empty", "readiness-canary mount_writable ok", "readiness-canary run_user 1000", "readiness-canary git_identity ok"].join("\n");
  const set = (ex: Executor): Executors => ({ groups: [{ ex, components: ["app"], repoWide: true }], forComponent: () => ex, repo: ex, close: () => {} });
  const withProof = (audit: Audit) => {
    audit.environment.proofEnv = { kind: "container", id: "docker:node:22-bookworm", imageSource: "audit", network: null, canary: { ok: true, checks: [] }, proves: true };
  };

  test("an empty mount under the temp folder is retried under the second folder, and the first copy is gone", async () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1 }] });
    const tree = mkdtempSync(join(tmpdir(), "tree-"));
    writeFileSync(join(tree, "package.json"), "{}");
    const [first, second] = [mkdtempSync(join(tmpdir(), "base1-")), mkdtempSync(join(tmpdir(), "base2-"))];
    const hints: (string | undefined)[] = [];
    const dirs: string[] = [];
    const logs: string[] = [];
    const { scratch, copyDir } = await openWithMountRetry(audit, tree, (s) => logs.push(s), async (dir, hint) => {
      hints.push(hint);
      dirs.push(dir);
      withProof(audit);
      return checkExecutors(audit, set(fakeEx(dir.startsWith(second), dir)), audit.profile!, () => {}, hint);
    }, [first, second]);
    assert.deepEqual(hints, [undefined, mountHint([first, second])]);
    assert.ok(copyDir.startsWith(second) && existsSync(join(copyDir, "package.json")));
    assert.equal(existsSync(dirs[0]), false, "the copy the runtime couldn't see is removed");
    assert.equal(mountUnseen(audit), false);
    assert.equal(audit.environment.notRun, undefined);
    assert.match(logs.join("\n"), /couldn't see the audit's copy of the repo under .*trying again under/);
    scratch.dispose();
  });

  test("when neither folder is seen, the self-check names both and says TMPDIR moves it", async () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1 }] });
    const tree = mkdtempSync(join(tmpdir(), "tree-"));
    const bases = [mkdtempSync(join(tmpdir(), "base1-")), mkdtempSync(join(tmpdir(), "base2-"))];
    const { scratch } = await openWithMountRetry(audit, tree, () => {}, async (dir, hint) => {
      withProof(audit);
      return checkExecutors(audit, set(fakeEx(false, dir)), audit.profile!, () => {}, hint);
    }, bases);
    assert.match(audit.environment.notRun ?? "", new RegExp(`mount visible: the container runtime couldn't see the work tree under ${bases[0]} or ${bases[1]}.*set TMPDIR to a folder it shares`));
    scratch.dispose();
  });
});

describe("S7: history push runs none of the repo's hooks and no commit signing", () => {
  test("a failing pre-commit and pre-push hook, a post-checkout hook and gpgsign don't stop it or run", () => {
    const repo = materialize("healthy-node");
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"]);
    assert.equal(r.code, 0, r.out);
    const remote = mkdtempSync(join(tmpdir(), "remote-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
    const ran = join(repo, "..", "hooks-ran");
    for (const hook of ["pre-commit", "commit-msg", "post-checkout", "pre-push"]) {
      writeFileSync(join(repo, ".git", "hooks", hook), `#!/bin/sh\necho ${hook} >> ${JSON.stringify(ran)}\nexit 1\n`);
      chmodSync(join(repo, ".git", "hooks", hook), 0o755);
    }
    execFileSync("git", ["config", "commit.gpgsign", "true"], { cwd: repo });
    execFileSync("git", ["config", "gpg.program", "false"], { cwd: repo });
    const pushed = readiness(repo, ["history", "push", "--push"]);
    assert.equal(pushed.code, 0, pushed.out);
    assert.match(pushed.out, /committed history to agent-readiness\/history and pushed to origin/);
    assert.equal(existsSync(ran), false, "no hook ran");
    assert.match(execFileSync("git", ["ls-tree", "--name-only", "agent-readiness/history"], { cwd: remote, encoding: "utf8" }), /history\.jsonl/);
  });
});

describe("S8: a private package the registry won't show reads as a missing credential", () => {
  const cases: [string, string, string][] = [
    ["npm, scoped on npmjs.org", "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@acme%2fwidgets - Not found\nnpm error 404  '@acme/widgets@^1.2.0' is not in this registry.", "@acme/widgets"],
    ["pnpm, an internal registry", "ERR_PNPM_FETCH_404  GET https://npm.acme.internal/billing-core: Not Found - 404", "billing-core"],
    ["yarn, scoped", 'error An unexpected error occurred: "https://registry.yarnpkg.com/@acme%2fui: Not found".', "@acme/ui"],
    ["Maven, a Nexus repository", "[ERROR] Failed to execute goal on project app: Could not resolve dependencies for project com.acme:app:jar:1.0: Could not find artifact com.acme:billing-core:jar:2.3.1 in nexus (https://nexus.acme.corp/repository/maven-releases/) -> [Help 1]", "com.acme:billing-core:jar:2.3.1"],
    ["NuGet, a private feed listed", "/src/App.csproj : error NU1101: Unable to find package Acme.Billing. No packages exist with this id in source(s): AcmeFeed, nuget.org", "Acme.Billing"],
    ["pip, an extra index", "Looking in indexes: https://pypi.org/simple, https://pypi.acme.corp/simple\nERROR: Could not find a version that satisfies the requirement acme-billing==2.0 (from versions: none)\nERROR: No matching distribution found for acme-billing==2.0", "acme-billing"],
    ["Go, a private host", "go: git.acme.corp/platform/billing@v1.4.0: reading https://proxy.golang.org/git.acme.corp/platform/billing/@v/v1.4.0.mod: 404 Not Found", "git.acme.corp/platform/billing"],
    ["Go, a private GitHub repo", "go: github.com/acme/billing@v1.4.0: invalid version: git ls-remote -q origin in /go/pkg/mod/cache/vcs/abc: exit status 128:\n\tfatal: could not read Username for 'https://github.com': terminal prompts disabled", "github.com/acme/billing"],
  ];
  for (const [name, output, pkg] of cases) {
    test(name, () => {
      const d = diagnose(output, false, "install", 1);
      assert.equal(d.cause, "registry");
      assert.equal(d.detail, `${pkg} looks like a private package the registry answered "not found" for, as one does without its credential; pass the credential with --registry-env`);
    });
  }

  test("a typo or a missing version on a public registry stays the repo's own failure", () => {
    for (const out of [
      "npm error 404 Not Found - GET https://registry.npmjs.org/lefpad - Not found",
      readFileSync(join(TESTS, "tool-outputs", "maven-wrong-version.txt"), "utf8"),
      "error NU1101: Unable to find package Newtonsoft.Jsn. No packages exist with this id in source(s): nuget.org",
      "Looking in indexes: https://pypi.org/simple\nERROR: Could not find a version that satisfies the requirement reqests (from versions: none)",
      "go: github.com/google/uuid@v1.99.0: reading https://proxy.golang.org/github.com/google/uuid/@v/v1.99.0.mod: 404 Not Found",
    ]) assert.notEqual(diagnose(out, false, "install", 1).cause, "registry", out.slice(0, 80));
    assert.equal(privatePackage("npm error 404 Not Found - GET https://registry.npmjs.org/@acme%2fwidgets"), "@acme/widgets");
    assert.notEqual(diagnose("npm error 404 Not Found - GET https://registry.npmjs.org/@acme%2fwidgets", false, "test", 1).cause, "registry", "only a setup step's registry answer");
  });
});

describe("S9: a maintainer corrects a wrong discovered command in a committed config", () => {
  // The scan's test command runs a suite that needs a service, as an e2e suite would; the unit suite is the right one.
  function wrongTest(): string {
    const repo = materialize("healthy-node");
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    pkg.scripts.test = 'node -e "console.error(\'connect ECONNREFUSED 127.0.0.1:5432\'); process.exit(1)"';
    pkg.scripts["test:unit"] = "node --test";
    writeFileSync(join(repo, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    commitAll(repo, "test runs e2e");
    return repo;
  }
  const config = (commands: object[]) => JSON.stringify({ schema: "agent-readiness/config@1", commands }, null, 2) + "\n";
  const unit = { component: "healthy-node", kind: "test", cmd: "npm run test:unit", reason: "test runs the e2e suite, which needs a database", by: "Contributor A" };
  const hostAudit = ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants", "--allow-host"];

  test("the named command replaces the scan's, runs, and About this report lists it", () => {
    const repo = wrongTest();
    mkdirSync(join(repo, ".agent-readiness"), { recursive: true });
    writeFileSync(join(repo, ".agent-readiness", "config.json"), config([unit, { component: "nope", kind: "test", cmd: "x", reason: "a component that isn't there", by: "B" }]));
    commitAll(repo, "Name the unit test command");
    const r = readiness(repo, hostAudit);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /config\.json replaces cmd-healthy-node-test \(`npm run test`\)/);
    const { audit, md } = sealedAudit(repo);
    const tests = audit.contract.filter((c) => c.kind === "test");
    assert.deepEqual(tests.map((c) => c.command), ["npm run test:unit"]);
    assert.match(tests[0].source, /^\.agent-readiness\/config\.json:\d+$/);
    assert.equal(audit.evidence.find((e) => e.kind === "test" && !e.supersededBy)?.result, "pass");
    assert.match(md, /Command config\W+\.agent-readiness\/config\.json in the audited commit named `npm run test:unit` as the test command for healthy-node, reviewed by Contributor A: test runs the e2e suite.*1 entry was refused \(commands\[1\]: "component" must be/);
  });

  test("an uncommitted config changes nothing, and says so", () => {
    const repo = wrongTest();
    mkdirSync(join(repo, ".agent-readiness"), { recursive: true });
    writeFileSync(join(repo, ".agent-readiness", "config.json"), config([unit]));
    const r = readiness(repo, hostAudit);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /config\.json isn't in the audited commit, so it was ignored/);
    assert.deepEqual(sealedAudit(repo).audit.contract.filter((c) => c.kind === "test").map((c) => c.command), ["npm run test"]);
  });
});

describe("S10: proof on a cloud VM says what it proves, and a missing signal shows", () => {
  const CLOUD_VM: VmDetection = { kind: "cursor_cloud_agent", label: "a Cursor Cloud Agent VM", signals: ["/exec-daemon", "CLOUD_AGENT_INJECTED_SECRET_NAMES"] };

  test("the report and the host-mode finding say the VM was proved as provisioned, and that its secrets were readable", { timeout: 5 * 60 * 1000 }, async () => {
    const repo = materialize("healthy-node");
    for (const step of [["init", "--tier", "local-exec"], ["scan"]]) assert.equal(readiness(repo, step).code, 0, step.join(" "));
    const { audit, local, paths: p } = loadDraft(repo);
    await replay(audit, repo, local.tree, loadRubric(audit.rubric), { runtime: "none", allowHost: true, vm: CLOUD_VM, mutants: false, instructions: false, budgetComponentMinutes: 15, budgetTotalMinutes: 60, log: () => {} });
    saveDraft(p, audit);
    assert.equal(readiness(repo, ["seal"]).code, 0);
    const { audit: sealed, md } = sealedAudit(repo);
    assert.match(md, /fresh copy on a disposable VM as provisioned, including its preinstalled tools and running services/);
    assert.match(sealed.safety.find((s) => s.kind === "host_mode")!.detail, /and the secrets injected into it\. A pass there proves the VM as provisioned, including its preinstalled tools and running services/);
  });

  test("a Linux machine with neither signal logs one line; a VM sign, another OS or detection off logs none", () => {
    assert.match(vmNotDetectedNote({}, "linux", () => false) ?? "", /neither sign of a Cursor Cloud Agent VM \(\/exec-daemon and CLOUD_AGENT_\* variables\)/);
    assert.equal(vmNotDetectedNote({}, "linux", (f) => f === "/exec-daemon"), null);
    assert.equal(vmNotDetectedNote({ CLOUD_AGENT_SOMETHING_NEW: "1" }, "linux", () => false), null, "a renamed variable still counts as a sign, so the line doesn't cry wolf");
    assert.equal(vmNotDetectedNote({}, "darwin", () => false), null);
    assert.equal(vmNotDetectedNote({ SA_READINESS_VM_DETECT: "off" }, "linux", () => false), null);
  });

  test("SKILL.md rule 2 names the injected secrets in the consent question", () => {
    assert.match(readFileSync(join(SKILL_ROOT, "SKILL.md"), "utf8"), /A disposable cloud VM the audit detects is still this machine: ask the same way, and say the commands can also read the secrets injected into the VM\./);
  });
});

describe("S11: an image pull gets its own limit and says when it ran out", () => {
  // A runtime that has no image and whose pull never finishes; anything else it is asked fails loudly.
  function slowRuntime(): string {
    const dir = mkdtempSync(join(tmpdir(), "slow-runtime-"));
    const bin = join(dir, "docker");
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(dir, "calls"))}\ncase "$1" in\n  image) exit 1 ;;\n  pull) echo "Pulling fs layer"; exec sleep 30 ;;\n  *) echo "unexpected: $*" >&2; exit 2 ;;\nesac\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  test("a pull past its limit is reported as the pull, never as a container with no output", () => {
    const bin = slowRuntime();
    const session = new ContainerSession({ bin }, "readiness-test-pull", "node:22-bookworm", tmpdir(), [], null);
    session.pullTimeoutMs = 1000;
    const logs: string[] = [];
    const r = session.start((s) => logs.push(s));
    assert.equal(r.ok, false);
    assert.match(r.output, /^the image pull didn't finish in 1 seconds; pull node:22-bookworm@sha256:[0-9a-f]{64} by hand, or set SA_READINESS_PULL_MINUTES higher/);
    assert.match(logs[0], /^Pulling node:22-bookworm, which this machine doesn't have yet/);
    assert.doesNotMatch(readFileSync(join(dirname(bin), "calls"), "utf8"), /^run /m, "the container isn't started after a failed pull");
    session.remove();
  });

  test("the pull limit defaults to 30 minutes and SA_READINESS_PULL_MINUTES sets it", () => {
    assert.equal(pullTimeoutMs({}), 30 * 60000);
    assert.equal(pullTimeoutMs({ SA_READINESS_PULL_MINUTES: "90" }), 90 * 60000);
  });
});

describe("S12: cleanup removes only the folders an audit marked as its own", () => {
  test("a developer's old readiness-check folder stays; an audit's old folder goes; a kept draft keeps its mark", () => {
    const repo = materialize("healthy-node");
    const tmp = mkdtempSync(join(tmpdir(), "cleanup-mark-"));
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"], { TMPDIR: tmp }).code, 0);
    const tree = JSON.parse(readFileSync(join(repo, ".agent-readiness/work", readFileSync(join(repo, ".agent-readiness/work/CURRENT"), "utf8").trim(), "local.json"), "utf8")).tree as string;
    assert.equal(existsSync(join(dirname(tree), TEMP_MARK)), true, "the draft's folder outlives init and keeps its mark");
    const mine = join(tmp, "readiness-check");
    mkdirSync(mine);
    writeFileSync(join(mine, "notes.txt"), "mine");
    const audits = tempDir("readiness-replay-", tmp);
    audits.keep();
    const past = new Date(Date.now() - 6 * 3600e3);
    for (const d of [mine, audits.path]) utimesSync(d, past, past);
    const r = readiness(repo, ["cleanup"], { TMPDIR: tmp });
    assert.equal(r.code, 0, r.out);
    assert.equal(existsSync(join(mine, "notes.txt")), true, "not the audit's, whatever its name and age");
    assert.equal(existsSync(audits.path), false);
  });
});

describe("S13: a declared image that doesn't build is a finding, and the audit seals", () => {
  test("a Dockerfile step that fails is the repo's failed install, with the step's error", docker, () => {
    const repo = materialize("healthy-node");
    mkdirSync(join(repo, ".cursor"), { recursive: true });
    writeFileSync(join(repo, ".cursor", "Dockerfile"), "FROM node:22-bookworm@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb\nRUN echo 'setup script missing' >&2 && false\n");
    writeFileSync(join(repo, ".cursor", "environment.json"), JSON.stringify({ build: { dockerfile: "Dockerfile", context: ".." } }));
    commitAll(repo, "declared image that can't build");
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--no-mutants"]);
    assert.equal(r.code, 0, r.out);
    const { audit, md } = sealedAudit(repo);
    const ev = audit.evidence.find((e) => e.condition === "clean.install" && e.result === "fail")!;
    assert.match(ev.summary, /^install failed: the declared environment image \.cursor\/Dockerfile doesn't build \(.*\)/);
    assert.equal(ev.attribution?.verdict, "repo");
    assert.match(audit.environment.notRun ?? "", /declared environment image \.cursor\/Dockerfile didn't build/);
    assert.match(md, /declared environment image \.cursor\/Dockerfile doesn't build/);
  });

  test("a base image that can't be pulled blocks the install on this machine instead", () => {
    const f = declaredBuildFailure("#3 [internal] load metadata for registry.acme.corp/base:1\nERROR: failed to solve: registry.acme.corp/base:1: failed to resolve source metadata for registry.acme.corp/base:1: dial tcp: lookup registry.acme.corp: no such host", "Dockerfile");
    assert.equal(f.result, "not_run");
    assert.match(f.blocked ?? "", /^the base image of the declared environment \.cursor\/Dockerfile couldn't be pulled on this machine \(ERROR: failed to solve/);
    assert.equal(declaredBuildFailure("#5 [2/2] RUN ./setup.sh\n#5 0.2 /bin/sh: ./setup.sh: not found\nERROR: failed to solve: process \"/bin/sh -c ./setup.sh\" did not complete successfully: exit code: 127", "Dockerfile").result, "fail");
  });
});

describe("S14: smaller security and hygiene points", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test("a service a host-mode command leaves in the background ends when the replay closes", async () => {
    const ex = hostExecutor(mkdtempSync(join(tmpdir(), "host-")), [], false, "fresh_copy", true);
    const out = await ex.exec("sleep 300 > /dev/null 2>&1 & echo $!", ".", 10);
    const pid = Number(out.output.trim());
    assert.ok(pid > 0 && alive(pid), "the service outlives its command");
    ex.close();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(pid), false);
  });

  test("a private key printed in output is redacted through its END line, or to the end of its body when cut off", () => {
    const body = ["MIIEowIBAAKCAQEA1x8vYq3k2mJ9Zr7Pq0Lw4Nn6Hh2Tt5Uu8Vv1Ww3Xx7Yy9Zz0Aa", "c2VjcmV0LWtleS1ib2R5LWxpbmUtdHdvLXdpdGgtZW5vdWdoLWNoYXJzLXRvLW1hdGNo"];
    const key = ["-----BEGIN RSA PRIVATE KEY-----", ...body, "-----END RSA PRIVATE KEY-----"].join("\n");
    const full = redact(`config loaded\n${key}\nnext step ok`);
    assert.equal(full, "config loaded\n[redacted:Private key]\nnext step ok");
    const cut = redact(`dump:\n-----BEGIN PRIVATE KEY-----\n${body[0]}\n${body[1]}`);
    for (const line of body) assert.doesNotMatch(cut, new RegExp(line.slice(0, 20)));
    const escaped = redact(`{"key":"-----BEGIN PRIVATE KEY-----\\n${body[0]}\\n-----END PRIVATE KEY-----\\n","ok":true}`);
    assert.equal(escaped, '{"key":"[redacted:Private key]\\n","ok":true}');
  });

  test("Microsoft's install script is pinned to a commit and checked against its digest before it runs", () => {
    const strict = mkdtempSync(join(tmpdir(), "dotnet-"));
    writeFileSync(join(strict, "global.json"), '{"sdk":{"version":"10.0.100"}}');
    writeFileSync(join(strict, "A.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
    const [t] = dotnet.replay!.setup!(strict, ".");
    assert.match(DOTNET_INSTALL_SCRIPT.url, /^https:\/\/raw\.githubusercontent\.com\/dotnet\/install-scripts\/[0-9a-f]{40}\/src\/dotnet-install\.sh$/);
    assert.ok(t.install.startsWith(`curl -fsSL ${DOTNET_INSTALL_SCRIPT.url} -o /tmp/dotnet-install.sh && echo "${DOTNET_INSTALL_SCRIPT.sha256}  /tmp/dotnet-install.sh" | sha256sum -c --quiet - && bash /tmp/dotnet-install.sh`), t.install);
    assert.doesNotMatch(t.install, /dot\.net\/v1/);
  });

  test("README says the install can reach the metadata address and what host mode stops", () => {
    const readme = readFileSync(join(SKILL_ROOT, "..", "..", "README.md"), "utf8");
    assert.match(readme, /instance metadata address \(169\.254\.169\.254\)/);
    assert.match(readme, /a service the repo's start step leaves running in the background is stopped when the replay ends/);
  });
});

describe("S16: narrate's cause takes one condition and one id", () => {
  test("text is refused, and a cause with a second = isn't cut into a valid one", () => {
    const repo = materialize("healthy-node");
    for (const step of [["init", "--tier", "local-exec"], ["scan"]]) assert.equal(readiness(repo, step).code, 0);
    const gap = readiness(repo, ["narrate", "--gap", "clean.install=needs a=b"]);
    assert.equal(gap.code, 2);
    assert.match(gap.out, /narrate takes no text \(--gap\)/);
    const cut = readiness(repo, ["narrate", "--cause", "clean.install=ev-001=extra"]);
    assert.equal(cut.code, 2, cut.out);
    assert.match(cut.out, /ev-001=extra/);
  });
});

describe("S17: change shares that can't be read say so", () => {
  test("a git log that fails is logged at scan and marked on the coverage line", () => {
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"]).code, 0);
    // A history git can't walk: the commit's parent objects are gone.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const counts = changeCounts(repo, loadRubric("2026-12-beta"), "0".repeat(40));
    assert.match(counts.failed ?? "", /^git log didn't finish/);
    assert.equal(changeCounts(repo, loadRubric("2026-12-beta"), head).failed, undefined);
    const audit = makeAudit({ components: [{ id: "app", share: 1 }] });
    audit.profile!.sharesUnread = "git log didn't finish: fatal: bad object";
    const md = renderMarkdown(reportFor(audit), loadRubric(audit.rubric));
    assert.match(md, /Change shares couldn't be read \(git log didn't finish: fatal: bad object\), so every component's share reads 0%\./);
  });

  test("the scan logs it", () => {
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"]).code, 0);
    const r = readiness(repo, ["scan"], { SA_READINESS_HISTORY_SECONDS: "0.001" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Change shares couldn't be read \(git log didn't finish in 0 s/);
  });
});

describe("#65 follow-up: recheck blocks a command the seal masked, and runs the rest", () => {
  test("a contract command carrying a token is masked at the seal, and recheck records it as blocked, never failed", () => {
    const token = ["ghp_", "b".repeat(36)].join("");
    const repo = materialize("healthy-node");
    writeFileSync(join(repo, "AGENTS.md"), `${readFileSync(join(repo, "AGENTS.md"), "utf8")}- Release build: \`node scripts/build.mjs --token ${token}\`\n`);
    commitAll(repo, "document the release build");
    const line = readFileSync(join(repo, "AGENTS.md"), "utf8").split("\n").findIndex((l) => l.includes(token)) + 1;
    const HOST = { SA_READINESS_ALLOW_HOST: "1" };
    for (const step of [["init", "--tier", "local-exec"], ["scan"], ["contract", "add", "--kind", "build", "--component", "healthy-node", "--cmd", `node scripts/build.mjs --token ${token}`, "--source", `AGENTS.md:${line}`, "--reason", "the documented release build"], ["replay", "--runtime", "none", "--no-mutants"], ["seal"]]) {
      const r = readiness(repo, step, HOST);
      assert.equal(r.code, 0, `${step.join(" ")}: ${r.out}`);
    }
    const { audit } = sealedAudit(repo);
    assert.ok(audit.contract.some((c) => c.command === "node scripts/build.mjs --token [redacted:GitHub token]"), "the seal masked the command");
    const r = readiness(repo, ["recheck", "--runtime", "none"], HOST);
    assert.equal(r.code, 0, r.out);
    const rechecks = join(repo, ".agent-readiness", "history", "rechecks");
    const record = JSON.parse(readFileSync(join(rechecks, readdirSync(rechecks)[0]), "utf8"));
    const masked = record.results.find((x: { kind: string; status: string; note: string }) => x.kind === "build" && x.note === MASKED_COMMAND);
    assert.ok(masked, JSON.stringify(record.results));
    assert.equal(masked.status, "blocked", "the record stores the verdict, so a blocked step never reads as not run or failed");
    assert.ok(record.results.some((x: { kind: string; status: string }) => x.kind === "test" && x.status === "pass"), "the other commands still ran");
    assert.ok(!readFileSync(join(rechecks, readdirSync(rechecks)[0]), "utf8").includes(token));
    const history = readFileSync(join(repo, ".agent-readiness", "history", "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.notEqual(history.at(-1).result, "failed", "a masked command never lowers a level");
  });
});

describe("S6: a copy of the tree checks the free disk first", () => {
  test("git gives the tree's size without a checkout", () => {
    const repo = materialize("healthy-node");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const files = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
    assert.equal(treeBytes(repo, head), files.reduce((n, f) => n + statSync(join(repo, f)).size, 0));
  });

  test("too little free space stops with what it needs and how to move it; enough says nothing", () => {
    const gb = 1024 ** 3;
    assert.match(freeSpaceProblem("/tmp", 0.2 * gb, 2 * gb, "a clean checkout") ?? "", /^Not enough free disk for a clean checkout: \/tmp has 205 MB free and this needs about 2\.5 GB\. Free space there, or set TMPDIR/);
    assert.equal(freeSpaceProblem("/tmp", 10 * gb, 2 * gb, "a clean checkout"), null);
  });

  test("init on a disk without room stops before it writes, with no folder left behind", () => {
    const repo = materialize("healthy-node");
    // A tmpfs this small can't hold the headroom, so the check stops the export.
    const small = mkdtempSync(join(tmpdir(), "small-"));
    const mounted = spawnSync("sudo", ["-n", "mount", "-t", "tmpfs", "-o", `size=64m,uid=${process.getuid!()}`, "tmpfs", small], { encoding: "utf8" });
    if (mounted.status !== 0) {
      assert.throws(() => assertFreeSpace(tmpdir(), Number.MAX_SAFE_INTEGER, "a clean checkout"), /Not enough free disk for a clean checkout/);
      return;
    }
    try {
      const r = readiness(repo, ["init", "--tier", "local-exec"], { TMPDIR: small });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, new RegExp(`Not enough free disk for a clean checkout of [0-9a-f]{7}.*${small}/\\S+ has \\d+ MB free`));
      assert.deepEqual(readdirSync(small), []);
    } finally {
      spawnSync("sudo", ["-n", "umount", small]);
    }
  });
});
