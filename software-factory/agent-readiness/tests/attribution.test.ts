import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { attribute, networkVerdict, rerunsOnline } from "../skill/agent-readiness/scripts/lib/attribute.ts";
import { toolSetup } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { diagnose } from "../skill/agent-readiness/scripts/lib/diagnose.ts";
import { componentLevel, repoLevel, statesOf } from "../skill/agent-readiness/scripts/lib/levels.ts";
import { ciCommands, ciEnvFor, ciTestScript, scriptCalled, testScriptOf } from "../skill/agent-readiness/scripts/lib/plan/ci.ts";
import { ownTestFiles } from "../skill/agent-readiness/scripts/lib/plan/test-files.ts";
import { DELEGATES } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { currentEvidence } from "../skill/agent-readiness/scripts/lib/evidence.ts";
import { addToolCommand, evidenceFromPhase, newBudget, runContract } from "../skill/agent-readiness/scripts/lib/replay.ts";
import type { Executor } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { componentStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import { buildSealedReport, compute } from "../skill/agent-readiness/scripts/lib/seal.ts";
import type { Component, Profile } from "../skill/agent-readiness/scripts/lib/types.ts";
import { factConflicts } from "../support/holdout/observe.ts";
import { makeAudit, reportFor } from "./helpers.ts";

const next = loadRubric("2026-12-beta");
const beta = loadRubric("2026-11-beta");
const fail = (summary: string, extra: Partial<Parameters<typeof attribute>[0]> = {}) => ({ result: "fail" as const, kind: "test" as const, where: "container" as const, summary, ...extra });

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "readiness-attr-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

describe("attribution: whose failure a failed step is", () => {
  test("a test that ran in a container whose self-check passed and failed on its own terms is the repo's", () => {
    assert.deepEqual(attribute(fail("test failed: discount takes 10 off failed")), { verdict: "repo", basis: "canary", detail: "test failed: discount takes 10 off failed" });
  });

  test("a step the machine blocked is the environment's", () => {
    assert.equal(attribute(fail("x", { blocked: "no container runtime on this machine" }))?.verdict, "environment");
  });

  test("a missing test runner, a missing system library, and an install that fails without saying why in the audit's image are undetermined", () => {
    assert.equal(attribute(fail("python -m pytest failed: /usr/local/bin/python: No module named pytest"))?.verdict, "undetermined");
    assert.equal(attribute(fail("sh: 1: vitest: not found"))?.verdict, "undetermined");
    const lib = attribute(fail("Error: libGL.so.1: cannot open shared object file: No such file or directory"));
    assert.equal(lib?.verdict, "undetermined");
    assert.match(lib!.detail, /libGL\.so\.1 is missing from the image the audit picked/);
    assert.equal(attribute(fail("install failed: something went wrong", { kind: "install" }))?.verdict, "undetermined");
  });

  test("in the repo's own declared image, a missing system library is the repo's", () => {
    assert.equal(attribute(fail("Error: libGL.so.1: cannot open shared object file: No such file or directory"), "repo")?.verdict, "repo");
  });

  test("a rerun with the network on decides a test that failed with it cut", () => {
    const first = attribute(fail("test failed: a test tried to reach the network, which is off while tests run", { diagnosis: { cause: "network", detail: "a test tried to reach the network, which is off while tests run" } }));
    assert.equal(first?.verdict, "undetermined");
    assert.ok(rerunsOnline(first));
    assert.deepEqual(networkVerdict(first, true, ""), { verdict: "environment", basis: "experiment", changed: "network", detail: "the tests passed when run again with the network on, so they need the network rather than failing on their own" });
    assert.equal(networkVerdict(first, false, "x failed").verdict, "repo");
    const runner = attribute(fail("sh: 1: vitest: not found"));
    assert.ok(!rerunsOnline(runner), "a missing test runner isn't the network's to settle");
  });

  // pocketbase@7f2773e: TestRecordAuthWithOAuth2 needs the network, and the rerun with it on now and
  // then fails a test flaky on its own (TestNotifyWatcher_SettingsUpdate, TestRandomStringByRegex).
  const flakyRun = async (online: { exitCode: number; output: string }[]) => {
    const audit = makeAudit({ components: [{ id: "app", share: 1 }] });
    audit.evidence = [];
    const testCmd = audit.contract.find((c) => c.kind === "test")!;
    const answers = [{ exitCode: 1, output: "--- FAIL: TestRecordAuthWithOAuth2 (0.01s)\n    dial tcp: lookup pocketbase.io: no such host\nFAIL\n" }, ...online];
    let testRuns = 0;
    const ex: Executor = {
      where: "container",
      strength: "clean_replay",
      image: "golang:1.27",
      imageSource: "audit",
      root: "/work",
      exec: async (command) => ({ timedOut: false, durationMs: 1, ...(command === testCmd.command ? answers[testRuns++] : { exitCode: 0, output: "" }) }),
      offline: () => (ex.networkOff = true),
      online: () => (ex.networkOff = false, true),
      networkOff: null,
      close: () => {},
    };
    const results = await runContract(ex, audit.contract, { components: new Set(["app"]), budget: newBudget(10, 10), registryValues: [], reruns: ["network"] });
    for (const r of results) evidenceFromPhase(audit, ex, r, []);
    const tests = currentEvidence(audit).filter((e) => e.condition === "clean.test");
    return { testRuns, state: componentStates(audit, next, "app")["clean.test"].state, tests, offline: audit.evidence.find((e) => e.condition === "clean.test")! };
  };
  const pass = { exitCode: 0, output: "--- PASS: TestRecordAuthWithOAuth2 (0.01s)\nok\n" };
  const flake = { exitCode: 1, output: "--- FAIL: TestNotifyWatcher_SettingsUpdate (1.00s)\nFAIL\n" };

  test("a rerun with the network on that passes is the only extra run", async () => {
    const r = await flakyRun([pass]);
    assert.equal(r.testRuns, 2);
    assert.equal(r.state, "met");
  });

  test("a rerun with the network on that fails gets one more try, and a pass there records the tests as flaky", async () => {
    const r = await flakyRun([flake, pass]);
    assert.equal(r.testRuns, 3);
    assert.equal(r.state, "met", "a test flaky on its own isn't a clean checkout's failing tests");
    assert.equal(r.tests.length, 1);
    assert.match(r.tests[0].summary, /on a second try: the first with it on failed \(TestNotifyWatcher_SettingsUpdate failed\), so the tests are flaky/);
    assert.equal(r.offline.attribution?.verdict, "environment");
  });

  test("a third failure is the repo's, as a second was before", async () => {
    const r = await flakyRun([flake, flake]);
    assert.equal(r.testRuns, 3);
    assert.equal(r.state, "not_met");
    assert.equal(r.tests[0].attribution?.verdict, "repo");
    assert.match(r.tests[0].summary, /it failed again with the network on/);
  });

  test("diagnoses Python's missing module, GitPython's missing git and a missing shared library", () => {
    assert.deepEqual(diagnose("/usr/local/bin/python: No module named pytest", false, "test"), { cause: "missing_module", detail: "module pytest is missing" });
    assert.deepEqual(diagnose("ImportError: Failed to initialize: Bad git executable.", false, "test"), { cause: "missing_tool", detail: "git is not installed" });
    assert.deepEqual(diagnose("error while loading shared libraries: libssl.so.1.1: cannot open shared object file", false, "test"), { cause: "missing_library", detail: "the system library libssl.so.1.1 is missing" });
  });

  test("git is added to the audit's image with apt or apk, and only when it's missing", () => {
    assert.match(addToolCommand("git"), /^command -v git >\/dev\/null 2>&1 \|\| \{ .*apt-get install -y -qq --no-install-recommends git .*apk add --no-cache git/);
  });
});

describe("Level 0 needs a repo failure (2026-12-beta)", () => {
  test("a Level 1 condition the audit couldn't decide is undetermined, not Level 0; 2026-11-beta still says Level 0", () => {
    const states = { "clean.install": "met", "clean.build": "met", "clean.test": "unknown" } as const;
    assert.deepEqual(componentLevel(next, states), { level: 0, couldBe: 1, missing: [], unknown: ["clean.test"], undetermined: true });
    assert.deepEqual(componentLevel(beta, states), { level: 0, couldBe: 1, missing: [], unknown: ["clean.test"] });
    assert.equal(componentLevel(next, { ...states, "clean.test": "blocked" }).unproven, true);
    assert.equal(componentLevel(next, { ...states, "clean.test": "not_met" }).undetermined, undefined);
  });

  test("a failure the audit's image explains leaves clean.test undetermined; the same failure is not met under 2026-11-beta", () => {
    for (const [rubric, want] of [[next, "unknown"], [beta, "not_met"]] as const) {
      const audit = makeAudit({ rubric: rubric.version, components: [{ id: "app", share: 1, test: "fail", reason: "test failed: libGL.so.1: cannot open shared object file" }] });
      assert.equal(componentStates(audit, rubric, "app")["clean.test"].state, want);
    }
  });

  test("no test command is no tests only when the component has no test files", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "missing" }] });
    audit.profile!.components[0].testFiles = 0;
    assert.equal(componentStates(audit, next, "app")["clean.test"].state, "not_met");
    audit.profile!.components[0].testFiles = 4;
    const s = componentStates(audit, next, "app")["clean.test"];
    assert.equal(s.state, "unknown");
    assert.match(s.reason, /^undetermined: the audit couldn't tell how its tests run: it has 4 test files/);
    assert.doesNotMatch(s.reason, /no test command|has no tests/);
  });

  test("the repo rollup is undetermined when its lowest components are undetermined or unproven", () => {
    const l = (x: object) => ({ level: 0 as const, couldBe: 1 as const, missing: [], unknown: [], ...x });
    assert.deepEqual(repoLevel(new Map([["a", l({ undetermined: true })], ["b", l({ unproven: true })]]), new Set(["a", "b"])), { level: 0, couldBe: 1, setBy: ["a", "b"], undetermined: true });
    assert.equal(repoLevel(new Map([["a", l({ undetermined: true })], ["b", l({})]]), new Set(["a", "b"])).undetermined, undefined);
  });

  test("the report says undetermined: no level in the heading or the ladder, a null component level, and what settles it", () => {
    const audit = makeAudit({ components: [{ id: "web", share: 1, test: "missing" }] });
    audit.profile!.components[0].testFiles = 3;
    const r = reportFor(audit);
    assert.match(r.executive.heading, /^Undetermined: /);
    assert.equal(r.maturity.status, "undetermined");
    const c = r.components.included[0];
    assert.deepEqual([c.level, c.status, c.settleBy?.kind], [null, "undetermined", "add_command"]);
    assert.match(c.settleBy!.text, /readiness contract add --kind test --component web/);
    assert.match(r.executive.headline, /^Level 1 is undetermined for web: /);
    const statesOfWeb = statesOf(componentStates(audit, next, "web"));
    assert.equal(statesOfWeb["clean.test"], "unknown");
  });

  // fixtures/standalone-nested-mixed: commerce-core undetermined, identity-dev at Level 0 by a repo failure.
  test("the history line gives an undetermined component no level, as the report does, next to a component at Level 0", () => {
    const audit = makeAudit({ components: [{ id: "web", share: 0.6, test: "missing", testFiles: 3 }, { id: "api", share: 0.4, test: "fail", reason: "test failed: total is 9, not 10" }] });
    const { report, line } = buildSealedReport(audit, next, [], null, tree({ "README.md": "x\n" }), ".agent-readiness/history/audits/x");
    const reported = Object.fromEntries(report.components.included.map((c) => [c.id, c.level]));
    assert.deepEqual(reported, { web: null, api: 0 });
    assert.equal(line.noLevel, undefined, "api's Level 0 sets the repo level, so the line has one");
    assert.deepEqual([line.levels, line.undeterminedComponents, line.repoLevel], [{ api: 0 }, ["web"], 0]);
    for (const [id, l] of compute(audit, next, []).levels) if (line.levels[id] !== undefined) assert.equal(line.levels[id], l.level, id);
    const again = reportFor(makeAudit({ id: "aud-2026-10-28-abc1234-0002", components: [{ id: "web", share: 0.6, test: "missing", testFiles: 3 }, { id: "api", share: 0.4, test: "pass" }] }), [line]);
    assert.deepEqual(again.progress?.history[0].levels, { api: 0, web: null });
  });
});

