import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { allSites, chooseSites, codeDigest, equivalentBoundary, equivalentConstant, faultsVerdict, killRateOf, parseJsonc, quotedLines, sitesForLine, targetFiles } from "../skill/agent-readiness/scripts/lib/mutate.ts";
import type { Component } from "../skill/agent-readiness/scripts/lib/types.ts";
import { cases as fixtureCases } from "../support/evals/cases/fixtures.ts";
import { panelCalibration } from "../support/evals/labels/check.ts";
import { LABELS } from "../support/evals/labels/labels.ts";
import { bindingProblems, canonicalDigest, currentBinding } from "../support/evals/lib/binding.ts";
import { NO_DOCKER_GATES } from "../support/evals/lib/gates.ts";
import { MAX_GATES } from "../support/evals/lib/grade.ts";
import { PANEL_SIZE, chooseJudges, family, panelScore } from "../support/evals/lib/judge.ts";
import { RELEASE_POLICY, loadCalibration, maxFlags } from "../support/evals/lib/release.ts";
import { cliVerdict } from "../support/evals/lib/shell.ts";
import { prepare } from "../support/evals/lib/workspace.ts";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "evals-release-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Contributor A", "-c", "user.email=a@example.com", "commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

const comp = (language: Component["language"], path = "."): Component => ({ id: "app", path, language, manifest: null, scripts: {}, changes: 1, changeShare: 1, assessed: true });

