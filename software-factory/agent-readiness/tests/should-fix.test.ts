import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectRuntime } from "../skill/agent-readiness/scripts/lib/container.ts";
import { diagnose, privatePackage } from "../skill/agent-readiness/scripts/lib/diagnose.ts";
import { HOOKS_FILE, guardDecision, installGuard, probeGuard, uninstallGuard } from "../skill/agent-readiness/scripts/lib/guard.ts";
import { reproOf } from "../skill/agent-readiness/scripts/lib/model.ts";
import type { Executor, Executors } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { checkExecutors, mountHint, mountUnseen, openWithMountRetry } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { renderHtml } from "../skill/agent-readiness/scripts/lib/render-html.ts";
import { renderMarkdown } from "../skill/agent-readiness/scripts/lib/render.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { startSession } from "../skill/agent-readiness/scripts/lib/session.ts";
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