describe("run plan: the test script CI runs", () => {
  const workflow = [
    "name: ci",
    "jobs:",
    "  root:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: npm ci",
    "      - name: Guards",
    "        run: npm run validate:guards",
    "  pkg:",
    "    defaults:",
    "      run:",
    "        working-directory: packages/app",
    "    steps:",
    "      - run: |",
    "          npm ci",
    "          npm run test:ci -- \\",
    "            --reporter dot",
    "      - name: matrix",
    "        working-directory: src/${{ matrix.package }}",
    "        run: npm test",
    "      - run: cd ../lib && pnpm test",
  ].join("\n");

  test("reads run steps with their working directory, block lines, continuations and a leading cd, and skips expression directories", () => {
    const dir = tree({ ".github/workflows/ci.yml": workflow });
    assert.deepEqual(ciCommands(dir, [".github/workflows/ci.yml"]).map((c) => `${c.line} ${c.cwd} ${c.command}`), ["7 . npm ci", "9 . npm run validate:guards", "16 packages/app npm ci", "17 packages/app npm run test:ci -- --reporter dot", "22 packages/lib pnpm test"]);
  });

  test("narrows a CI chain of checks to the one script that runs the tests, and never takes a workspace delegation", () => {
    const scripts = { test: "npm run test --workspaces", "validate:guards": "npm run format:check && npm run lint && npm run test:scripts", "format:check": "prettier --check .", lint: "eslint .", "test:scripts": 'node --test "scripts/**/*.test.mjs"' };
    assert.equal(testScriptOf(scripts, "validate:guards", DELEGATES), "test:scripts");
    assert.equal(testScriptOf(scripts, "test", DELEGATES), null);
    assert.equal(testScriptOf({ test: "pnpm vitest run" }, "test", DELEGATES), "test");
    assert.equal(scriptCalled("npm t"), "test");
    assert.equal(scriptCalled("npm ci"), null);
    const dir = tree({ ".github/workflows/ci.yml": workflow });
    assert.deepEqual(ciTestScript(ciCommands(dir, [".github/workflows/ci.yml"]), ".", scripts, DELEGATES), { script: "test:scripts", called: "validate:guards", source: ".github/workflows/ci.yml:9" });
    assert.equal(ciTestScript(ciCommands(dir, [".github/workflows/ci.yml"]), "packages/other", scripts, DELEGATES), null);
  });

  test("carries the literal variables the workflow, job and step set, and none that read secrets or expressions", () => {
    const yml = ["name: ci", "env:", '  DATABASE_URL: "postgresql://user:pass@localhost:5432/dummy"', "  TOKEN: ${{ secrets.TOKEN }}", "jobs:", "  test:", "    env:", "      SKIP_DB_CHECK: 1", "      HOME_DIR: $HOME/x", "    steps:", "      - name: tests", "        env:", "          TZ: UTC", "        run: pnpm test", "      - run: pnpm build"].join("\n");
    const ci = ciCommands(tree({ ".github/workflows/ci.yml": yml }), [".github/workflows/ci.yml"]);
    const url = ["DATABASE_URL", "postgresql://user:pass@localhost:5432/dummy"];
    const skip = ["SKIP_DB_CHECK", "1"];
    assert.deepEqual(ci.map((c) => [c.command, Object.entries(c.env)]), [
      ["pnpm test", [url, skip, ["TZ", "UTC"]]],
      ["pnpm build", [url, skip]],
    ]);
    assert.deepEqual(ciEnvFor(ci, ".", "test", "package.json scripts.test"), ci[0].env);
    assert.deepEqual(ciEnvFor(ci, "packages/x", "test", "package.json scripts.test"), {});
  });
});

