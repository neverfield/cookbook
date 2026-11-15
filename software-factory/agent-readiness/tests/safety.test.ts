import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CAPS_ADDED, ContainerSession, detectRuntime, execArgs, hostUser, killCommand, limitsFor, reclaimCommand, startArgs } from "../skill/agent-readiness/scripts/lib/container.ts";
import { addContractCommand, commandKind, discoverContract, nodeMajor, rootTestRunner } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { IMAGE_DIGESTS, pinnedRef } from "../skill/agent-readiness/scripts/lib/images.ts";
import { componentLevel, repoLevel } from "../skill/agent-readiness/scripts/lib/levels.ts";
import { buildProfile } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { EXAMPLE_KEYS, proxyPasswords, redact, scanText } from "../skill/agent-readiness/scripts/lib/redact.ts";
import { ALLOW_HOST_ENV, HOST_NOT_ALLOWED, assertPlatformSupported, copyWorkTree, failingComponents, hostExecutor, killRate, newBudget, runContract, unavailableExecutor } from "../skill/agent-readiness/scripts/lib/replay.ts";
import type { Executor } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import type { Rubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { ACCOUNT_CREDENTIAL, scrubbedEnv } from "../skill/agent-readiness/scripts/lib/run.ts";
import { componentStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import type { ContractCommand } from "../skill/agent-readiness/scripts/lib/types.ts";
import { commitAll, materialize, readiness } from "../support/tools/fixture.ts";
import { makeAudit } from "./helpers.ts";

const rubric = loadRubric();
const HOST = { [ALLOW_HOST_ENV]: "1" };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "readiness-safety-"));
}

