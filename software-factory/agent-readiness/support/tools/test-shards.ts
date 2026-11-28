import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ShardCounts } from "./shard-reporter.ts";

// CI splits npm test across runners with --test-shard. A shard that silently runs nothing, or a file
// that lands in no shard, would pass unseen, so this checks the shards' counts against the full list:
// every test file in tests/ ran in exactly one shard, each with at least one test, none skipped, and
// each shard's own summary ("# tests N" in its TAP log) equals the tests its counts add up to.
//
// node support/tools/test-shards.ts tests <shard dir>...   each shard dir holds counts.json and test.log, run from the accelerator

export interface Shard {
  name: string;
  counts: ShardCounts;
  summary: number | null;
}

export function shardProblems(testFiles: string[], shards: Shard[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string[]>();
  for (const s of shards) {
    const files = Object.keys(s.counts.files);
    if (!files.length) problems.push(`${s.name} ran no test file`);
    let total = 0;
    for (const f of files) {
      const c = s.counts.files[f];
      seen.set(f, [...(seen.get(f) ?? []), s.name]);
      total += c.tests;
      if (c.skipped) problems.push(`${s.name}: ${f} skipped ${c.skipped} test(s)`);
    }
    if (s.summary === null) problems.push(`${s.name}'s log has no "# tests N" summary; it didn't finish`);
    else if (s.summary !== total) problems.push(`${s.name}'s log says ${s.summary} tests, its counts add up to ${total}`);
  }
  for (const f of testFiles) {
    const where = seen.get(f) ?? [];
    if (!where.length) problems.push(`${f} ran in no shard`);
    else if (where.length > 1) problems.push(`${f} ran in ${where.length} shards: ${where.join(", ")}`);
  }
  for (const f of seen.keys()) if (!testFiles.includes(f)) problems.push(`${f} ran, but isn't a test file in tests/`);
  return problems;
}

export function summaryOf(log: string): number | null {
  const m = /^# tests (\d+)$/m.exec(log);
  return m ? Number(m[1]) : null;
}

function main(argv: string[]): void {
  const [testsDir, ...shardDirs] = argv;
  if (!testsDir || !shardDirs.length) {
    process.stderr.write("usage: test-shards.ts <tests dir> <shard dir>...\n");
    process.exit(2);
  }
  const testFiles = readdirSync(testsDir).filter((n) => n.endsWith(".test.ts")).map((n) => `tests/${n}`).sort();
  const shards: Shard[] = shardDirs.map((d) => {
    const counts = JSON.parse(readFileSync(join(d, "counts.json"), "utf8")) as ShardCounts;
    return { name: basename(d), counts, summary: summaryOf(readFileSync(join(d, "test.log"), "utf8")) };
  });
  const problems = shardProblems(testFiles, shards);
  for (const s of shards) {
    const n = Object.values(s.counts.files).reduce((a, c) => a + c.tests, 0);
    process.stdout.write(`${s.name}: ${Object.keys(s.counts.files).length} files, ${n} tests\n`);
  }
  const all = shards.reduce((a, s) => a + Object.values(s.counts.files).reduce((b, c) => b + c.tests, 0), 0);
  process.stdout.write(`${testFiles.length} test files in tests/, ${all} tests across ${shards.length} shards.\n`);
  if (problems.length) {
    for (const p of problems) process.stdout.write(`::error::${p}\n`);
    process.exit(1);
  }
  process.stdout.write("Every test file ran in exactly one shard.\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