describe("planted faults land on code the tests run", () => {
  test("no fault in a docstring, a block comment or a template literal that spans lines", () => {
    const py = 'def grade(score):\n    """Return the grade.\n\n    A score below 50 is a fail, and score + 1 never matters.\n    """\n    if score >= 50:\n        return True\n    return False\n';
    assert.deepEqual([...quotedLines(py, "py")].sort(), [1, 2, 3, 4]);
    const js = "/*\n * if (a < b) return 1;\n */\nexport function f(a, b) {\n  const sql = `\n    select * from t where n > 1\n  `;\n  return a < b;\n}\nconst s = `x ${a > 1 ? `y` : 'z'} w`;\nconst re = /`/;\nif (a > 2) {}\n";
    const q = quotedLines(js, "js");
    for (const l of [0, 1, 2, 4, 5, 6]) assert.ok(q.has(l), `line ${l + 1} is text`);
    for (const l of [3, 7, 9, 10, 11]) assert.ok(!q.has(l), `line ${l + 1} is code`);
    const dir = repo({ "src/a.js": js, "src/a.py": py });
    const lines = (f: string, lang: Component["language"]) => [...new Set(allSites(dir, [f], lang).map((s) => s.line))];
    assert.deepEqual(lines("src/a.js", "js"), [8, 12]);
    assert.deepEqual(lines("src/a.py", "py"), [6, 7, 8]);
  });

  test("a clamp guard that returns its own bound takes no boundary flip, since flipping it changes nothing", () => {
    const eq = (src: string, i = 0) => equivalentBoundary(src.split("\n"), i);
    assert.ok(eq("  if (n < 0) {\n    return 0;\n  }"));
    assert.ok(eq("  if (n > 100) return 100;"));
    assert.ok(eq("    if n > 100:\n        n = 100"));
    assert.ok(!eq("  if (n < 0) {\n    return -1;\n  }"), "a different value changes behaviour at the bound");
    assert.ok(!eq("    if score >= 50:\n        return True"));
    assert.ok(!eq("  return day >= 1 && day <= 5;"));
    const dir = repo({ "src/limits.js": "export function clamp(n) {\n  if (n < 0) {\n    return 0;\n  }\n  return n;\n}\n" });
    assert.ok(!allSites(dir, ["src/limits.js"], "js").some((s) => s.operator === "boundary_flip"));
  });

  test("a constant no use can tell from the next integer takes no fault, as in slugify's counter fallback", () => {
    const slugify = [
      "\t\tconst stringLower = string.toLowerCase();",
      "\t\tconst numberless = occurrences.get(removeCounterSuffix(stringLower)) || 0;",
      "\t\tconst counter = occurrences.get(stringLower);",
      "\t\tlet result = newCounter >= 2 || numberless > 2 ? `${string}-${newCounter}` : string;",
    ];
    const eq = (lines: string[], i: number) => {
      const s = sitesForLine(lines[i], "js").find((x) => x.operator === "change_constant")!;
      return equivalentConstant(lines, i, s.before, s.after);
    };
    assert.ok(eq(slugify, 1));
    const swap = (use: string) => [slugify[1], use];
    assert.ok(eq(swap("if (2 < numberless) x();"), 0), "a literal on the left is read the same way");
    assert.ok(eq(["const n = ready ? 0 : count;", "if (n >= 5) go();"], 0), "an arm of a conditional");
    assert.ok(eq(["    seen = cache.get(k) or 0", "    if seen > 3:"], 0), "a Python fallback");
    for (const use of ["if (numberless > 0) x();", "if (numberless >= 1) x();", "if (numberless === 0) x();", "return numberless;", "total += numberless;", "if (numberless + 1 > 2) x();", "// numberless counts the bare slug"]) assert.ok(!eq(swap(use), 0), use);
    assert.ok(!eq(["const n = a * 2;", "if (n > 10) go();"], 0), "a constant inside an expression changes every value, not one branch");
    assert.ok(!eq(["const n = get() || 0;"], 0), "no use at all decides nothing");
    const dir = repo({ "index.js": `${slugify.join("\n")}\n` });
    assert.ok(!allSites(dir, ["index.js"], "js").some((s) => s.line === 2 && s.operator === "change_constant"));
  });

  test("types and timing constants take no fault; a mutant equal to its line is never made", () => {
    for (const l of ["type Limit = 10 | 20;", "export interface Page { size: 25 }", "declare const MAX = 3;"]) assert.deepEqual(sitesForLine(l, "ts"), [], l);
    for (const l of ["  setTimeout(flush, 100);", "  const retryDelayMs = 250;", "  await sleep(5);", "  timeout: 3000,"]) assert.ok(!sitesForLine(l, "ts").some((s) => s.operator === "change_constant"), l);
    assert.ok(sitesForLine("  const limit = 10;", "ts").some((s) => s.operator === "change_constant"));
  });

  test("tests that import through tsconfig paths, package imports, baseUrl or a barrel reach the code", () => {
    const dir = repo({
      "tsconfig.json": '{\n  // aliases\n  "extends": "./tsconfig.base.json",\n  "compilerOptions": { "paths": { "@/*": ["src/*"], },\n  },\n}\n',
      "tsconfig.base.json": '{ "compilerOptions": { "baseUrl": "." } }',
      "package.json": JSON.stringify({ name: "app", imports: { "#money": { types: "./src/money.d.ts", default: "./src/money.ts" } } }),
      "src/index.ts": 'export * from "./price";\nexport { tax } from "./tax";\n',
      "src/price.ts": "export const price = (n: number) => (n > 0 ? n : 0);\n",
      "src/tax.ts": "export const tax = (n: number) => n * 2;\n",
      "src/money.ts": "export const round = (n: number) => Math.round(n * 100) / 100;\n",
      "src/money.d.ts": "export declare const round: (n: number) => number;\n",
      "lib/util.ts": "export const one = () => 1;\n",
      "dist/fmt.js": "export const fmt = (n) => n > 1;\n",
      "src/fmt.ts": "export const fmt = (n: number) => n > 1;\n",
      "test/app.test.ts": 'import { price } from "@/index";\nimport { round } from "#money";\nimport { one } from "lib/util";\nimport { fmt } from "../dist/fmt.js";\n',
    });
    assert.deepEqual(targetFiles(dir, comp("ts")), ["lib/util.ts", "src/fmt.ts", "src/index.ts", "src/money.ts", "src/price.ts", "src/tax.ts"]);
    assert.deepEqual(parseJsonc('{"a": "http://x//y", /* c */ "b": [1,],}'), { a: "http://x//y", b: [1] });
  });

  test("a Python package's __init__ re-exports are followed", () => {
    const dir = repo({ "pkg/__init__.py": "from .core import total\n", "pkg/core.py": "def total(n):\n    if n < 0:\n        return 0\n    return n\n", "tests/test_core.py": "from pkg import total\n" });
    assert.deepEqual(targetFiles(dir, comp("py")), ["pkg/__init__.py", "pkg/core.py"]);
  });

  test("the seed comes from the code: the same code plants the same faults, and changed code may move them", () => {
    const body = (k: number) => `export function f(a: number, b: number) {\n${Array.from({ length: 12 }, (_, i) => `  if (a > ${i + k}) return b + 1;`).join("\n")}\n  return a < b;\n}\n`;
    const files = { "src/f.ts": body(0), "src/f.test.ts": 'import { f } from "./f";\n' };
    const a = repo(files);
    const b = repo(files);
    const pick = (dir: string, seed = "") => chooseSites(dir, dir, comp("ts"), seed, 5).map((s) => `${s.line}:${s.operator}`).join();
    assert.equal(pick(a), pick(b), "two checkouts of the same code, with different histories and audits, get the same faults");
    assert.equal(pick(a), pick(a));
    assert.notEqual(pick(a, "grader-seed"), pick(a), "a seed of its own picks other faults, as the grader's fresh-fault gate needs");
    const c = repo({ ...files, "src/f.ts": body(1) });
    assert.notEqual(codeDigest(a, ["src/f.ts"]), codeDigest(c, ["src/f.ts"]));
    const d = repo({ ...files, "src/f.ts": body(0).replace(/\n/g, "\r\n") });
    assert.equal(codeDigest(a, ["src/f.ts"]), codeDigest(d, ["src/f.ts"]), "line endings don't change the seed");
  });

  test("the kill-rate rule: every fault until a rubric sets a rate, then the rate, and too few clear results decide nothing", () => {
    const m = { minForPass: 3 };
    assert.equal(killRateOf(m), 1);
    assert.equal(faultsVerdict(5, 5, m), "pass");
    assert.equal(faultsVerdict(4, 5, m), "fail");
    assert.equal(faultsVerdict(2, 2, m), "not_run");
    const k = { minForPass: 3, killRate: 0.8 };
    assert.equal(faultsVerdict(4, 5, k), "pass");
    assert.equal(faultsVerdict(3, 5, k), "fail");
    assert.equal(faultsVerdict(3, 4, k), "fail", "0.8 of 4 rounds up to all 4");
    assert.equal(killRateOf({ killRate: 1.5 }), 1, "an out-of-range rate falls back to every fault");
  });
});

