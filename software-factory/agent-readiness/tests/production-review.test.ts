import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { attribute } from "../skill/agent-readiness/scripts/lib/attribute.ts";
import { ContainerSession, OWNER_HOST_LABEL, OWNER_PID_LABEL, PODMAN_REFUSED, RUNTIMES, detectRuntime, hostUser, parseOomKills, removeOrphanedContainers, startArgs } from "../skill/agent-readiness/scripts/lib/container.ts";
import { OOM_MARK, diagnose } from "../skill/agent-readiness/scripts/lib/diagnose.ts";
import { addEvidence } from "../skill/agent-readiness/scripts/lib/evidence.ts";
import { maskSecrets } from "../skill/agent-readiness/scripts/lib/history.ts";
import { maskedNote } from "../skill/agent-readiness/scripts/lib/model.ts";
import { renderMarkdown } from "../skill/agent-readiness/scripts/lib/render.ts";
import type { Executor } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { containerLifetimeSec, environmentLimit, evidenceFromPhase, hostExecutor, newBudget, noRuntimeReason, runContract } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { componentStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import { OWNER_FILE, orphanedTempDirs, removeOrphanedTempDirs } from "../skill/agent-readiness/scripts/lib/teardown.ts";
import type { ContractCommand } from "../skill/agent-readiness/scripts/lib/types.ts";
import { commitAll, materialize, readiness } from "../support/tools/fixture.ts";
import { makeAudit, reportFor } from "./helpers.ts";

// Fixes for blockers B1 to B6 of the offline production-readiness review of 0.2.
const HOST = { SA_READINESS_ALLOW_HOST: "1" };
const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "skill", "agent-readiness", "scripts", "lib");
const runtime = detectRuntime("auto");
const docker = { skip: runtime ? false : "no container runtime: this needs docker", timeout: 5 * 60 * 1000 };
const rubric = loadRubric("2026-12-beta");

// Every file the audit wrote under .agent-readiness/, the sealed audit and the three report files among them.
function recordsText(repo: string): { files: string[]; text: string } {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(join(repo, ".agent-readiness"));
  return { files, text: files.map((f) => readFileSync(f, "utf8")).join("\n") };
}

function sealedDir(repo: string): string {
  const audits = join(repo, ".agent-readiness", "history", "audits");
  return join(audits, readdirSync(audits)[0]);
}

const fakeEx = (output: string, exitCode: number, where: Executor["where"] = "container"): Executor => ({
  where,
  strength: where === "container" ? "clean_replay" : "executed",
  image: where === "container" ? "node:22-bookworm" : null,
  imageSource: where === "container" ? "audit" : null,
  root: mkdtempSync(join(tmpdir(), "ex-")),
  exec: async () => ({ exitCode, timedOut: false, durationMs: 1, output }),
  offline: () => true,
  networkOff: true,
  close: () => {},
});

const build: ContractCommand = { id: "cmd-app-build", kind: "build", component: "app", cwd: ".", command: "npm run build", source: "package.json scripts.build", reason: "build", timeoutSec: 60 };

