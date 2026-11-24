import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { describe, test } from "node:test";
import { releaseVerdict } from "../support/evals/lib/release.ts";
import { summarize } from "../support/evals/lib/baseline.ts";
import { CRITICAL } from "../support/holdout/score.ts";
import { ACCELERATOR, SUPPORT, truthFixtureNames } from "../support/tools/fixture.ts";
import { FIXED_BY, KNOWN_FAILURES_FILE, knownFailures } from "../support/tools/known-failures.ts";

const TRIALS = "support/trials/trials.test.ts";
const DEV_TRUTH = "tests/dev-truth.test.ts";
const TRUTH_CODES = new Set<string>([...CRITICAL, "R1", "R2", "R3", "R6"]);

// Whether a guard by this name exists: written out in its file, or generated per trial or truth
// fixture by the loops in trials.test.ts and dev-truth.test.ts.
function guardExists(file: string, name: string): boolean {
  const src = readFileSync(join(ACCELERATOR, file), "utf8");
  if (!/\bguard\(/.test(src)) return false;
  if (src.includes(JSON.stringify(name)) || src.includes(`\`${name}\``) || src.includes(`"${name}"`)) return true;
  const trials = (JSON.parse(readFileSync(join(SUPPORT, "trials", "trials.json"), "utf8")).trials as { id: string }[]).map((t) => t.id);
  for (const id of [...trials, ...truthFixtureNames()]) {
    if (!name.startsWith(`${id} `) && !name.startsWith(`${id}:`)) continue;
    const rest = name.slice(id.length);
    const truth = /^ truth (\S+)$/.exec(rest);
    if (truth && TRUTH_CODES.has(truth[1]) && ((file === TRIALS && trials.includes(id)) || (file === DEV_TRUTH && truth[1] !== "R3"))) return true;
    if (src.includes(`\`\${name}${rest}\``)) return true;
  }
  return false;
}

describe("tests/known-failures.json", () => {
  const list = knownFailures();

  test("each entry names a guard that exists, the finding it guards and the PR that fixes it", () => {
    assert.ok(existsSync(KNOWN_FAILURES_FILE));
    const seen = new Set<string>();
    for (const k of list) {
      const key = `${k.file} :: ${k.test}`;
      assert.ok(!seen.has(key), `listed twice: ${key}`);
      seen.add(key);
      assert.ok(existsSync(join(ACCELERATOR, k.file)), `${k.file} doesn't exist`);
      assert.ok(guardExists(k.file, k.test), `no guard named "${k.test}" in ${k.file}`);
      assert.ok(k.finding.trim().length > 0, `${key} names no finding`);
      assert.ok((FIXED_BY as readonly string[]).includes(k.fixedBy), `${key}: fixedBy ${k.fixedBy} isn't one of ${FIXED_BY.join(", ")}`);
      assert.deepEqual(Object.keys(k).sort(), ["file", "finding", "fixedBy", "test"], `${key} has only file, test, finding and fixedBy`);
    }
  });

  test("no file with guards marks a test todo, which CI's no-skips check fails", () => {
    for (const dir of ["tests", "support/trials"]) {
      for (const f of readdirSync(join(ACCELERATOR, dir)).filter((n) => n.endsWith(".test.ts"))) {
        const src = readFileSync(join(ACCELERATOR, dir, f), "utf8");
        if (/\bguards\(import\.meta\.url\)/.test(src)) assert.doesNotMatch(src, /\btodo\s*:|\.todo\(/, `${dir}/${f} marks a test todo; list it in tests/known-failures.json instead`);
      }
    }
  });

  test("a listed guard passes while it fails and fails once it passes; strict mode shows it red", () => {
    const dir = mkdtempSync(join(tmpdir(), "known-failures-"));
    const file = join(dir, "sample.test.ts");
    writeFileSync(file, [
      `import { guards } from ${JSON.stringify(join(ACCELERATOR, "support", "tools", "known-failures.ts"))};`,
      "const guard = guards(import.meta.url);",
      'guard("listed and still failing", () => { throw new Error("the bug"); });',
      'guard("listed but fixed", () => {});',
      'guard("not listed", () => {});',
    ].join("\n"));
    const rel = relative(ACCELERATOR, file).split(sep).join("/");
    const list = join(dir, "known.json");
    writeFileSync(list, JSON.stringify({ failures: ["listed and still failing", "listed but fixed"].map((test) => ({ file: rel, test, finding: "sample", fixedBy: "B" })) }));
    const run = (strict: boolean) => {
      // A node --test run inside another reports to its parent unless this is unset.
      const { NODE_TEST_CONTEXT: _, ...env } = process.env;
      return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", "--test-reporter=tap", file], { encoding: "utf8", env: { ...env, SA_KNOWN_FAILURES_FILE: list, SA_KNOWN_FAILURES: strict ? "strict" : "" } }).stdout;
    };
    const out = run(false);
    assert.match(out, /^ok \d+ - listed and still failing$/m);
    assert.match(out, /# known failure \(sample, fixed by PR B\): the bug/);
    assert.match(out, /^not ok \d+ - listed but fixed$/m);
    assert.match(out, /remove its entry/);
    assert.match(out, /^ok \d+ - not listed$/m);
    assert.match(run(true), /^not ok \d+ - listed and still failing$/m);
  });

  test("a release check fails while the list has entries", () => {
    const b = summarize([], { model: "m", driver: "sdk", repeats: 5, judgePrompt: "p" });
    assert.ok(releaseVerdict(b, { knownFailures: 3 }).lines.includes("FAIL tests/known-failures.json lists 3 guards the tool doesn't meet yet; a release needs none"));
    assert.ok(releaseVerdict(b, { knownFailures: 0 }).lines.includes("OK no known failures: every guard in tests/ and the trials passes"));
  });
});
