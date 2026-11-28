import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { sideOf } from "../support/tools/instrument-freeze.ts";
import { shardProblems, summaryOf } from "../support/tools/test-shards.ts";
import type { Shard } from "../support/tools/test-shards.ts";

const ci = readFileSync(join(import.meta.dirname, "..", "..", "..", ".github/workflows/agent-readiness.yml"), "utf8");
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { scripts: Record<string, string> };

function shard(name: string, files: Record<string, number>, summary?: number | null): Shard {
  const counts = { files: Object.fromEntries(Object.entries(files).map(([f, n]) => [f, { tests: n, failed: 0, skipped: 0 }])) };
  return { name, counts, summary: summary === undefined ? Object.values(files).reduce((a, b) => a + b, 0) : summary };
}

describe("npm test shards", () => {
  const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"];

  test("pass when every file ran once and each log's summary matches its counts", () => {
    assert.deepEqual(shardProblems(files, [shard("s1", { "tests/a.test.ts": 3, "tests/c.test.ts": 1 }), shard("s2", { "tests/b.test.ts": 5 })]), []);
  });

  test("fail a shard that ran nothing, a file in no shard or in two, and a summary that disagrees", () => {
    assert.deepEqual(shardProblems(files, [shard("s1", { "tests/a.test.ts": 3, "tests/b.test.ts": 5, "tests/c.test.ts": 1 }), shard("s2", {})]), ["s2 ran no test file"]);
    assert.deepEqual(shardProblems(files, [shard("s1", { "tests/a.test.ts": 3 }), shard("s2", { "tests/b.test.ts": 5 })]), ["tests/c.test.ts ran in no shard"]);
    assert.deepEqual(shardProblems(files, [shard("s1", { "tests/a.test.ts": 3, "tests/c.test.ts": 1 }), shard("s2", { "tests/b.test.ts": 5, "tests/c.test.ts": 1 })]), ["tests/c.test.ts ran in 2 shards: s1, s2"]);
    assert.deepEqual(shardProblems(files, [shard("s1", { "tests/a.test.ts": 3, "tests/b.test.ts": 5, "tests/c.test.ts": 1 }, 8)]), ["s1's log says 8 tests, its counts add up to 9"]);
    assert.deepEqual(shardProblems(files, [shard("s1", { "tests/a.test.ts": 3, "tests/b.test.ts": 5, "tests/c.test.ts": 1 }, null)]), [`s1's log has no "# tests N" summary; it didn't finish`]);
    assert.deepEqual(shardProblems(["tests/a.test.ts"], [shard("s1", { "tests/a.test.ts": 3, "tests/z.test.ts": 1 })]), ["tests/z.test.ts ran, but isn't a test file in tests/"]);
    const skipped = shard("s1", { "tests/a.test.ts": 3 });
    skipped.counts.files["tests/a.test.ts"].skipped = 1;
    assert.deepEqual(shardProblems(["tests/a.test.ts"], [skipped]), ["s1: tests/a.test.ts skipped 1 test(s)"]);
  });

  test("read a TAP log's summary", () => {
    assert.equal(summaryOf("ok 1 - x\n1..1\n# tests 12\n# suites 2\n"), 12);
    assert.equal(summaryOf("ok 1 - x\n"), null);
  });

  test("the reporter, the checker and no-skips are instrument", () => {
    for (const f of ["support/tools/shard-reporter.ts", "support/tools/test-shards.ts", "support/tools/no-skips.sh"]) assert.equal(sideOf(f), "instrument", f);
  });

  test("CI's test matrix matches SA_TEST_SHARD, and the check job checks every shard's counts", () => {
    const list = /test:\n[\s\S]*?shard: \[([\d, ]+)\]/.exec(ci)?.[1].split(",").map((s) => Number(s.trim()));
    const count = Number(/SA_TEST_SHARD: \$\{\{ matrix\.shard \}\}\/(\d+)/.exec(ci)?.[1]);
    assert.ok(list && count, "the test job has a shard matrix and sets SA_TEST_SHARD");
    assert.deepEqual(list, Array.from({ length: count }, (_, i) => i + 1));
    assert.match(ci, /name: npm test \(Docker, no skips, shard \$\{\{ matrix\.shard \}\}\/(\d+)\)/);
    assert.match(ci, /SA_TEST_COUNTS="\$RUNNER_TEMP\/shard\/counts\.json" npm test 2>&1 \| tee "\$RUNNER_TEMP\/shard\/test\.log"/);
    assert.match(ci, /no-skips\.sh "\$RUNNER_TEMP\/shard\/test\.log"/);
    const check = ci.slice(ci.indexOf("\n  check:\n"), ci.indexOf("\n  trials:\n"));
    assert.match(check, /name: npm run check \(Docker, no skips\)/, "the gate's check keeps its name");
    assert.match(check, /needs: test\n    if: \$\{\{ !cancelled\(\) \}\}/);
    assert.match(check, /npm run typecheck/);
    assert.match(check, /test-shards\.ts tests "\$RUNNER_TEMP"\/shards\/test-shard-\*/);
    assert.match(check, /test "\$\{\{ needs\.test\.result \}\}" = success/);
  });

  test("npm test passes the shard and the counts through only when they are set", () => {
    assert.match(pkg.scripts.test, /\$\{SA_TEST_SHARD:\+--test-shard=\$SA_TEST_SHARD\}/);
    assert.match(pkg.scripts.test, /\$\{SA_TEST_COUNTS:\+--test-reporter=tap --test-reporter-destination=stdout --test-reporter=\.\/support\/tools\/shard-reporter\.ts --test-reporter-destination=\$SA_TEST_COUNTS\}/);
    assert.ok(pkg.scripts.test.endsWith(" tests/*.test.ts"));
  });
});
