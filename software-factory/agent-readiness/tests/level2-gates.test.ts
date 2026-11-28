import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { OOM_MARK } from "../skill/agent-readiness/scripts/lib/diagnose.ts";
import { CONTROL_COMMENT, atLook, chooseSites, faultEstimate, faultId, keepPlanting, scopedCommand, testsReaching, withControlComment } from "../skill/agent-readiness/scripts/lib/mutate.ts";
import type { EstimateRule } from "../skill/agent-readiness/scripts/lib/mutate.ts";
import { charge, newBudget, plantFaults } from "../skill/agent-readiness/scripts/lib/replay.ts";
import type { Executor } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { componentStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import type { Audit, Component, InstructionItem } from "../skill/agent-readiness/scripts/lib/types.ts";
import { estimateTable } from "../support/tools/kill-rate.ts";
import type { EstimateRow, Tally } from "../support/tools/kill-rate.ts";
import { SUPPORT } from "../support/tools/fixture.ts";
import { makeAudit } from "./helpers.ts";

const next = loadRubric("2026-12-beta");
const beta = loadRubric("2026-11-beta");
const rule = next.mutation.estimate!;
const minForPass = next.mutation.minForPass;

describe("Level 2 fault statistics: a sequential estimate instead of five planted faults", () => {
  test("the verdict table from 0 to 20 decided faults (s strong, w weak, i inconclusive, by faults caught)", () => {
    const table = Array.from({ length: 21 }, (_, n) => Array.from({ length: n + 1 }, (_, k) => faultEstimate(k, n, rule, minForPass).verdict[0]).join(""));
    assert.deepEqual(table, [
      "i",
      "ii",
      "iii",
      "wiis",
      "wwiis",
      "wwiiis",
      "wwwiiss",
      "wwwiiiss",
      "wwwwiisss",
      "wwwwwiisss",
      "wwwwwiiisss",
      "wwwwwwiissss",
      "wwwwwwiiissss",
      "wwwwwwwiisssss",
      "wwwwwwwiiisssss",
      "wwwwwwwwiissssss",
      "wwwwwwwwwiissssss",
      "wwwwwwwwwiisssssss",
      "wwwwwwwwwwiisssssss",
      "wwwwwwwwwwwissssssss",
      "wwwwwwwwwwwiissssssss",
    ]);
  });

  // The exact distribution of the verdict when every fault is caught with probability p, planting in
  // batches and looking at each whole batch, as plantFaults does.
  function verdictOdds(p: number, r: EstimateRule): Record<"strong" | "weak" | "inconclusive", number> {
    const out = { strong: 0, weak: 0, inconclusive: 0 };
    let open = new Map<number, number>([[0, 1]]);
    for (let n = r.batch; open.size; n += r.batch) {
      const after = new Map<number, number>();
      for (const [k, pk] of open) {
        for (let j = 0; j <= r.batch; j++) {
          const choose = [...Array(j).keys()].reduce((acc, i) => (acc * (r.batch - i)) / (i + 1), 1);
          after.set(k + j, (after.get(k + j) ?? 0) + pk * choose * p ** j * (1 - p) ** (r.batch - j));
        }
      }
      open = new Map();
      for (const [k, pk] of after) {
        const est = faultEstimate(k, n, r, minForPass, n);
        assert.ok(atLook(n, r));
        if (keepPlanting(est, r)) open.set(k, pk);
        else out[est.verdict] += pk;
      }
    }
    return out;
  }

  test("a suite that catches 40% of faults passes at most 10% of the time, and one that catches 80% fails at most 10%", () => {
    const weakSuite = verdictOdds(0.4, rule);
    const goodSuite = verdictOdds(0.8, rule);
    assert.ok(weakSuite.strong <= 0.1, `a 40% suite passes ${weakSuite.strong.toFixed(3)} of the time`);
    assert.ok(goodSuite.weak <= 0.1, `an 80% suite fails ${goodSuite.weak.toFixed(3)} of the time`);
    for (const odds of [weakSuite, goodSuite]) assert.ok(Math.abs(odds.strong + odds.weak + odds.inconclusive - 1) < 1e-9);
  });

  test("the five-sample rule it replaces flips a coin between 40% and 60% suites", () => {
    const once = { ...rule, maxDecided: 5, maxPlanted: 5 };
    const killRate = (p: number) => [3, 4, 5].reduce((s, k) => s + ([1, 5, 10, 10, 5, 1][k] * p ** k * (1 - p) ** (5 - k)), 0);
    assert.ok(killRate(0.4) > 0.3 && 1 - killRate(0.6) > 0.3, "5 faults with a 60% bar: a 40% suite passes and a 60% suite fails about a third of the time");
    assert.ok(verdictOdds(0.4, once).strong < 0.1);
  });

  test("an inconclusive estimate leaves the faults condition undetermined, never not met", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1 }] });
    audit.evidence.push({ id: "ev-faults", at: audit.createdAt, checkId: "verify.behavioral_oracle", condition: "faults", component: "app", strength: "clean_replay", where: "container", result: "not_run", summary: "caught 11 of 20 planted faults (55%): inconclusive", estimate: faultEstimate(11, 20, rule, minForPass) });
    assert.equal(componentStates(audit, next, "app").faults.state, "unknown");
  });
});