function tree(files: Record<string, string>): string {
  const dir = tmp();
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Contributor A", "-c", "user.email=a@example.com", "commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

function cmd(id: string, kind: ContractCommand["kind"], command: string, component = "app"): ContractCommand {
  return { id, kind, component, cwd: ".", command, source: "readiness", reason: kind, timeoutSec: 60 };
}

function audited(repo: string, args: string[], env: Record<string, string> = {}) {
  const r = readiness(repo, ["audit", "--tier", "local-exec", ...args], env);
  const report = existsSync(join(repo, ".agent-readiness/latest/report.json")) ? JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8")) : null;
  const audit = report ? JSON.parse(readFileSync(join(repo, ".agent-readiness/history/audits", report.audit.id, "audit.json"), "utf8")) : null;
  return { ...r, report, audit };
}

const runtime = detectRuntime("auto");

describe("no silent host fallback: without a container nothing runs, and the result is unproven", () => {
  test("no container runtime and no yes: every command is not run, blocked, and the report explains it", () => {
    const repo = materialize("healthy-node");
    const { code, out, report, audit } = audited(repo, ["--runtime", "none"]);
    assert.equal(code, 0, out);
    assert.equal(audit.state, "sealed");
    assert.deepEqual(audit.evidence.filter((e: { where: string }) => e.where === "host" || e.where === "fresh_copy"), [], "nothing ran on the host");
    assert.ok(audit.evidence.every((e: { exitCode?: number | null }) => e.exitCode === undefined || e.exitCode === null), "no command has an exit code");
    const install = audit.evidence.find((e: { kind?: string }) => e.kind === "install");
    assert.deepEqual([install.result, install.blocked], ["not_run", HOST_NOT_ALLOWED]);
    assert.equal(audit.environment.notRun, HOST_NOT_ALLOWED);
    assert.equal(audit.environment.hostMode, undefined);
    assert.equal(report.maturity.unproven, true);
    assert.notEqual(report.maturity.outcome, "not_assessed", "unproven is not the same as not assessed");
    assert.match(report.executive.heading, /^Level 1 unproven on this machine/);
    assert.match(report.executive.headline, /A rerun where Docker or Podman is available, such as CI, can prove it\./);
    assert.ok(report.components.included.every((c: { unproven: boolean }) => c.unproven));
    assert.ok(report.maturity.capReasons.length > 0 && report.maturity.capReasons.every((c: { state: string; reason: string }) => c.state === "blocked" && c.reason.length > 0), "every cap names its reason");
    assert.ok(report.maturity.capReasons.some((c: { reason: string }) => c.reason.includes(HOST_NOT_ALLOWED)));
  });

  test("a container that doesn't start is unproven with the runtime's error, never a host run", { skip: runtime ? false : "no container runtime" }, () => {
    const repo = materialize("healthy-node");
    const { code, out, report, audit } = audited(repo, ["--image", "node:12-bookworm", "--no-mutants"]);
    assert.equal(code, 0, out);
    assert.deepEqual(audit.evidence.filter((e: { where: string }) => e.where === "host" || e.where === "fresh_copy"), []);
    assert.match(audit.environment.notRun, /^the audit's (docker|podman) container \(node:12-bookworm\) didn't start: .+, and host mode wasn't allowed/);
    assert.doesNotMatch(audit.environment.notRun, /--help/, "the runtime's help hint isn't the error");
    assert.equal(report.maturity.unproven, true);
    assert.ok(report.maturity.capReasons.every((c: { reason: string }) => /didn't start/.test(c.reason)));
  });

  test("host mode runs only with the user's yes, and the report says it can read local files", () => {
    const repo = materialize("healthy-node");
    const { code, out, report, audit } = audited(repo, ["--runtime", "none", "--no-mutants"], HOST);
    assert.equal(code, 0, out);
    assert.equal(audit.environment.hostMode, true);
    assert.ok(audit.evidence.some((e: { where: string; result: string }) => e.where === "fresh_copy" && e.result === "pass"));
    const note = audit.safety.find((s: { kind: string }) => s.kind === "host_mode");
    assert.ok(note && !note.blocking, "host mode is listed for review, not blocking");
    assert.match(note.detail, /could read this user's local files; it isn't a sandbox/);
    assert.ok(report.maturity.capReasons.some((c: { reason: string }) => /could read its local files, so it isn't a sandbox/.test(c.reason)), "the report says host mode isn't a sandbox");
    assert.equal(report.maturity.unproven, true, "host mode never proves Level 1");
  });

  test("hostExecutor refuses without the yes, so `readiness run` needs it too", () => {
    const before = process.env[ALLOW_HOST_ENV];
    delete process.env[ALLOW_HOST_ENV];
    try {
      assert.throws(() => hostExecutor(tmp(), [], false), /needs the user's yes first/);
      assert.equal(hostExecutor(tmp(), [], false, "host", true).where, "host");
    } finally {
      if (before !== undefined) process.env[ALLOW_HOST_ENV] = before;
    }
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"]).code, 0);
    assert.equal(readiness(repo, ["scan"]).code, 0);
    const refused = readiness(repo, ["run", "--component", "healthy-node"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--allow-host/);
  });

  test("an unavailable executor records every command as not run with its reason, and runs no fallback install", async () => {
    const ex = unavailableExecutor(tmp(), "no container runtime here");
    const results = await runContract(ex, [cmd("i", "install", "npm ci", "*"), { ...cmd("f", "install", "npm ci"), fallbackFor: "i" }, cmd("t", "test", "npm test")], { components: new Set(["app"]), budget: newBudget(10, 10), registryValues: [] });
    assert.deepEqual(results.map((r) => [r.cmd.id, r.status, r.blocked]), [["i", "not_run", "no container runtime here"], ["t", "not_run", "no container runtime here"]]);
  });

  test("the audit runs on Linux, macOS and cloud agents, and stops on native Windows", () => {
    assert.doesNotThrow(() => assertPlatformSupported("linux"));
    assert.doesNotThrow(() => assertPlatformSupported("darwin"));
    assert.throws(() => assertPlatformSupported("win32"), (e: Error) => /native Windows/.test(e.message) && /WSL 2/.test(e.message) && e.message.includes("supported.md"));
  });
});

describe("host mode's environment", () => {
  test("a throwaway home, and no cloud, GitHub or SSH credentials even with --inherit-env", () => {
    process.env.GH_TOKEN = "gh-secret-value";
    process.env.GITHUB_TOKEN = "github-secret-value";
    process.env.NODE_ENV = "plain";
    try {
      for (const inheritEnv of [false, true]) {
        const env = scrubbedEnv({ inheritEnv });
        assert.notEqual(env.HOME, homedir(), `inheritEnv ${inheritEnv}: HOME is a throwaway`);
        assert.ok(env.HOME.startsWith(tmpdir()));
        assert.equal(env.GH_TOKEN, undefined);
        assert.equal(env.GITHUB_TOKEN, undefined);
        assert.ok(env.npm_config_store_dir.startsWith(env.HOME), "pnpm's store stays out of the work tree");
      }
      assert.equal(scrubbedEnv({ inheritEnv: true }).NODE_ENV, "plain", "--inherit-env still passes ordinary variables");
      for (const name of ["AWS_SECRET_ACCESS_KEY", "AZURE_CLIENT_SECRET", "SSH_AUTH_SOCK", "GOOGLE_APPLICATION_CREDENTIALS", "KUBECONFIG"]) assert.ok(ACCOUNT_CREDENTIAL.test(name), name);
      assert.equal(scrubbedEnv({ inheritEnv: true, registryEnv: ["GH_TOKEN"] }).GH_TOKEN, "gh-secret-value", "a credential named in --registry-env is passed");
    } finally {
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.NODE_ENV;
    }
  });

  test("registry variables reach the setup steps only", async () => {
    process.env.NPM_TOKEN = "registry-value";
    try {
      const ex = hostExecutor(tmp(), ["NPM_TOKEN"], false, "host", true);
      const setup = await ex.exec('echo "token=${NPM_TOKEN:-none}"', ".", 30, { registry: true });
      const other = await ex.exec('echo "token=${NPM_TOKEN:-none}"', ".", 30);
      assert.match(setup.output, /token=registry-value/);
      assert.match(other.output, /token=none/);
      const seen: { command: string; registry?: boolean }[] = [];
      const rec: Executor = { ...unavailableExecutor(tmp(), "x"), unavailable: undefined, exec: async (command, _c, _t, opts) => (seen.push({ command, registry: opts?.registry }), { exitCode: 0, timedOut: false, durationMs: 1, output: "" }) };
      await runContract(rec, [cmd("d", "doctor", "node --version", "*"), cmd("i", "install", "npm ci", "*"), cmd("b", "build", "npm run build"), cmd("t", "test", "npm test")], { components: new Set(["app"]), budget: newBudget(10, 10), registryValues: [] });
      assert.deepEqual(seen.map((s) => [s.command, Boolean(s.registry)]), [["node --version", true], ["npm ci", true], ["npm run build", false], ["npm test", false]]);
    } finally {
      delete process.env.NPM_TOKEN;
    }
  });
});

describe("containers", () => {
  test("every capability is dropped but setup's few, privileges can't grow, and CPU, memory and processes are limited", () => {
    const args = startArgs("c", "node:22-bookworm", "/w", limitsFor(8, 32 * 1024 ** 3), {});
    assert.ok(args.includes("--cap-drop=ALL"));
    assert.deepEqual(args.filter((a) => a.startsWith("--cap-add=")), CAPS_ADDED.map((c) => `--cap-add=${c}`));
    assert.ok(!CAPS_ADDED.some((c) => /SYS_ADMIN|NET_RAW|MKNOD|SYS_PTRACE|NET_ADMIN/.test(c)));
    const pairs = args.map((a, i) => `${a} ${args[i + 1]}`);
    assert.ok(pairs.includes("--security-opt no-new-privileges"));
    assert.ok(pairs.includes("--cpus 6") && pairs.includes("--memory 16384m") && pairs.includes("--memory-swap 16384m") && pairs.includes("--pids-limit 4096"), args.join(" "));
    assert.ok(args.includes(`node:22-bookworm@${IMAGE_DIGESTS["node:22-bookworm"]}`), "the audit's image is pulled by digest");
    assert.equal(pinnedRef("readiness-env-abc"), "readiness-env-abc", "a repo's own image is used as built");
    assert.deepEqual(limitsFor(null, null), { cpus: null, memoryMb: 8192, pids: 4096 }, "with no figures from the runtime, no CPU limit that could fail the start");
    assert.equal(limitsFor(2, 2 * 1024 ** 3).memoryMb, 2048, "never below 2 GiB");
  });

  test("the pinned images are multi-arch index digests for every image the audit picks", () => {
    for (const [tag, digest] of Object.entries(IMAGE_DIGESTS)) assert.match(digest, /^sha256:[0-9a-f]{64}$/, tag);
    for (const m of [16, 18, 20, 22, 24, 26]) assert.ok(IMAGE_DIGESTS[`node:${m}-bookworm`], `node ${m}`);
  });

  test("engines that name a Node with no image get the nearest LTS, and open ranges the default", () => {
    assert.equal(nodeMajor(">=12.20.0", false), 22, "zustand's range runs on the default LTS");
    assert.equal(nodeMajor(">=12", false), 22);
    assert.equal(nodeMajor("12", true), 16, ".nvmrc 12 has no image: the nearest newer LTS");
    assert.equal(nodeMajor("v14.17.0", true), 16);
    assert.equal(nodeMajor("18", true), 18);
    assert.equal(nodeMajor("^18.0.0", false), 18);
    assert.equal(nodeMajor(">=18 <21", false), 20);
    assert.equal(nodeMajor(">=24", false), 24);
    assert.equal(nodeMajor("^14 || ^16 || >=18", false), 22);
    assert.equal(nodeMajor("lts/hydrogen", true), 18);
    assert.equal(nodeMajor("lts/*", true), 22);
    assert.equal(nodeMajor("23", true), 24, "an odd major without a pinned image gets the next LTS");
  });

  test("root-owned files go back to the user one by one, never through a link", () => {
    const c = reclaimCommand("1000:1000", ["/work"]);
    assert.match(c, /^find \/work -xdev -uid 0 -exec chown -h 1000:1000 \{\} \+/);
    assert.doesNotMatch(c, /chown -R/);
    assert.match(killCommand("abc123"), /SA_READINESS_EXEC=abc123/);
    assert.deepEqual(execArgs("c", "npm test", ".", null, [], "abc123").slice(0, 5), ["exec", "-w", "/work", "-e", "SA_READINESS_EXEC=abc123"]);
  });

  test("in a real container: the limits hold, a timed-out command is killed inside it, and stop leaves nothing root-owned", { skip: runtime ? false : "no container runtime", timeout: 180000 }, async () => {
    const work = tmp();
    writeFileSync(join(work, "keep.txt"), "x");
    const session = new ContainerSession(runtime!, `readiness-safety-${process.pid}`, "node:22-bookworm", work, [], hostUser(), limitsFor(4, 8 * 1024 ** 3));
    const started = session.start();
    assert.ok(started.ok, started.output);
    try {
      const caps = await session.exec("grep CapEff /proc/self/status; cat /sys/fs/cgroup/pids.max /sys/fs/cgroup/memory.max", ".", 30);
      assert.match(caps.output, /CapEff:\s+0+\n/, "the repo's commands hold no capability");
      assert.match(caps.output, /\n4096\n/);
      assert.match(caps.output, /\n6442450944\n?$/);
      const slow = await session.exec("sleep 300 & sleep 300", ".", 2);
      assert.equal(slow.timedOut, true);
      const left = await session.exec("for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c '^sleep 300' || true", ".", 30);
      assert.equal(left.output.trim(), "0", "the timed-out command's processes are gone");
      session.asImageUser("mkdir -p /work/root-made && touch /work/root-made/f && ln -sf /etc/hostname /work/link");
      if (session.user) {
        session.asImageUser(reclaimCommand(session.user, ["/work"]));
        const owner = await session.exec("stat -c %u /work/root-made/f /etc/hostname", ".", 30);
        assert.deepEqual(owner.output.trim().split("\n"), [session.user.split(":")[0], "0"], "the file is handed back and the link's target isn't");
      }
    } finally {
      session.stop();
    }
    assert.ok(!existsSync(join(work, "root-made")) && !existsSync(join(work, "keep.txt")), "stop empties the throwaway tree from inside the container");
    assert.equal(spawnSync(runtime!.bin, ["inspect", `readiness-safety-${process.pid}`]).status, 1, "the container is gone");
  });
});

describe("secret scanning", () => {
  test("unquoted .env values and real connection strings are caught and redacted", () => {
    const env = "API_KEY=9f8e7d6c5b4a39281706\nexport DB_PASSWORD=Zq8!rT2vLm0pWx\nDEBUG=true\nSECRET_KEY=$FROM_VAULT\nAPI_TOKEN=your-token-here\n";
    assert.deepEqual(scanText(env).map((h) => h.line), [1, 2]);
    const red = redact(env);
    assert.ok(!red.includes("9f8e7d6c5b4a39281706") && !red.includes("Zq8!rT2vLm0pWx"), red);
    assert.match(red, /DEBUG=true/);
    const urls = ["DATABASE_URL=postgres://app:s3cr3tPassw0rd@db.prod.acme-corp.io:5432/app", "redis://default:hunter2hunter2@cache.acme-corp.io:6379"];
    assert.deepEqual(scanText(urls.join("\n")).map((h) => [h.line, h.type]), [[1, "Connection string with a password"], [2, "Connection string with a password"]]);
    for (const u of urls) assert.ok(!redact(u).includes(u.match(/:([^:@/]+)@/)![1]), u);
  });

  test("local development URLs and placeholders aren't findings", () => {
    const local = ["postgres://postgres:postgres@localhost:5432/dev", "postgresql://app:devpassword123@db:5432/app", "mongodb://root:example@mongo:27017", "amqp://guest:guest@127.0.0.1:5672", "https://user:${PASSWORD}@registry.acme-corp.io", "postgres://user:password@db.example.com/x"];
    assert.deepEqual(scanText(local.join("\n")), []);
  });

  test("a proxy URL's password is redacted from output", () => {
    assert.deepEqual(proxyPasswords({ HTTPS_PROXY: "http://alice:p%40ss-w0rd@proxy.corp:3128", NO_PROXY: "localhost" }, ["HTTPS_PROXY", "NO_PROXY"]), ["p@ss-w0rd", "p%40ss-w0rd"]);
    assert.equal(redact("CONNECT via http://alice:Sup3rS3cret@proxy.corp:3128 failed"), "CONNECT via http://alice:[redacted:password]@proxy.corp:3128 failed");
    assert.equal(redact("auth failed for p@ss-w0rd", ["p@ss-w0rd"]), "auth failed for [redacted:env]");
  });

  test("documented example keys are marked as examples, so the static check can let them through", () => {
    for (const key of EXAMPLE_KEYS) assert.ok(scanText(`aws_secret = "${key}"`).every((h) => h.example), key);
    const [hit] = scanText("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
    assert.deepEqual([hit.type, hit.example], ["AWS access key", true]);
    assert.equal(scanText("key AKIAZ7QX3P5T2MNB8KQW").at(0)?.example, undefined, "a real-shaped key isn't an example");
  });
});

describe("contract: kinds, root runners and failures by package", () => {
  test("--kind type-check is a type-check, and an unknown kind is refused with the list", () => {
    assert.equal(commandKind("type-check"), "typecheck");
    assert.equal(commandKind("Typecheck"), "typecheck");
    assert.throws(() => commandKind("unit"), /--kind unit isn't a kind the audit runs\. Use one of: doctor, install, build, lint, typecheck, test, start\./);
    const dir = tree({ "package.json": JSON.stringify({ name: "app", scripts: { "types:check": "tsc", test: "node --test" } }), "package-lock.json": "{}" });
    const profile = buildProfile(dir, dir, rubric);
    const cmds = discoverContract(profile, dir, rubric, []);
    const added = addContractCommand(cmds, { kind: "type-check", component: profile.components[0].id, cwd: ".", command: "npm run types:check", source: "agent", reason: "CI type-checks" }, profile);
    assert.equal(added.kind, "typecheck");
  });

  test("a root vitest run is credited to each package that has tests, scoped to its folder", () => {
    const dir = tree({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"], scripts: { test: "vitest", build: "tsdown" } }),
      "package-lock.json": "{}",
      "packages/cli/package.json": JSON.stringify({ name: "@acme/cli", version: "1.0.0" }),
      "packages/cli/src/index.ts": "export const a = 1;\n",
      "packages/cli/src/index.test.ts": "import { a } from './index';\n",
      "packages/write/package.json": JSON.stringify({ name: "@acme/write", version: "1.0.0", scripts: { test: "jest" } }),
      "packages/write/src/index.ts": "export const b = 1;\n",
      "packages/write/src/index.test.ts": "\n",
      "packages/docs/package.json": JSON.stringify({ name: "@acme/docs", version: "1.0.0" }),
      "packages/docs/src/page.ts": "export const c = 1;\n",
    });
    assert.deepEqual(rootTestRunner(dir), { script: "test", runner: "vitest" });
    const profile = buildProfile(dir, dir, rubric);
    const tests = discoverContract(profile, dir, rubric, []).filter((c) => c.kind === "test");
    const byComp = Object.fromEntries(tests.map((c) => [profile.components.find((x) => x.id === c.component)!.path, [c.cwd, c.command]]));
    assert.deepEqual(byComp["packages/cli"], [".", "npm run test -- packages/cli"]);
    assert.deepEqual(byComp["packages/write"], ["packages/write", "npm run test"], "a package's own test script wins");
    assert.equal(byComp["packages/docs"], undefined, "a package with no test files isn't credited");
    assert.equal(rootTestRunner(tree({ "package.json": JSON.stringify({ scripts: { test: "vitest && tsd" } }) })), null, "a chained script isn't narrowed");
  });

  test("a repo-wide run's failures are pinned on the packages whose files failed", () => {
    const comps = [{ id: "cli", path: "packages/cli" }, { id: "write", path: "packages/write" }];
    assert.deepEqual(failingComponents(" FAIL  packages/write/src/index.test.ts > writes\n ✓ packages/cli/src/a.test.ts", ".", comps), ["write"]);
    assert.deepEqual(failingComponents("packages/cli/src/a.ts(3,7): error TS2322: nope", ".", comps), ["cli"]);
    assert.deepEqual(failingComponents("/work/packages/write/src/x.ts\n  3:1  error  no-undef\n", ".", comps), ["write"]);
    assert.equal(failingComponents(" FAIL  scripts/check.test.ts", ".", comps), null, "a failure outside every component counts against all");
    assert.equal(failingComponents("Error: something broke", ".", comps), null);
    const audit = makeAudit({ components: [{ id: "cli", share: 0.5, test: "missing" }, { id: "write", share: 0.5, test: "missing" }] });
    audit.contract.push({ id: "cmd-repo-test", kind: "test", component: "*", cwd: ".", command: "npm test", source: "package.json scripts.test", reason: "root", timeoutSec: 600 });
    audit.evidence.push({ id: "ev-090", checkId: "bootstrap.cold_replay", condition: "clean.test", component: "*", kind: "test", contractId: "cmd-repo-test", strength: "clean_replay", where: "container", result: "fail", summary: "test failed; every failure is in write", failedIn: ["write"], at: audit.createdAt });
    assert.equal(componentStates(audit, rubric, "cli")["clean.test"].state, "met");
    assert.match(componentStates(audit, rubric, "cli")["clean.test"].reason, /^the repo-wide test passes for cli: every failure is in write$/);
    assert.equal(componentStates(audit, rubric, "write")["clean.test"].state, "not_met");
  });

  test("a lint that failed before the build runs again once any build it depends on passed, and the root build runs first", async () => {
    const ran: string[] = [];
    const ex: Executor = { ...unavailableExecutor(tmp(), "x"), unavailable: undefined, exec: async (command) => (ran.push(command), { exitCode: command === "docs build" || (command === "lint" && ran.filter((c) => c === "lint").length === 1) ? 1 : 0, timedOut: false, durationMs: 1, output: "" }) };
    const results = await runContract(ex, [cmd("bd", "build", "docs build", "docs"), cmd("br", "build", "root build", "*"), cmd("l", "lint", "lint", "*")], { components: new Set(["docs"]), budget: newBudget(10, 10), registryValues: [] });
    assert.deepEqual(ran, ["lint", "root build", "docs build", "lint"]);
    assert.deepEqual(results.filter((r) => r.cmd.kind === "lint").map((r) => [r.status, r.note]), [["pass", "failed before the build and passed after it"]]);
  });
});

describe("levels: unproven is a result of its own", () => {
  test("every Level 1 condition left blocked and none failed is unproven, not Level 0", () => {
    const blocked = componentLevel(rubric, { "clean.install": "blocked", "clean.build": "blocked", "clean.test": "blocked" });
    assert.deepEqual([blocked.level, blocked.couldBe, blocked.unproven], [0, 1, true]);
    const failed = componentLevel(rubric, { "clean.install": "blocked", "clean.build": "blocked", "clean.test": "not_met" });
    assert.equal(failed.unproven, undefined, "a failing Level 1 condition is a real Level 0");
    const notRun = componentLevel(rubric, { "clean.install": "met", "clean.build": "met", "clean.test": "unknown" });
    assert.equal(notRun.unproven, undefined, "a check that simply didn't run isn't blamed on the machine");
    const repo = repoLevel(new Map([["a", blocked], ["b", { level: 2, couldBe: null, missing: [], unknown: [] }]]), new Set(["a", "b"]));
    assert.deepEqual([repo.level, repo.unproven], [0, true]);
    assert.equal(repoLevel(new Map([["a", blocked], ["b", failed]]), new Set(["a", "b"])).unproven, undefined);
  });

  test("the kill rate defaults to every fault until a rubric sets it", () => {
    assert.equal(killRate(rubric), 1);
    assert.equal(killRate({ ...rubric, mutation: { ...rubric.mutation, killRate: 0.8 } } as Rubric), 0.8);
    assert.equal(killRate({ ...rubric, mutation: { ...rubric.mutation, killRate: 7 } } as Rubric), 1, "an impossible rate falls back");
  });
});

describe("committed symlinks", () => {
  test("the work copy keeps a relative link relative, so it resolves inside the container", () => {
    const from = tmp();
    mkdirSync(join(from, "src"));
    writeFileSync(join(from, "src", "a.js"), "export const a = 1;\n");
    symlinkSync("src", join(from, "lib"));
    symlinkSync("../src/a.js", join(from, "src-a.js"));
    const to = join(tmp(), "work");
    copyWorkTree(from, to);
    assert.equal(readlinkSync(join(to, "lib")), "src");
    assert.equal(readlinkSync(join(to, "src-a.js")), "../src/a.js");
  });

  test("tests that import through a committed relative symlink pass in a clean container", { skip: runtime ? false : "no container runtime", timeout: 600000 }, () => {
    const repo = materialize("healthy-node");
    symlinkSync("src", join(repo, "lib"));
    writeFileSync(join(repo, "test", "link.test.js"), 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { isAdult } from "../lib/pricing.js";\n\ntest("the linked module loads", () => {\n  assert.equal(isAdult(18), true);\n});\n');
    commitAll(repo, "Import through a relative symlink");
    const { code, out, audit, report } = audited(repo, ["--no-mutants"]);
    assert.equal(code, 0, out);
    assert.equal(audit.environment.containerRuntime, runtime!.bin);
    const t = audit.evidence.find((e: { kind?: string }) => e.kind === "test");
    assert.equal(t.result, "pass", t.summary);
    assert.equal(report.components.included[0].level, 1, "Level 1; Level 2 needs the planted faults this run skips");
  });
});