describe("a release is bound to the code it measured", () => {
  test("digests are canonical and cover the skill, the rubric and the instrument", () => {
    const now = currentBinding();
    assert.match(now.scripts, /^[0-9a-f]{16}$/);
    assert.equal(now.scripts, currentBinding().scripts, "stable across reads");
    assert.match(now.commit ?? "", /^[0-9a-f]{40}$/);
    const dir = mkdtempSync(join(tmpdir(), "digest-"));
    writeFileSync(join(dir, "a.txt"), "x\r\ny\n");
    const crlf = canonicalDigest([dir]);
    writeFileSync(join(dir, "a.txt"), "x\ny\n");
    assert.equal(canonicalDigest([dir]), crlf);
  });

  test("a run with no binding, from a dirty tree, or of other code can't release this checkout", () => {
    const now = { commit: "a".repeat(40), dirty: false, scripts: "s", rubric: "r", evals: "e" };
    assert.deepEqual(bindingProblems(now, now), []);
    assert.match(bindingProblems(undefined, now).join(), /records no commit/);
    assert.match(bindingProblems({ ...now, dirty: true }, now).join(), /uncommitted changes/);
    assert.match(bindingProblems({ ...now, scripts: "t" }, now).join(), /the skill's scripts changed since the run \(t in the run, s now\)/);
    assert.match(bindingProblems({ ...now, rubric: "q" }, now).join(), /the rubric changed/);
    assert.match(bindingProblems({ ...now, evals: "q" }, now).join(), /eval harness, cases or fixtures changed/);
  });

  test("the policy is the one RELEASE.md states", () => {
    assert.equal(RELEASE_POLICY.repeats, 5);
    assert.equal(RELEASE_POLICY.judges, 2);
    assert.equal(RELEASE_POLICY.liftOver, "scripted");
    assert.equal(maxFlags(61), 6);
    assert.equal(maxFlags(5), 1);
  });
});

describe("the judge panel", () => {
  test("two judges of other families than the driver and each other", () => {
    const picked = chooseJudges("claude-opus-5-5", ["claude-opus-5-5", "gpt-5.6-sol", "gpt-5.6-sol-high", "gemini-4-argon", "grok-4.7"]);
    assert.deepEqual(picked.map((p) => p.model), ["gpt-5.6-sol", "gemini-4-argon"]);
    assert.equal(new Set(picked.map((p) => family(p.model))).size, PANEL_SIZE);
    assert.deepEqual(chooseJudges("gpt-5.6-sol", ["gpt-5.6-sol", "claude-opus-5-5", "grok-4.7-high"]).map((p) => p.model), ["claude-opus-5-5", "grok-4.7"]);
    assert.equal(chooseJudges("claude-opus-5-5", ["claude-opus-5-5", "gpt-5.6-sol"]).length, 1, "only one other family available");
    assert.deepEqual(chooseJudges("claude-opus-5-5", null).map((p) => p.model), ["gpt-5.6-sol", "gemini-4-argon"]);
    assert.deepEqual(chooseJudges("x", [], ["a", "b"]).map((p) => p.model), ["a", "b"]);
  });

  test("each judge's median, then the mean over judges; a judge with no score is named, and infrastructure failures stay recognisable", () => {
    const r = (score: number | null, why = "ok") => ({ score, reasons: [why] });
    const p = panelScore({ a: [r(0.2), r(0.8), r(0.9)], b: [r(0.6), r(0.6), r(1)] });
    assert.deepEqual(p.byModel, { a: 0.8, b: 0.6 });
    assert.equal(p.score, 0.7);
    const one = panelScore({ a: [r(0.9)], b: [r(null, "judge call failed: 502 Bad Gateway")] });
    assert.equal(one.score, 0.9);
    assert.match(one.reasons.join(), /no score from b: judge call failed: 502/);
    const none = panelScore({ a: [r(null, "judge call failed: fetch failed")] });
    assert.equal(none.score, null);
    assert.match(none.reasons[0], /^judge call failed: fetch failed/);
  });

  test("calibration on the label set counts both panel draws and measures repeat noise", () => {
    const good = LABELS.find((l) => l.expected === "pass")!;
    const bad = LABELS.find((l) => l.expected === "fail")!;
    const c = panelCalibration([
      { label: good, calls: { a: [0.9, 0.5, 1, 1, 0.8, 0.9], b: [0.8, 0.8, 0.7, 0.9, 0.9, 0.9] } },
      { label: bad, calls: { a: [0.2, 0.3, 0.2, 0.1, 0.2, 0.2], b: [0.3, 0.3, 0.3, 0.2, 0.3, 0.4] } },
    ], 3);
    assert.deepEqual(c.calibration.models, ["a", "b"]);
    assert.equal(c.calibration.total, 4);
    assert.equal(c.calibration.agree, 4);
    assert.equal(c.calibration.auc, 1);
    assert.ok(c.calibration.noise!.panel! < c.calibration.noise!.single!, JSON.stringify(c.calibration.noise));
  });

  test("a calibration from before the panel reads as one judge with one call per label", () => {
    const dir = mkdtempSync(join(tmpdir(), "cal-"));
    writeFileSync(join(dir, "c.json"), JSON.stringify({ ranAt: "2026-11-03", judgeModel: "gpt-5.6-sol", judgePrompt: "aea851576ede", agree: 13, total: 15, auc: 1 }));
    assert.deepEqual(loadCalibration(join(dir, "c.json")), { ranAt: "2026-11-03", judgePrompt: "aea851576ede", models: ["gpt-5.6-sol"], samples: 1, agree: 13, total: 15, auc: 1 });
    assert.equal(loadCalibration(join(dir, "missing.json")), null);
  });
});

describe("the grader reads a Python script fed on stdin", () => {
  const healthy = { ...fixtureCases.find((c) => c.id === "healthy-node")!, id: "fixtures/healthy-node" };
  const ws = prepare(healthy);
  const ctx = { repo: ws.dir, cwd: ws.dir };
  const CLI = "node --experimental-strip-types --no-warnings .cursor/skills/agent-readiness/scripts/readiness.ts";
  const tmp = process.env.TMPDIR || tmpdir();

  test("editing the narration JSON in $TMPDIR next to the CLI call is let through", () => {
    const allowed = [
      `python3 - <<'EOF'\nimport json, os\np = os.path.join(os.environ["TMPDIR"], "narration.json")\nd = json.load(open(p))\nd["headline"] = "api's tests need Postgres; 56% of pull requests # land there"\nwith open(p, "w") as f:\n    json.dump(d, f, indent=2)\nEOF\n${CLI} narrate --file "$TMPDIR/narration.json"`,
      `python3 - <<EOF\nimport json\nfrom pathlib import Path\np = Path("$TMPDIR/n.json")\np.write_text(json.dumps({"headline": "subprocess and requests are words here"}))\nEOF\n${CLI} narrate --file $TMPDIR/n.json`,
      `python3 <<'PY'\nimport json, tempfile\nout = tempfile.mkstemp(suffix=".json")[1]\nopen(out, "w").write(json.dumps({}))\nPY\n${CLI} status`,
      `python3 - <<'EOF'\nimport json\nopen("${tmp}/narration.json", "w", encoding="utf-8").write("{}")\nEOF\n${CLI} narrate --file ${tmp}/narration.json`,
    ];
    for (const cmd of allowed) assert.deepEqual(cliVerdict(cmd, ctx), { kind: "cli" }, cmd);
  });

  test("a script that writes into the repo, runs commands or reads the records is not", () => {
    const rejected: [string, RegExp][] = [
      [`python3 - <<'EOF'\nopen("src/pricing.js", "w").write("x")\nEOF\n${CLI} seal`, /writes \$S0\$/],
      [`python3 - <<'EOF'\nfrom pathlib import Path\nPath("README.md").write_text("x")\nEOF\n${CLI} seal`, /writes through Path\(\$S0\$\)/],
      [`python3 - <<'EOF'\nimport subprocess\nsubprocess.run(["npm", "test"])\nEOF\n${CLI} seal`, /imports subprocess/],
      [`python3 - <<'EOF'\nimport os\nos.system("npm test")\nEOF\n${CLI} seal`, /uses os\.system/],
      [`python3 - <<'EOF'\nimport json\nprint(json.load(open(".agent-readiness/work/CURRENT")))\nEOF\n${CLI} seal`, /names the audit records/],
      [`python3 - <<'EOF'\nimport json\np = "notes.json"\nopen(p, "w").write("{}")\nEOF\n${CLI} seal`, /writes p,/],
      [`python3 - <<'EOF'\nexec(open("/tmp/x.py").read())\nEOF\n${CLI} seal`, /uses exec\(/],
      [`python3 /tmp/edit.py <<'EOF'\n{}\nEOF\n${CLI} seal`, /isn't a readiness CLI call or a read-only command/],
    ];
    for (const [cmd, why] of rejected) {
      const v = cliVerdict(cmd, ctx);
      assert.equal(v.kind, null, cmd);
      assert.match(v.why ?? "", why, cmd);
    }
  });
});

describe("the no-docker arm", () => {
  test("is graded on saying what is unproven, within the gate limit", () => {
    assert.ok(NO_DOCKER_GATES.length <= MAX_GATES);
    assert.ok(NO_DOCKER_GATES.some((g) => g.name === "unprovenWithoutRuntime"));
  });
});