function gitRepo(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "readiness-faults-")), "repo");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  commit(dir, "initial");
  return dir;
}

function commit(dir: string, message: string): string {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Contributor A", "-c", "user.email=a@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", message], { cwd: dir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

// Thirty functions, each with a boundary, a constant and a returned boolean to plant faults in.
const PRICING = Array.from({ length: 30 }, (_, i) => `export function rule${i}(n) {\n  if (n > ${i + 2}) return true;\n  return n === ${i + 7};\n}\n`).join("\n");
const TESTS = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport * as p from "../src/pricing.js";\n\ntest("rules", () => assert.ok(p.rule0(9)));\n`;
const app = (): Component => ({ id: "app", path: "app", language: "js", manifest: "app/package.json", scripts: {}, changes: 100, changeShare: 1, assessed: true });

describe("stable fault identity", () => {
  test("a test-only edit keeps the fault set; under the old pick it redraws it", () => {
    const repo = gitRepo({ "app/package.json": "{}", "app/src/pricing.js": PRICING, "app/test/pricing.test.js": TESTS });
    const pick = (opts: { identity?: "fault" }) => chooseSites(repo, repo, app(), "", 5, "HEAD", opts).map(faultId);
    const [before, beforeOld] = [pick({ identity: "fault" }), pick({})];
    writeFileSync(join(repo, "app/test/pricing.test.js"), TESTS + `test("more", () => assert.ok(!p.rule1(1)));\n`);
    commit(repo, "a new test");
    assert.deepEqual(pick({ identity: "fault" }), before);
    assert.notDeepEqual(pick({}), beforeOld, "the 2026-11-beta pick is keyed on the tests too, so a test edit redraws it");
  });

  test("a fault keeps its identity when code above it moves", () => {
    const site = { file: "src/a.js", before: "  if (n > 2) return true;", operator: "boundary_flip" };
    assert.equal(faultId(site), faultId({ ...site, before: "if (n > 2)   return true;" }));
    assert.notEqual(faultId(site), faultId({ ...site, operator: "swap_return" }));
  });

  test("a re-audit plants the earlier audit's faults first, then fresh ones", () => {
    const repo = gitRepo({ "app/package.json": "{}", "app/src/pricing.js": PRICING, "app/test/pricing.test.js": TESTS });
    const all = chooseSites(repo, repo, app(), "", 30, "HEAD", { identity: "fault" });
    const prior = [faultId(all[29]), faultId(all[17])];
    const again = chooseSites(repo, repo, app(), "", 5, "HEAD", { identity: "fault", prior });
    assert.deepEqual(again.slice(0, 2).map(faultId), prior);
    assert.deepEqual(again.slice(2).map(faultId), all.filter((s) => !prior.includes(faultId(s))).slice(0, 3).map(faultId));
  });
});

describe("scoped fault runs", () => {
  test("a direct pytest or node --test run is narrowed to the tests that import the file", () => {
    assert.equal(scopedCommand(".readiness-venv/bin/python -m pytest -q", ".", ["tests/test_a.py"]), ".readiness-venv/bin/python -m pytest -q tests/test_a.py");
    assert.equal(scopedCommand("uv run pytest -n auto", "pkg", ["pkg/tests/test_a.py", "pkg/tests/test_b.py"]), "uv run pytest -n auto tests/test_a.py tests/test_b.py");
    assert.equal(scopedCommand("node --test", ".", ["test/a.test.js"]), "node --test test/a.test.js");
  });

  test("anything it can't narrow safely runs whole", () => {
    assert.equal(scopedCommand("npm test", ".", ["test/a.test.js"]), null, "a script's contents aren't known");
    assert.equal(scopedCommand("pytest tests/unit", ".", ["tests/unit/test_a.py"]), null, "the run names paths of its own");
    assert.equal(scopedCommand("cd app && pytest", ".", ["app/tests/test_a.py"]), null);
    assert.equal(scopedCommand("pytest", "app", ["lib/tests/test_a.py"]), null, "a test outside the folder the run starts in");
  });

  test("the tests that reach a file follow imports through other files, and a conftest.py reach runs everything", () => {
    const repo = gitRepo({
      "pyproject.toml": "[project]\nname='calc'\n",
      "calc/__init__.py": "",
      "calc/core.py": "def add(a, b):\n    return a + b\n",
      "calc/api.py": "from calc.core import add\n\ndef total(xs):\n    return sum(xs)\n",
      "calc/other.py": "def noop():\n    return None\n",
      "calc/shared.py": "X = 1\n",
      "tests/test_api.py": "from calc.api import total\n\ndef test_total():\n    assert total([1]) == 1\n",
      "tests/test_other.py": "from calc.other import noop\n\ndef test_noop():\n    assert noop() is None\n",
      "tests/conftest.py": "from calc.shared import X\n",
    });
    const py: Component = { ...app(), path: ".", language: "py", manifest: "pyproject.toml" };
    const reach = testsReaching(repo, py)!;
    assert.deepEqual(reach("calc/core.py"), ["tests/test_api.py"]);
    assert.deepEqual(reach("calc/other.py"), ["tests/test_other.py"]);
    assert.equal(reach("calc/shared.py"), null);
    assert.equal(testsReaching(repo, { ...py, language: "go" }), null);
  });
});

// Runs every command instantly, reporting `durationMs` and the outcome `caught(i)` gives for the i-th
// run with a planted fault. The control run, with only a comment added, passes unless `controlFails`.
function fakeExecutor(root: string, durationMs: number, caught: (i: number) => boolean, timesOut: (i: number) => boolean = () => false, controlFails = false): Executor {
  let i = 0;
  const pricing = join(root, "app/src/pricing.js");
  return {
    where: "container",
    strength: "clean_replay",
    image: null,
    imageSource: "audit",
    root,
    async exec() {
      if (existsSync(pricing) && readFileSync(pricing, "utf8").includes(CONTROL_COMMENT)) return { exitCode: controlFails ? 1 : 0, timedOut: false, durationMs, output: controlFails ? "# pass 4\n# fail 1\n" : "# pass 5\n# fail 0\n" };
      const n = i++;
      if (timesOut(n)) return { exitCode: null, timedOut: true, durationMs, output: "" };
      const c = caught(n);
      return { exitCode: c ? 1 : 0, timedOut: false, durationMs, output: c ? "# pass 4\n# fail 1\n" : "# pass 5\n# fail 0\n" };
    },
    offline: () => true,
    networkOff: true,
    close() {},
  };
}

function faultAudit(repo: string, rubric: string): Audit {
  const audit = makeAudit({ components: [{ id: "app", share: 1 }], rubric });
  audit.repo.commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  return audit;
}

describe("planting faults within the budget", () => {
  const files = { "app/package.json": "{}", "app/src/pricing.js": PRICING, "app/test/pricing.test.js": TESTS };

  test("a 90-second suite still decides five faults inside the 15-minute component budget", async () => {
    const run = async (version: string) => {
      const repo = gitRepo(files);
      const audit = faultAudit(repo, version);
      const budget = newBudget(15, 60);
      // The install, the build and the suite's two clean runs, 90 seconds each.
      charge(budget, "app", 4 * 90_000);
      await plantFaults(audit, repo, repo, fakeExecutor(repo, 90_000, () => true), loadRubric(version), audit.contract.find((c) => c.kind === "test")!, budget, () => {});
      return audit;
    };
    const now = await run("2026-12-beta");
    const ev = now.evidence.find((e) => e.condition === "faults")!;
    assert.equal(ev.estimate?.decided, 5, ev.summary);
    assert.equal(ev.result, "pass", ev.summary);
    const before = await run("2026-11-beta");
    const decidedBefore = before.mutants.filter((m) => m.result === "caught" || m.result === "survived").length;
    assert.ok(decidedBefore < 5, `2026-11-beta runs a caught fault twice and decides ${decidedBefore}`);
  });

  test("a suite in the middle keeps planting to the cap and ends inconclusive, not failed", async () => {
    const repo = gitRepo(files);
    const audit = faultAudit(repo, "2026-12-beta");
    const pattern = [true, false, true, false, true];
    await plantFaults(audit, repo, repo, fakeExecutor(repo, 1000, (i) => pattern[i % 5]), next, audit.contract.find((c) => c.kind === "test")!, newBudget(15, 60), () => {});
    const ev = audit.evidence.find((e) => e.condition === "faults")!;
    assert.equal(ev.estimate?.decided, rule.maxDecided);
    assert.equal(ev.estimate?.verdict, "inconclusive");
    assert.equal(ev.result, "not_run");
    assert.match(ev.summary, /caught 12 of 20 planted faults \(60%\): inconclusive, between \d+% and \d+%.*the cap of 20 was reached/);
    assert.equal(componentStates(audit, next, "app").faults.state, "unknown");
  });

  test("a run with a planted fault stopped at the audit's memory limit counts neither way, and the check says why", async () => {
    const oom = (root: string): Executor => ({
      ...fakeExecutor(root, 1000, () => true),
      async exec(c, cwd, sec, o) {
        if (readFileSync(join(root, "app/src/pricing.js"), "utf8").includes(CONTROL_COMMENT)) return fakeExecutor(root, 1000, () => false).exec(c, cwd, sec, o);
        return { exitCode: 137, timedOut: false, durationMs: 1000, output: `Killed\n${OOM_MARK}: the kernel stopped a process at the container's 2048 MB memory limit\n` };
      },
    });
    const repo = gitRepo(files);
    const audit = faultAudit(repo, "2026-12-beta");
    await plantFaults(audit, repo, repo, oom(repo), next, audit.contract.find((c) => c.kind === "test")!, newBudget(15, 60), () => {});
    const ev = audit.evidence.find((e) => e.condition === "faults")!;
    assert.equal(audit.mutants.filter((m) => m.result === "caught").length, 0, "a process the kernel killed caught nothing");
    assert.equal(ev.result, "not_run", ev.summary);
    assert.match(ev.summary, /runs with planted faults were stopped at the audit's memory limit, so they count neither way/);
    assert.match(ev.blocked ?? "", /stopped at the audit's memory limit.*readiness replay --memory <MB>/);
    assert.equal(componentStates(audit, next, "app").faults.state, "blocked");
  });

  test("a strong suite stops after the first batch, a weak one too", async () => {
    for (const [caught, verdict, result] of [[true, "strong", "pass"], [false, "weak", "fail"]] as const) {
      const repo = gitRepo(files);
      const audit = faultAudit(repo, "2026-12-beta");
      await plantFaults(audit, repo, repo, fakeExecutor(repo, 1000, () => caught), next, audit.contract.find((c) => c.kind === "test")!, newBudget(15, 60), () => {});
      const ev = audit.evidence.find((e) => e.condition === "faults")!;
      assert.deepEqual([ev.estimate?.planted, ev.estimate?.verdict, ev.result], [5, verdict, result], ev.summary);
    }
  });

  // A sealed earlier audit that missed `missed` and caught `caught`, as the report names them.
  function sealEarlier(repo: string, missed: ReturnType<typeof chooseSites>, caught: ReturnType<typeof chooseSites> = []): void {
    const m = (s: (typeof missed)[number], i: number, result: string) => ({ id: `mut-app-${i + 1}`, component: "app", file: s.file, line: s.line, operator: s.operator, before: s.before, after: s.after, result, exitCodes: [result === "caught" ? 1 : 0], faultId: faultId(s) });
    const sealed = { mutants: [...missed.map((s, i) => m(s, i, "survived")), ...caught.map((s, i) => m(s, missed.length + i, "caught"))] };
    mkdirSync(join(repo, ".agent-readiness/history/audits/aud-earlier"), { recursive: true });
    writeFileSync(join(repo, ".agent-readiness/history/audits/aud-earlier/audit.json"), JSON.stringify(sealed));
    writeFileSync(join(repo, ".agent-readiness/history/history.jsonl"), JSON.stringify({ id: "aud-earlier", kind: "audit", date: "2026-11-20" }) + "\n");
  }

  test("tests written against the last report's named faults don't raise the verdict: only new faults count", async () => {
    const repo = gitRepo(files);
    const named = chooseSites(repo, repo, app(), "", 30, "HEAD", { identity: "fault" }).slice(10, 15);
    sealEarlier(repo, named);
    const audit = faultAudit(repo, "2026-12-beta");
    // The suite now catches exactly the five named faults, planted first, and nothing new.
    await plantFaults(audit, repo, repo, fakeExecutor(repo, 1000, (i) => i < 5), next, audit.contract.find((c) => c.kind === "test")!, newBudget(15, 60), () => {});
    const ev = audit.evidence.find((e) => e.condition === "faults")!;
    assert.deepEqual([ev.estimate?.carried, ev.estimate?.carriedCaught, ev.estimate?.caught, ev.estimate?.decided, ev.estimate?.verdict, ev.result], [5, 5, 0, 5, "weak", "fail"], ev.summary);
    const details = JSON.parse(readFileSync(join(repo, "..", "mutants.json"), "utf8")) as { faultId: string }[];
    assert.deepEqual(details.slice(0, 5).map((d) => d.faultId), named.map(faultId), "the named faults go first");
    assert.match(ev.summary, /^caught 0 of 5 new planted faults \(0%\): weak/);
    assert.match(ev.summary, /; 5 of the 5 faults the last audit missed are now caught, planted again and not counted/);
  });

  test("15 named faults now caught and 0 of 5 new is not strong, and named faults past the carry cap never come back as new", async () => {
    const repo = gitRepo(files);
    const named = chooseSites(repo, repo, app(), "", 30, "HEAD", { identity: "fault" }).slice(0, 15);
    sealEarlier(repo, named);
    const audit = faultAudit(repo, "2026-12-beta");
    const original = PRICING.split("\n");
    const namedEdits = new Set(named.map((s) => `${s.line}:${s.after}`));
    const ex = fakeExecutor(repo, 1000, () => false);
    const exec = ex.exec;
    // Caught exactly when the planted fault is one the report named.
    ex.exec = async (c, cwd, sec, o) => {
      const lines = readFileSync(join(repo, "app/src/pricing.js"), "utf8").split("\n");
      const at = lines.findIndex((l, i) => l !== original[i]);
      if (at < 0 || lines.join("\n").includes(CONTROL_COMMENT)) return exec(c, cwd, sec, o);
      const hit = namedEdits.has(`${at + 1}:${lines[at]}`);
      return { exitCode: hit ? 1 : 0, timedOut: false, durationMs: 1000, output: hit ? "# pass 4\n# fail 1\n" : "# pass 5\n# fail 0\n" };
    };
    await plantFaults(audit, repo, repo, ex, next, audit.contract.find((c) => c.kind === "test")!, newBudget(15, 60), () => {});
    const ev = audit.evidence.find((e) => e.condition === "faults")!;
    assert.notEqual(ev.estimate?.verdict, "strong", ev.summary);
    assert.deepEqual([ev.estimate?.carried, ev.estimate?.carriedCaught, ev.estimate?.caught, ev.estimate?.decided], [5, 5, 0, 5], ev.summary);
    const planted = (JSON.parse(readFileSync(join(repo, "..", "mutants.json"), "utf8")) as { faultId: string }[]).map((d) => d.faultId);
    const isNamed = new Set(named.map(faultId));
    assert.equal(planted.length, 10);
    assert.deepEqual(planted.slice(5).filter((id) => isNamed.has(id)), [], "a named fault past the carry cap is never planted as a new one");
  });

  test("two runs with planted faults that time out stop planting only when they come in a row", async () => {
    const run = async (timesOut: (i: number) => boolean) => {
      const repo = gitRepo(files);
      const audit = faultAudit(repo, "2026-12-beta");
      await plantFaults(audit, repo, repo, fakeExecutor(repo, 1000, () => true, timesOut), next, audit.contract.find((c) => c.kind === "test")!, newBudget(15, 60), () => {});
      return audit.evidence.find((e) => e.condition === "faults")!;
    };
    const apart = await run((i) => i === 0 || i === 4);
    assert.deepEqual([apart.estimate?.decided, apart.estimate?.verdict, apart.blocked], [5, "strong", undefined], apart.summary);
    const together = await run((i) => i === 1 || i === 2);
    assert.equal(together.estimate?.decided, 1);
    assert.match(together.blocked ?? "", /kept timing out/);
  });

  test("a run with a planted fault gets ten times the clean run, at least 30 seconds, never more than the fixed limit", async () => {
    const limits: number[] = [];
    const repo = gitRepo(files);
    const audit = faultAudit(repo, "2026-12-beta");
    const ex = fakeExecutor(repo, 1000, () => true);
    const exec = ex.exec;
    ex.exec = (c, cwd, sec, o) => (limits.push(sec), exec(c, cwd, sec, o));
    await plantFaults(audit, repo, repo, ex, next, audit.contract.find((c) => c.kind === "test")!, newBudget(15, 60), () => {}, 2000);
    assert.deepEqual([...new Set(limits)], [30]);
    limits.length = 0;
    await plantFaults(faultAudit(repo, "2026-12-beta"), repo, repo, ex, next, audit.contract.find((c) => c.kind === "test")!, newBudget(15, 60), () => {}, 12_000);
    assert.deepEqual([...new Set(limits)], [120]);
    limits.length = 0;
    await plantFaults(faultAudit(repo, "2026-12-beta"), repo, repo, ex, next, audit.contract.find((c) => c.kind === "test")!, newBudget(15, 60), () => {}, 90_000);
    assert.deepEqual([...new Set(limits)], [next.mutation.runTimeoutSec]);
  });

  test("tests that fail on a comment alone check the source's text, so no fault is planted and the check is undetermined", async () => {
    const repo = gitRepo(files);
    const audit = faultAudit(repo, "2026-12-beta");
    await plantFaults(audit, repo, repo, fakeExecutor(repo, 1000, () => true, () => false, true), next, audit.contract.find((c) => c.kind === "test")!, newBudget(15, 60), () => {});
    const ev = audit.evidence.find((e) => e.condition === "faults")!;
    assert.equal(audit.mutants.length, 0, "no fault was planted");
    assert.equal(ev.result, "not_run");
    assert.equal(ev.blocked, undefined);
    assert.match(ev.summary, /test command failed when only a comment was added to app\/src\/pricing\.js, a change that can't alter behaviour, so a failure with a planted fault couldn't be told from a failure on any edit/);
    assert.equal(componentStates(audit, next, "app").faults.state, "unknown");
    assert.equal(readFileSync(join(repo, "app/src/pricing.js"), "utf8"), PRICING, "the file is put back");
  });

  test("a suite that passes the comment-only run says so on its faults row", async () => {
    const repo = gitRepo(files);
    const audit = faultAudit(repo, "2026-12-beta");
    await plantFaults(audit, repo, repo, fakeExecutor(repo, 1000, () => true), next, audit.contract.find((c) => c.kind === "test")!, newBudget(15, 60), () => {});
    assert.match(audit.evidence.find((e) => e.condition === "faults")!.summary, /; a comment added to app\/src\/pricing\.js left the tests passing/);
  });

  test("the comment-only change is a comment in each language, and none where a line would be output", () => {
    assert.equal(withControlComment("a.py", "x = 1\n"), `x = 1\n# ${CONTROL_COMMENT}\n`);
    assert.equal(withControlComment("a.rb", "x = 1"), `x = 1\n# ${CONTROL_COMMENT}\n`);
    for (const f of ["a.ts", "a.mjs", "a.go", "a.rs", "A.java", "a.kt", "A.cs", "a.php"]) assert.equal(withControlComment(f, "x\r\n"), `x\r\n// ${CONTROL_COMMENT}\r\n`, f);
    assert.equal(withControlComment("a.php", "<?php echo 1; ?>\n"), null);
    assert.equal(withControlComment("a.vue", "<template/>\n"), null);
  });

  test("the 2026-11-beta rubric plants without the comment-only run, as its audits did", async () => {
    const repo = gitRepo(files);
    const audit = faultAudit(repo, "2026-11-beta");
    await plantFaults(audit, repo, repo, fakeExecutor(repo, 1000, () => true, () => false, true), beta, audit.contract.find((c) => c.kind === "test")!, newBudget(15, 60), () => {});
    assert.ok(audit.mutants.length > 0);
  });

  test("each fault's id is kept with its hidden details, not in the draft", async () => {
    const repo = gitRepo(files);
    const audit = faultAudit(repo, "2026-12-beta");
    await plantFaults(audit, repo, repo, fakeExecutor(repo, 1000, () => true), next, audit.contract.find((c) => c.kind === "test")!, newBudget(15, 60), () => {});
    assert.ok(audit.mutants.every((m) => m.faultId === undefined && m.file === undefined));
    const details = JSON.parse(readFileSync(join(repo, "..", "mutants.json"), "utf8")) as { faultId?: string }[];
    assert.ok(details.length === 5 && details.every((d) => /^[0-9a-f]{16}$/.test(d.faultId ?? "")));
  });
});