describe("the scan counts each component's own test files", () => {
  test("by its language's rule, leaving out nested components and satellites", () => {
    const files = ["test/a.test.js", "src/b.js", "packages/x/test/c.test.js", "e2e/d.test.js", "tests/test_e.py"];
    const comp = (id: string, path: string, language: Component["language"] = "js") => ({ id, path, language, manifest: null, scripts: {}, changes: 0, changeShare: 0, assessed: true }) as Component;
    const profile = { components: [comp("root", "."), comp("x", "packages/x")], satellites: [{ path: "e2e", manifest: null, toolchain: "node", reason: "tests" }] } as Pick<Profile, "components" | "satellites">;
    assert.equal(ownTestFiles(files, profile, profile.components[0]), 1);
    assert.equal(ownTestFiles(files, profile, profile.components[1]), 1);
    assert.equal(ownTestFiles(files, profile, comp("py", ".", "py")), 1);
  });
});

describe("tool pins the audit honors", () => {
  test("an exact engines pin for pnpm, with no packageManager, sets corepack to it", () => {
    const dir = tree({ "package.json": JSON.stringify({ name: "x", engines: { pnpm: "12.3.4" } }), "pnpm-lock.yaml": "" });
    const profile = { packageManager: "pnpm", components: [{ id: "x", path: ".", language: "ts", manifest: "package.json", scripts: {}, changes: 1, changeShare: 1, assessed: true, packageManager: "pnpm" }] } as unknown as Profile;
    // Corepack itself, added where the image lacks it, is checked in tests/trial-misses.test.ts.
    const pins = (p: Profile) => toolSetup(p, dir).filter((t) => t.tool !== "corepack");
    const setup = pins(profile);
    assert.deepEqual(setup.map((t) => [t.spec, t.install]), [["pnpm@12.3.4", "COREPACK_HOME=/tmp/home/.cache/node/corepack corepack prepare 'pnpm@12.3.4' --activate"]]);
    assert.match(setup[0].present!, /corepack pnpm --version/);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", packageManager: "pnpm@12.3.4", engines: { pnpm: "12.3.4" } }));
    assert.deepEqual(pins(profile), []);
  });
});

describe("one fact, one value", () => {
  test("an undetermined report names no level in its heading, so the ladder marking none agrees", () => {
    const audit = makeAudit({ components: [{ id: "web", share: 1, test: "missing" }] });
    audit.profile!.components[0].testFiles = 2;
    const report = reportFor(audit);
    assert.deepEqual(factConflicts({ report: report as never, audit: audit as never, markdown: "Level ladder: 0 Not bootable · 1 Bootable", html: "" }), []);
  });
});
