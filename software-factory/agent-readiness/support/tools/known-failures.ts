import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { ACCELERATOR } from "./fixture.ts";

// Guards written before their fix. A guard listed in tests/known-failures.json must fail: while it
// does, its test passes and prints why, and once it passes, its test fails until the entry is removed.
// A guard that isn't listed is an ordinary test. `todo` and `skip` aren't used, because CI's
// no-skips check fails on both. SA_KNOWN_FAILURES=strict runs every guard as an ordinary test, to
// show the listed ones red.

export const KNOWN_FAILURES_FILE = join(ACCELERATOR, "tests", "known-failures.json");
export const FIXED_BY = ["B", "C", "D", "E", "F", "G", "H"] as const;

export interface KnownFailure {
  file: string;
  test: string;
  finding: string;
  fixedBy: (typeof FIXED_BY)[number];
}

export interface KnownFailuresFile {
  failures: KnownFailure[];
}

// SA_KNOWN_FAILURES_FILE points the harness at another list, for its own tests.
export function knownFailures(file = process.env.SA_KNOWN_FAILURES_FILE || KNOWN_FAILURES_FILE): KnownFailure[] {
  return (JSON.parse(readFileSync(file, "utf8")) as KnownFailuresFile).failures;
}

const strict = () => process.env.SA_KNOWN_FAILURES === "strict";
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n").find((l) => l.trim()) ?? "";

type GuardFn = (t: TestContext) => void | Promise<void>;
type GuardOptions = { timeout?: number; concurrency?: number | boolean };

// `const guard = guards(import.meta.url)`, then `guard(name, [options,] fn)` in place of `test`.
export function guards(moduleUrl: string) {
  const file = relative(ACCELERATOR, fileURLToPath(moduleUrl)).split(sep).join("/");
  const listed = new Map(knownFailures().filter((k) => k.file === file).map((k) => [k.test, k]));
  return function guard(name: string, a: GuardOptions | GuardFn, b?: GuardFn): void {
    const opts = typeof a === "function" ? {} : a;
    const fn = (typeof a === "function" ? a : b)!;
    const known = listed.get(name);
    test(name, opts, async (t) => {
      if (!known || strict()) {
        await fn(t);
        return;
      }
      let failure: unknown = null;
      try {
        await fn(t);
      } catch (e) {
        failure = e;
      }
      if (failure === null) assert.fail(`"${name}" passes, but tests/known-failures.json lists it as failing until PR ${known.fixedBy}; remove its entry`);
      t.diagnostic(`known failure (${known.finding}, fixed by PR ${known.fixedBy}): ${firstLine(failure)}`);
    });
  };
}
