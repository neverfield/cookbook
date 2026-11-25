import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { canCutNetwork, detectDisposableVm, parseCanary, provesIn, runCanary } from "../skill/agent-readiness/scripts/lib/proofenv.ts";
import type { VmDetection } from "../skill/agent-readiness/scripts/lib/proofenv.ts";
import { NETWORK_ON, checkExecutors, evidenceFromPhase, hostExecutor, newBudget, recordNetwork, replay, runContract, vmExecutor } from "../skill/agent-readiness/scripts/lib/replay.ts";
import type { Executor, Executors } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { latestRubricVersion, loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { componentStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import type { Audit } from "../skill/agent-readiness/scripts/lib/types.ts";
import { loadDraft, saveDraft } from "../skill/agent-readiness/scripts/lib/workspace.ts";
import { materialize, readiness } from "../support/tools/fixture.ts";
import { makeAudit } from "./helpers.ts";

const rubric = loadRubric();
const CLOUD_VM: VmDetection = { kind: "cursor_cloud_agent", label: "a Cursor Cloud Agent VM", signals: ["/exec-daemon", "CLOUD_AGENT_INJECTED_SECRET_NAMES"] };

const one = (ex: Executor): Executors => ({ groups: [{ ex, components: ["app"], repoWide: true }], forComponent: () => ex, repo: ex, close: () => ex.close() });

// An executor that answers from a script, as a runtime that misbehaves would.
function fake(where: Executor["where"], answer: (command: string) => { exitCode: number; output: string }, offline = true): Executor {
  const ex: Executor = {
    where,
    strength: where === "container" ? "clean_replay" : "executed",
    image: where === "container" ? "node:22-bookworm" : null,
    imageSource: where === "container" ? "audit" : null,
    root: mkdtempSync(join(tmpdir(), "proofenv-fake-")),
    exec: (command) => Promise.resolve({ ...answer(command), timedOut: false, durationMs: 1 }),
    offline: () => (ex.networkOff = offline),
    networkOff: null,
    close: () => {},
    runUser: "1000",
  };
  return ex;
}

const CANARY_OK = "readiness-canary mount_visible ok\nreadiness-canary mount_writable ok\nreadiness-canary run_user 1000\nreadiness-canary git_identity ok\n";

// The audit's own commands for one component, run through `ex`, scored as a seal would.
async function scored(ex: Executor, preCanary = true) {
  const audit: Audit = makeAudit({ components: [{ id: "app", share: 1 }] });
  audit.evidence = [];
  audit.environment.proofEnv = { kind: ex.where === "container" ? "container" : "host", id: "test", imageSource: ex.imageSource, network: null, canary: { ok: true, checks: [] }, proves: ex.where === "container" };
  const exs = preCanary ? await checkExecutors(audit, one(ex), audit.profile!, () => {}) : one(ex);
  const results = await runContract(exs.repo, audit.contract, { components: new Set(["app"]), budget: newBudget(15, 60), registryValues: [] });
  for (const r of results) evidenceFromPhase(audit, exs.repo, r, []);
  recordNetwork(audit, exs);
  return { audit, states: componentStates(audit, rubric, "app") };
}

describe("proof environments", () => {
  test("a Cursor Cloud Agent VM is detected from what the machine shows, and nothing the agent passes declares one", () => {
    const vm = { CLOUD_AGENT_INJECTED_SECRET_NAMES: "", CURSOR_AGENT: "1" };
    assert.deepEqual(detectDisposableVm(vm, "linux", (p) => p === "/exec-daemon")?.signals, ["/exec-daemon", "CLOUD_AGENT_INJECTED_SECRET_NAMES"]);
    assert.equal(detectDisposableVm({ CURSOR_AGENT: "1" }, "linux", (p) => p === "/exec-daemon"), null, "a desktop agent sets CURSOR_AGENT too");
    assert.equal(detectDisposableVm(vm, "linux", () => false), null, "no agent daemon, no VM");
    assert.equal(detectDisposableVm(vm, "darwin", () => true), null, "Cursor's cloud VMs run Linux");
    assert.equal(detectDisposableVm({ ...vm, SA_VM_DETECT: "off" }, "linux", () => true), null, "the opt-out only takes proof away");
    assert.equal(detectDisposableVm({ SA_READINESS_DISPOSABLE_VM: "1", SA_VM_DETECT: "on" }, "linux", () => false), null, "there is no variable that declares one");
  });

  test("whether a disposable VM proves Level 1 is the rubric's: older rubrics prove only in a container", () => {
    assert.equal(provesIn(loadRubric("2026-11-beta"), "disposable_vm"), false);
    assert.equal(provesIn(loadRubric("2026-11-beta"), "container"), true);
    assert.deepEqual(rubric.proof?.environments, ["container", "disposable_vm"], `${latestRubricVersion()} lists where a pass proves Level 1`);
    assert.equal(provesIn(rubric, "host"), false);
  });

  test("the canary fails on an empty work tree, a read-only one, the wrong user or no git identity", async () => {
    const empty = mkdtempSync(join(tmpdir(), "proofenv-empty-"));
    const c1 = await runCanary(hostExecutor(empty, [], false, "fresh_copy", true), String(process.getuid!()));
    assert.deepEqual(c1.checks.filter((c) => !c.ok).map((c) => c.id), ["mount_visible"]);
    const full = mkdtempSync(join(tmpdir(), "proofenv-full-"));
    writeFileSync(join(full, "package.json"), "{}");
    const ok = await runCanary(hostExecutor(full, [], false, "fresh_copy", true), String(process.getuid!()));
    assert.ok(ok.ok, JSON.stringify(ok.checks));
    assert.deepEqual(parseCanary(CANARY_OK.replace("mount_writable ok", "mount_writable fail the work tree is read-only"), "1000").checks.filter((c) => !c.ok).map((c) => c.detail), ["the work tree is read-only"]);
    assert.match(parseCanary(CANARY_OK, "1001").checks.find((c) => c.id === "run_user")!.detail, /ran as uid 1000, not 1001/);
    assert.equal(parseCanary(CANARY_OK.replace("git_identity ok", "git_identity fail git has no identity"), "1000").ok, false);
    assert.equal(parseCanary("", "1000").ok, false, "an environment that doesn't answer fails");
  });

  for (const [name, broken] of [
    ["an empty mount", CANARY_OK.replace("mount_visible ok", "mount_visible fail the work tree is empty")],
    ["a read-only mount", CANARY_OK.replace("mount_writable ok", "mount_writable fail the work tree is read-only")],
    ["the wrong user", CANARY_OK.replace("run_user 1000", "run_user 0")],
  ] as const) {
    test(`a runtime with ${name} blocks every condition and never fails one`, async () => {
      const ran: string[] = [];
      const ex = fake("container", (cmd) => (cmd.includes("readiness-canary") ? { exitCode: 0, output: broken } : (ran.push(cmd), { exitCode: 1, output: "npm ERR! enoent" })));
      const { audit, states } = await scored(ex);
      assert.deepEqual(ran, [], "no repo command ran");
      for (const k of ["clean.install", "clean.build", "clean.test", "commands"] as const) assert.equal(states[k].state === "not_met" && states[k].reason.includes("no test command"), false, k);
      for (const k of ["clean.install", "clean.test"] as const) {
        assert.equal(states[k].state, "blocked", `${k}: ${states[k].reason}`);
        assert.match(states[k].reason, /failed its self-check/);
      }
      assert.equal(audit.environment.proofEnv!.canary.ok, false);
      assert.equal(audit.environment.proofEnv!.proves, false);
    });
  }

  test("a container whose network won't go down blocks the offline phase, a failing test included", async () => {
    const ex = fake("container", (cmd) => (cmd.includes("readiness-canary") ? { exitCode: 0, output: CANARY_OK } : cmd === "npm test" ? { exitCode: 1, output: "1 failing" } : { exitCode: 0, output: "ok" }), false);
    const { audit, states } = await scored(ex);
    assert.equal(states["clean.install"].state, "met", "the install ran with the network on, as it should");
    assert.equal(states["clean.test"].state, "blocked", states["clean.test"].reason);
    assert.ok(audit.evidence.filter((e) => e.kind === "test").every((e) => e.blocked === NETWORK_ON));
    assert.deepEqual(audit.environment.proofEnv!.canary.checks.find((c) => c.id === "network_cut"), { id: "network_cut", ok: false, detail: "the container's network wouldn't go down" });
    assert.equal(audit.environment.proofEnv!.proves, false);
  });

  test("the audit sets git's identity and the time zone, so a test that commits passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proofenv-git-"));
    const ex = hostExecutor(dir, [], false, "fresh_copy", true);
    const out = await ex.exec("git init -q . && git commit -q --allow-empty -m 'from a test' && git log -1 --format='%an <%ae>' && date +%Z", ".", 60);
    assert.equal(out.exitCode, 0, out.output);
    const lines = out.output.trim().split("\n");
    assert.equal(lines[0], "Agent Readiness <readiness@audit.invalid>");
    assert.equal(lines[1], "UTC");
  });

  test("a VM cuts the network for the tests where it can, as the same user with loopback up, and says so where it can't", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proofenv-net-"));
    writeFileSync(join(dir, "f"), "x");
    const ex = vmExecutor(dir, [], false, true);
    assert.equal(ex.where, "disposable_vm");
    assert.equal(ex.strength, "clean_replay");
    const before = await ex.exec("id -u", ".", 30);
    const cut = ex.offline();
    assert.equal(cut, canCutNetwork());
    assert.equal(ex.networkOff, cut);
    const after = await ex.exec("id -u; touch mine && chmod 000 mine && (cat mine 2>/dev/null && echo readable || echo denied); python3 -c \"import socket;s=socket.socket();s.bind(('127.0.0.1',0));s.listen();socket.create_connection(s.getsockname());print('loopback')\"", ".", 30);
    const lines = after.output.trim().split("\n");
    assert.equal(lines[0], before.output.trim(), "same user");
    assert.equal(lines[1], "denied", "no capability lets a test read a file it may not");
    assert.equal(lines[2], "loopback");
    if (cut) {
      const outside = await ex.exec("python3 -c \"import socket;socket.create_connection(('1.1.1.1',53),2)\" && echo online || echo offline", ".", 30);
      assert.equal(outside.output.trim().split("\n").pop(), "offline");
    }
  });

  for (const vm of [CLOUD_VM, null]) {
    test(vm ? "healthy-node with no container runtime proves Level 1 on a detected disposable VM" : "healthy-node with no container runtime stays unproven on a machine that isn't a disposable VM", { timeout: 5 * 60 * 1000 }, async () => {
      const repo = materialize("healthy-node");
      for (const step of [["init", "--tier", "local-exec"], ["scan"]]) assert.equal(readiness(repo, step).code, 0, step.join(" "));
      const { audit, local, paths: p } = loadDraft(repo);
      const log: string[] = [];
      await replay(audit, repo, local.tree, loadRubric(audit.rubric), { runtime: "none", allowHost: true, vm, mutants: false, instructions: false, budgetComponentMinutes: 15, budgetTotalMinutes: 60, log: (l) => log.push(l) });
      saveDraft(p, audit);
      const sealed = readiness(repo, ["seal"]);
      assert.equal(sealed.code, 0, sealed.out);
      const report = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
      const id = report.audit.id as string;
      const stored = JSON.parse(readFileSync(join(repo, ".agent-readiness/history/audits", id, "audit.json"), "utf8")) as Audit;
      const pe = stored.environment.proofEnv!;
      const row = report.components.included.find((c: { id: string }) => c.id === stored.profile!.components.find((x) => x.assessed)!.id);
      assert.equal(pe.canary.ok, true, JSON.stringify(pe.canary));
      if (vm) {
        assert.equal(pe.kind, "disposable_vm", log.join("\n"));
        assert.equal(pe.proves, true);
        assert.deepEqual(pe.detectedBy, CLOUD_VM.signals);
        assert.equal(pe.network, canCutNetwork() ? "cut" : "on");
        assert.ok(row.level >= 1 && !row.unproven, `${row.level} ${row.unproven}: ${JSON.stringify(row.capReasons)}`);
        assert.ok(stored.evidence.filter((e) => e.kind === "test").every((e) => e.where === "disposable_vm" && e.strength === "clean_replay"));
        assert.match(readFileSync(join(repo, ".agent-readiness/latest/report.md"), "utf8"), /fresh copy on a disposable VM/);
        if (pe.network === "on") assert.equal(report.maturity.confidence.level === "high", false, "network on caps confidence");
      } else {
        assert.equal(pe.kind, "host");
        assert.equal(pe.proves, false);
        assert.ok(row.unproven || row.level === null || row.level < 1, JSON.stringify(row));
      }
    });
  }

  test("cleanup removes stray drafts and old temp trees, never the open draft or another audit's fresh tree", () => {
    const repo = materialize("healthy-node");
    const tmp = mkdtempSync(join(tmpdir(), "proofenv-cleanup-"));
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"], { TMPDIR: tmp }).code, 0);
    const open = readFileSync(join(repo, ".agent-readiness/work/CURRENT"), "utf8").trim();
    mkdirSync(join(repo, ".agent-readiness/work/aud-2026-01-01-0000000-dead"), { recursive: true });
    const old = join(tmp, "readiness-replay-old");
    const fresh = join(tmp, "readiness-replay-fresh");
    mkdirSync(old);
    mkdirSync(fresh);
    const past = new Date(Date.now() - 6 * 3600e3);
    utimesSync(old, past, past);
    const r = readiness(repo, ["cleanup"], { TMPDIR: tmp });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /draft aud-2026-01-01-0000000-dead/);
    assert.equal(existsSync(join(repo, ".agent-readiness/work", open, "audit.json")), true, "the open draft stays");
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true, "a tree younger than a session may be another audit's");
    const tree = JSON.parse(readFileSync(join(repo, ".agent-readiness/work", open, "local.json"), "utf8")).tree as string;
    assert.equal(existsSync(tree), true);
    execFileSync("git", ["status", "--porcelain"], { cwd: repo });
  });
});