describe("instruction severities", () => {
  const item = (source: string, kind: InstructionItem["kind"], text: string): InstructionItem => ({ id: `ins-${source}`, source, line: 3, kind, text, category: kind === "path" ? "path" : "replay", staticResult: "pass", result: "fail", reason: "exits 1" });

  test("a wrong README command or link doesn't hold Level 2; a wrong AGENTS.md command does", () => {
    const states = (items: InstructionItem[], version = "2026-12-beta") => componentStates(makeAudit({ components: [{ id: "app", share: 1 }], instructions: items, rubric: version }), loadRubric(version), "app").instructions;
    const readme = [item("README.md", "command", "make docs"), item("README.md", "path", "docs/guide.md"), item("CONTRIBUTING.md", "command", "npm run e2e")];
    const met = states(readme);
    assert.equal(met.state, "met");
    assert.match(met.reason, /3 wrong items in the README, contributor guide or a path are listed and don't gate/);
    assert.equal(states([...readme, item("AGENTS.md", "command", "npm run check")]).state, "not_met");
    assert.equal(states([item(".cursor/rules/testing.mdc", "command", "npm run check")]).state, "not_met");
    assert.equal(states([item("AGENTS.md", "path", "src/old.ts")]).state, "met", "a stale path in AGENTS.md is listed, not gating");
    assert.equal(states(readme, "2026-11-beta").state, "not_met", "under 2026-11-beta every item gates");
  });

  test("a README command that couldn't be replayed doesn't leave the condition open", () => {
    const pending: InstructionItem = { ...item("README.md", "command", "make docs"), result: "not_run", reason: "waiting for replay" };
    assert.equal(componentStates(makeAudit({ components: [{ id: "app", share: 1 }], instructions: [pending] }), next, "app").instructions.state, "met");
  });
});

describe("kill-rate calibration rerun under the estimate", () => {
  const file = join(SUPPORT, "evals", "calibration", "kill-rate.json");
  const cal = JSON.parse(readFileSync(file, "utf8")) as { rubric: string; minForPass: number; rows: Tally[] };

  test("the recorded replay is current", () => {
    const recorded = JSON.parse(readFileSync(join(SUPPORT, "evals", "calibration", "fault-estimate.json"), "utf8")) as { rule: EstimateRule; table: EstimateRow[] };
    assert.deepEqual(recorded.rule, rule);
    assert.deepEqual(recorded.table, estimateTable(cal.rows, rule, minForPass, beta.mutation.killRate!));
  });

  test("on the calibration draws, the estimate gives one verdict from every starting draw more often than the kill rate, and fails no more suites", () => {
    const table = estimateTable(cal.rows, rule, minForPass, beta.mutation.killRate!);
    const stable = (vs: string[]) => new Set(vs.filter((v) => v !== "inconclusive" && v !== "not_run")).size <= 1;
    const estimateStable = table.filter((r) => stable(r.verdicts)).length;
    const killRateStable = table.filter((r) => stable(r.killRate)).length;
    assert.ok(estimateStable > killRateStable, `${estimateStable} vs ${killRateStable} of ${table.length}`);
    const fails = (vs: string[]) => vs.filter((v) => v === "weak" || v === "fail").length;
    assert.ok(table.reduce((s, r) => s + fails(r.verdicts), 0) <= table.reduce((s, r) => s + fails(r.killRate), 0));
  });
});