describe("B1: a registry value never reaches the report through failure text", () => {
  // A shape no pattern knows, as an Artifactory key has, so only the value passed by name redacts it.
  const value = ["AKCp8jQ7x9Zt", "LmN2vB4cR6sT", "1uW3yE5hG8kD"].join("");

  test("a failing install that prints the registry variable's value on its last line", () => {
    const repo = materialize("healthy-node");
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    pkg.scripts.preinstall = 'node -e "console.error(\'login failed for \' + process.env.NPM_TOKEN); process.exit(1)"';
    writeFileSync(join(repo, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    commitAll(repo, "preinstall that echoes the token");
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants", "--registry-env", "NPM_TOKEN"], { ...HOST, NPM_TOKEN: value });
    assert.equal(r.code, 0, r.out);
    const sealed = JSON.parse(readFileSync(join(sealedDir(repo), "audit.json"), "utf8"));
    const install = sealed.evidence.find((e: { kind?: string }) => e.kind === "install");
    assert.equal(install.result, "fail");
    assert.match(install.summary, /login failed for \[redacted:env\]/, "the failure is still explained, with the value masked");
    const { files, text } = recordsText(repo);
    for (const name of ["audit.json", "report.json", "report.md", "report.html"]) assert.ok(files.some((f) => f.endsWith(name)), name);
    assert.ok(!text.includes(value), "no record holds the value");
    assert.ok(!r.out.includes(value), "nor does the CLI's own output");
  });

  test("addEvidence redacts every text the report prints, whichever path built the row", () => {
    const prev = process.env.SA_TEST_REGISTRY_VALUE;
    process.env.SA_TEST_REGISTRY_VALUE = value;
    try {
      const audit = makeAudit({ components: [{ id: "app", share: 1 }] });
      audit.environment.registryEnv = ["SA_TEST_REGISTRY_VALUE"];
      const ev = addEvidence(audit, { checkId: "bootstrap.cold_replay", condition: "clean.build", component: "app", strength: "clean_replay", where: "container", result: "fail", summary: `build failed: ${value}`, blocked: `blocked by ${value}`, diagnosis: { cause: "unknown", detail: value }, attribution: { verdict: "repo", basis: "canary", detail: value } });
      assert.ok(!JSON.stringify(ev).includes(value));
      assert.equal(ev.diagnosis!.detail, "[redacted:env]");
    } finally {
      if (prev === undefined) delete process.env.SA_TEST_REGISTRY_VALUE;
      else process.env.SA_TEST_REGISTRY_VALUE = prev;
    }
  });

  test("runContract reads the cause from the redacted output, so the phase result never holds the value", async () => {
    const [r] = await runContract(fakeEx(`compiling\nerror: upstream refused ${value}\n`, 1), [build], { components: new Set(["app"]), budget: newBudget(10, 10), registryValues: [value] });
    assert.equal(r.status, "fail");
    assert.ok(!r.diagnosis!.detail.includes(value), r.diagnosis!.detail);
  });
});

describe("B2: a secret-shaped string in the repo's own text is masked, not a dead end", () => {
  // Assembled, so this file never holds a token-shaped string.
  const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0", "K1l2M3n4O5p6Q7r8"].join("");

  test("a token in an AGENTS.md example command: the audit seals, masks it, says where, and lists it as a safety finding", () => {
    const repo = materialize("healthy-node");
    writeFileSync(join(repo, "AGENTS.md"), `${readFileSync(join(repo, "AGENTS.md"), "utf8")}- Publish: \`node scripts/build.mjs --token ${token}\`\n`);
    commitAll(repo, "document publishing");
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"], HOST);
    assert.equal(r.code, 0, r.out);
    const { text } = recordsText(repo);
    assert.ok(!text.includes(token), "no record holds the token");
    const sealed = JSON.parse(readFileSync(join(sealedDir(repo), "audit.json"), "utf8"));
    assert.ok(sealed.masked.some((m: { type: string; where: string }) => m.type === "GitHub token" && m.where === "AGENTS.md:8"), JSON.stringify(sealed.masked));
    assert.ok(sealed.instructions.some((i: { text: string }) => i.text.includes("[redacted:GitHub token]")));
    assert.ok(sealed.safety.some((s: { kind: string; file: string }) => s.kind === "secret" && s.file === "AGENTS.md"), "the same value is a safety finding");
    const md = readFileSync(join(repo, ".agent-readiness", "latest", "report.md"), "utf8");
    const about = md.slice(md.indexOf("## About this report"));
    assert.match(about, /\*\*Masked values:\*\* \d+ secret-shaped values? from the repo's own text (was|were) masked as \[redacted:<type>\] before sealing: GitHub token at AGENTS\.md:8/);
    assert.equal(readiness(repo, ["verify-seal"]).code, 0, "the masked audit verifies");
  });

  test("a value passed with --registry-env still refuses the write, naming only the variable", () => {
    const secret = "registry-value-0123456789";
    assert.throws(() => maskSecrets("audit x", { summary: `oops ${secret}` }, [{ name: "NPM_TOKEN", value: secret }]), (e: Error) => /contains the value of NPM_TOKEN/.test(e.message) && !e.message.includes(secret));
  });

  test("masking keeps everything else and says where each value came from", () => {
    const m = maskSecrets("audit x", { instructions: [{ source: "AGENTS.md", line: 3, text: `npx tool --token ${token}` }], contract: [{ source: ".github/workflows/ci.yml:12", command: "npm test", env: { GH_TOKEN: token } }], note: "fine" });
    assert.equal(m.value.note, "fine");
    assert.equal(m.value.instructions[0].text, "npx tool --token [redacted:GitHub token]");
    assert.equal(m.value.contract[0].env.GH_TOKEN, "[redacted:GitHub token]");
    assert.deepEqual(m.masked, [{ type: "GitHub token", where: "AGENTS.md:3" }, { type: "GitHub token", where: ".github/workflows/ci.yml:12" }]);
    assert.match(maskedNote(m.masked), /^2 secret-shaped values from the repo's own text were masked as \[redacted:<type>\] before sealing: GitHub token at AGENTS\.md:3; GitHub token at \.github\/workflows\/ci\.yml:12\./);
  });
});

describe("B3: the audit's memory cap or a full disk is never the repo's failure", () => {
  test("diagnose names each memory and disk limit as a resource limit", () => {
    const cases: [string, number | null, "memory" | "disk", RegExp][] = [
      [`${OOM_MARK}: the kernel stopped a process at the container's 6144 MB memory limit`, 137, "memory", /stopped at the audit's 6,144 MB memory limit/],
      ["<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", 134, "memory", /JavaScript heap out of memory/],
      ['Exception in thread "main" java.lang.OutOfMemoryError: Java heap space', 1, "memory", /OutOfMemoryError/],
      ["Traceback (most recent call last):\n  File \"x.py\", line 1\nMemoryError", 1, "memory", /MemoryError/],
      ["npm error code ENOSPC\nnpm error syscall write\nnpm error nospc ENOSPC: no space left on device, write", 1, "disk", /disk ran out of space/],
      ["cp: error writing 'x': No space left on device", 1, "disk", /disk ran out of space/],
      ["bash: line 1:   312 Killed                  node build.js", 137, "memory", /killed \(exit 137\)/],
    ];
    for (const [output, code, limit, detail] of cases) {
      const d = diagnose(output, false, "build", code);
      assert.equal(d.cause, "resource", output);
      assert.equal(d.limit, limit, output);
      assert.match(d.detail, detail, output);
    }
  });

  test("exit 137 without a kill's words, or a timeout the audit itself killed, isn't a memory limit", () => {
    assert.notEqual(diagnose("Error: expected 2 to equal 3", false, "test", 137).cause, "resource");
    assert.equal(diagnose("Killed", true, "test", null).cause, "timeout");
  });

  test("a build stopped at the memory cap is blocked on this machine with how to raise it, never not met", async () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1 }] });
    const ex = fakeEx(`> build\n${OOM_MARK}: the kernel stopped a process at the container's 6144 MB memory limit\n`, 137);
    const [r] = await runContract(ex, [{ ...build }], { components: new Set(["app"]), budget: newBudget(10, 10), registryValues: [] });
    assert.equal(r.status, "fail");
    assert.match(r.blocked!, /stopped at the audit's 6,144 MB memory limit on this machine; give the container more with `readiness replay --memory <MB>`/);
    audit.contract.push(build);
    const ev = evidenceFromPhase(audit, ex, r, []);
    assert.equal(ev.attribution?.verdict, "environment");
    const s = componentStates(audit, rubric, "app")["clean.build"];
    assert.notEqual(s.state, "not_met", "the repo's build isn't failed by the audit's own limit");
    const report = reportFor(audit);
    assert.notEqual(report.maturity.level === 0 && report.maturity.status === "proven", true, "never a proven Level 0");
  });

  test("on the host and for a full disk, the advice fits the machine", () => {
    const cmd = { ...build };
    assert.match(environmentLimit({ where: "fresh_copy", image: null, imageSource: null }, cmd, diagnose("Killed", false, "build", 137), [])!, /rerun on a machine with more memory$/);
    assert.match(environmentLimit({ where: "container", image: "node:22", imageSource: "audit" }, cmd, diagnose("No space left on device", false, "build", 1), [])!, /free disk space .*TMPDIR/);
  });

  test("a failure no experiment decided, read back from its record, is undetermined", () => {
    const a = attribute({ result: "fail", kind: "test", where: "container", summary: "test failed", outputTail: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory" }, "repo");
    assert.equal(a?.verdict, "undetermined");
  });

  test("an instruction stopped at the memory cap is blocked, not wrong", async () => {
    const d = diagnose(`${OOM_MARK}: the kernel stopped a process at the container's 2048 MB memory limit`, false, "instruction", 137);
    assert.equal(d.cause, "resource");
  });

  test("the cgroup's count is parsed from cgroup v2 and v1", () => {
    assert.equal(parseOomKills("low 0\nhigh 0\nmax 4\noom 1\noom_kill 1\noom_group_kill 0\n"), 1);
    assert.equal(parseOomKills("oom_kill_disable 0\nunder_oom 0\noom_kill 3\n"), 3);
    assert.equal(parseOomKills(""), null);
  });

  test("in a real container, a process over the memory limit is marked and reads as the audit's limit", docker, async () => {
    const work = mkdtempSync(join(tmpdir(), "oom-"));
    chmodSync(work, 0o777);
    const session = new ContainerSession(runtime!, `readiness-oom-${process.pid}`, "node:22-bookworm", work, [], hostUser(), { cpus: null, memoryMb: 256, pids: 256 });
    try {
      assert.ok(session.start().ok);
      const out = await session.exec(`node -e 'const a = []; for (;;) a.push(Buffer.alloc(16 * 1024 * 1024, 1))'`, ".", 120);
      assert.equal(out.exitCode, 137, out.output);
      assert.match(out.output, new RegExp(OOM_MARK));
      const d = diagnose(out.output, out.timedOut, "test", out.exitCode);
      assert.equal(d.cause, "resource");
      assert.match(d.detail, /256 MB memory limit/);
    } finally {
      session.stop();
    }
  });
});

describe("B4: an interrupted or crashed audit leaves nothing behind", () => {
  test("containers remove themselves, end on their own, and name the process that started them", () => {
    const args = startArgs("c", "node:22", "/w");
    assert.ok(args.includes("--rm"));
    assert.ok(!args.includes("infinity"), "never sleep infinity");
    assert.deepEqual(args.slice(-2), ["sleep", String(4 * 3600)]);
    assert.ok(args.includes(`${OWNER_PID_LABEL}=${process.pid}`));
    assert.ok(args.some((a) => a.startsWith(`${OWNER_HOST_LABEL}=`)));
    assert.equal(startArgs("c", "node:22", "/w", null, {}, () => false, containerLifetimeSec(60)).at(-1), String(180 * 60), "the whole budget plus the setup allowance");
  });

  test("on SIGTERM, a host-mode run's process group, its throwaway home and its temp folders are removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "teardown-"));
    const script = join(dir, "run.ts");
    writeFileSync(
      script,
      [
        `import { scrubbedEnv, runCommand } from ${JSON.stringify(join(LIB, "run.ts"))};`,
        `import { tempDir } from ${JSON.stringify(join(LIB, "teardown.ts"))};`,
        "const t = tempDir('readiness-replay-');",
        "const env = scrubbedEnv({});",
        "void runCommand('sleep 300 & echo $! > ' + JSON.stringify(t.path + '/pid') + '; wait', '/', env, 600);",
        "setTimeout(() => { console.log(JSON.stringify({ dir: t.path, home: env.HOME })); }, 500);",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script], { stdio: ["ignore", "pipe", "inherit"] });
    const seen: { dir: string; home: string } = await new Promise((resolve) => child.stdout.once("data", (b: Buffer) => resolve(JSON.parse(b.toString()))));
    const sleeper = Number(readFileSync(join(seen.dir, "pid"), "utf8"));
    assert.ok(existsSync(seen.home) && existsSync(seen.dir));
    const code: number | null = await new Promise((resolve) => {
      child.once("exit", (c) => resolve(c));
      child.kill("SIGTERM");
    });
    assert.equal(code, 143, "it exits as SIGTERM would");
    assert.ok(!existsSync(seen.dir), "the replay copy is gone");
    assert.ok(!existsSync(seen.home), "the throwaway home is gone");
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => process.kill(sleeper, 0), /ESRCH/, "the repo command's process group is gone");
  });

  test("on SIGINT, the audit's container is removed", docker, async () => {
    const dir = mkdtempSync(join(tmpdir(), "teardown-c-"));
    const name = `readiness-teardown-${process.pid}`;
    const script = join(dir, "run.ts");
    writeFileSync(
      script,
      [
        `import { ContainerSession, detectRuntime } from ${JSON.stringify(join(LIB, "container.ts"))};`,
        `const s = new ContainerSession(detectRuntime('auto')!, ${JSON.stringify(name)}, 'node:22-bookworm', ${JSON.stringify(dir)}, [], null);`,
        "if (!s.start().ok) process.exit(3);",
        "console.log('started');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve) => child.stdout.once("data", resolve));
    const running = () => spawnSync(runtime!.bin, ["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.trim();
    assert.equal(running(), name);
    const code: number | null = await new Promise((resolve) => {
      child.once("exit", (c) => resolve(c));
      child.kill("SIGINT");
    });
    assert.equal(code, 130);
    assert.equal(running(), "", "no container is left running");
  });

  test("init and replay remove temp folders and containers whose process is gone, whatever their age", docker, () => {
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
    const root = mkdtempSync(join(tmpdir(), "orphans-"));
    const orphan = join(root, "readiness-replay-old");
    const live = join(root, "readiness-replay-live");
    const other = join(root, "readiness-replay-elsewhere");
    for (const [d, pid, host] of [[orphan, Number(gone), hostname()], [live, process.pid, hostname()], [other, Number(gone), "another-machine"]] as const) {
      mkdirSync(d);
      writeFileSync(join(d, OWNER_FILE), JSON.stringify({ pid, host }));
    }
    assert.deepEqual(orphanedTempDirs(root), [orphan]);
    assert.deepEqual(removeOrphanedTempDirs(root), [`temp folder ${orphan}`]);
    assert.ok(!existsSync(orphan) && existsSync(live) && existsSync(other), "a live owner's folder, or another machine's, stays");
    const name = `readiness-orphan-${process.pid}`;
    assert.equal(spawnSync(runtime!.bin, ["run", "-d", "--name", name, "--label", `${OWNER_PID_LABEL}=${gone}`, "--label", `${OWNER_HOST_LABEL}=${hostname()}`, "node:22-bookworm", "sleep", "300"]).status, 0);
    // Another test file's replay may reap it first, which is the point: only that it's gone matters.
    removeOrphanedContainers();
    assert.equal(spawnSync(runtime!.bin, ["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.trim(), "");
  });

  test("a refused `readiness run` makes no copy of the repo, and a host executor removes its home when it closes", async () => {
    const repo = materialize("healthy-node");
    const tmp = mkdtempSync(join(tmpdir(), "tmpdir-"));
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"], { TMPDIR: tmp }).code, 0);
    assert.equal(readiness(repo, ["scan"], { TMPDIR: tmp }).code, 0);
    const r = readiness(repo, ["run"], { TMPDIR: tmp, SA_READINESS_ALLOW_HOST: "" });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /needs the user's yes first/);
    assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith("readiness-scratch-") || n.startsWith("readiness-home-")), []);
    const ex = hostExecutor(mkdtempSync(join(tmpdir(), "h-")), [], false, "fresh_copy", true);
    const home = (await ex.exec("printf %s \"$HOME\"", ".", 10)).output;
    assert.match(home, /readiness-home-/);
    assert.ok(existsSync(home));
    ex.close();
    assert.ok(!existsSync(home), "the throwaway home, with its package caches, is removed");
  });

  test("a declared image that doesn't build leaves no replay copy behind", docker, () => {
    const repo = materialize("healthy-node");
    mkdirSync(join(repo, ".cursor"), { recursive: true });
    writeFileSync(join(repo, ".cursor", "Dockerfile"), "FROM scratch\nRUN false\n");
    writeFileSync(join(repo, ".cursor", "environment.json"), JSON.stringify({ build: { dockerfile: "Dockerfile", context: ".." } }));
    commitAll(repo, "declared image that can't build");
    const tmp = mkdtempSync(join(tmpdir(), "tmpdir-"));
    chmodSync(tmp, 0o777);
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"], { TMPDIR: tmp }).code, 0);
    assert.equal(readiness(repo, ["scan"], { TMPDIR: tmp }).code, 0);
    const r = readiness(repo, ["replay", "--no-mutants"], { TMPDIR: tmp });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /declared environment image didn't build/);
    assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith("readiness-replay-")), []);
  });
});

describe("B5: Podman is neither picked nor recommended", () => {
  test("auto tries Docker only, and --runtime podman is refused", () => {
    assert.deepEqual(RUNTIMES, ["auto", "docker", "none"]);
    assert.throws(() => detectRuntime("podman"), (e: Error) => e.message === PODMAN_REFUSED);
    const bin = mkdtempSync(join(tmpdir(), "podman-only-"));
    writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 1\n");
    writeFileSync(join(bin, "podman"), "#!/bin/sh\necho 5.0.0\n");
    chmodSync(join(bin, "docker"), 0o755);
    chmodSync(join(bin, "podman"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      assert.equal(detectRuntime("auto"), null, "a machine with only Podman has no runtime the audit uses");
    } finally {
      process.env.PATH = path;
    }
    assert.equal(noRuntimeReason("auto"), "no container runtime on this machine: docker info didn't answer");
  });

  test("no report text recommends Podman", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "not_run", where: "fresh_copy" }] });
    audit.environment.containerRuntime = null;
    audit.evidence = audit.evidence.map((e) => ({ ...e, where: "fresh_copy" as const, strength: "executed" as const, result: "not_run" as const, blocked: "no container runtime on this machine: docker info didn't answer" }));
    const report = reportFor(audit);
    const md = renderMarkdown(report, loadRubric(audit.rubric));
    assert.doesNotMatch(JSON.stringify(report) + md, /Podman/);
    assert.match(md, /Docker/);
    for (const f of ["model.ts", "render.ts", "render-html.ts"]) assert.doesNotMatch(readFileSync(join(LIB, f), "utf8"), /Docker or Podman/, f);
    assert.doesNotMatch(readFileSync(join(LIB, "..", "..", "references", "report.md"), "utf8"), /Docker or Podman/);
  });
});
