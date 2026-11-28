import { relative, sep } from "node:path";

// A node --test reporter that writes, as JSON, how many tests ran in each test file, so CI can check
// that its npm test shards together ran every file once (support/tools/test-shards.ts). It reads the
// runner's own summary of each file, since a test's own file is where test() was called, which for a
// guard is known-failures.ts. Files are named from the working directory, the accelerator when run
// by npm test.
//
// node --test --test-reporter=./support/tools/shard-reporter.ts --test-reporter-destination=counts.json ...

interface Event {
  type: string;
  data: { file?: string; counts?: { tests: number; failed: number; skipped: number; todo: number } };
}

export interface ShardCounts {
  files: Record<string, { tests: number; failed: number; skipped: number }>;
}

export default async function* shardReporter(source: AsyncIterable<Event>): AsyncGenerator<string> {
  const counts: ShardCounts = { files: {} };
  for await (const e of source) {
    if (e.type !== "test:summary" || !e.data.file || !e.data.counts) continue;
    const c = e.data.counts;
    counts.files[relative(process.cwd(), e.data.file).split(sep).join("/")] = { tests: c.tests, failed: c.failed, skipped: c.skipped + c.todo };
  }
  yield JSON.stringify(counts, null, 2) + "\n";
}
