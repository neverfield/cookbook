import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CRITICAL } from "../support/holdout/score.ts";
import { SUPPORT } from "../support/tools/fixture.ts";
import { knownFailures } from "../support/tools/known-failures.ts";
import { acquireHost } from "../support/trials/host-lock.ts";
import { minutesOf, parseShard, shards } from "../support/trials/shards.ts";

interface TrialEntry {
  id: string;
  repo: string;
  minutes: number;
  tier?: string;
  budgetEdge?: boolean;
  tracking?: Record<string, string>;
  alsoRun?: string[];
  recordedAlso?: Record<string, unknown>;
}

const trials = (JSON.parse(readFileSync(join(SUPPORT, "trials", "trials.json"), "utf8")) as { trials: TrialEntry[] }).trials;
const ci = readFileSync(join(import.meta.dirname, "..", "..", "..", ".github/workflows/agent-readiness.yml"), "utf8");
const TRUTH_CODES = [...CRITICAL.filter((c) => c !== "K7"), "R1", "R2", "R3", "R6"];

describe("trial shards", () => {
  test("every trial lands in exactly one shard, the same way each time, and the shards are balanced", () => {
    for (const n of [1, 2, 3, 4]) {
      const split = shards(trials, n);
      assert.equal(split.length, n);
      assert.deepEqual(split.flat().map((t) => t.id).sort(), trials.map((t) => t.id).sort());
      assert.deepEqual(shards([...trials].reverse(), n).map((s) => s.map((t) => t.id)), split.map((s) => s.map((t) => t.id)), "the order of trials.json doesn't move a trial");
      const loads = split.map(minutesOf);
      assert.ok(Math.max(...loads) - Math.min(...loads) <= Math.max(...trials.map((t) => t.minutes)) + 1e-9, `shards of ${loads.join(", ")} minutes`);
    }
  });

  test("SA_TRIALS_SHARD takes k/n and nothing else", () => {
    assert.equal(parseShard(undefined), null);
    assert.deepEqual(parseShard("2/3"), { index: 2, count: 3 });
    for (const bad of ["0/3", "4/3", "3", "1/0", "a/b"]) assert.throws(() => parseShard(bad), /SA_TRIALS_SHARD/);
  });

  test("CI runs one job per shard, and each shard's recorded minutes fit its timeout", () => {
    const shardList = /shard: \[([\d, ]+)\]/.exec(ci)?.[1].split(",").map((s) => Number(s.trim()));
    const count = Number(/SA_TRIALS_SHARD: \$\{\{ matrix\.shard \}\}\/(\d+)/.exec(ci)?.[1]);
    assert.ok(shardList && count, "the trials job has a shard matrix and sets SA_TRIALS_SHARD");
    assert.deepEqual(shardList, Array.from({ length: count }, (_, i) => i + 1));
    const timeout = Number(/trials:[\s\S]*?timeout-minutes: (\d+)/.exec(ci)?.[1]);
    for (const s of shards(trials, count)) assert.ok(minutesOf(s) * 1.5 <= timeout, `a shard of ${minutesOf(s)} recorded minutes leaves too little room in ${timeout}`);
  });
});

describe("trials.json", () => {
  test("ids are unique, every trial has measured minutes, and the optional fields hold what the runner reads", () => {
    assert.equal(new Set(trials.map((t) => t.id)).size, trials.length);
    for (const t of trials) {
      assert.ok(typeof t.minutes === "number" && t.minutes > 0, `${t.id} has no minutes`);
      assert.ok(t.tier === undefined || t.tier === "read-only", `${t.id}: tier ${t.tier}`);
      assert.ok(t.budgetEdge === undefined || t.budgetEdge === true, `${t.id}: budgetEdge`);
      for (const v of t.alsoRun ?? []) assert.ok(v === "none" || v === "host", `${t.id}: alsoRun ${v}`);
      for (const k of Object.keys(t.recordedAlso ?? {})) assert.match(k, /^(none|host\/(host|disposable_vm|container|none))$/, `${t.id}: recordedAlso ${k}`);
    }
  });

  test("each tracking guard names a truth guard and why it misses", () => {
    for (const t of trials) {
      for (const [code, why] of Object.entries(t.tracking ?? {})) {
        assert.ok(TRUTH_CODES.includes(code), `${t.id}: ${code} isn't a truth guard`);
        assert.ok(why.trim().length >= 20, `${t.id} ${code}: say why it misses`);
      }
    }
  });

  test("a tracking guard isn't also a known failure", () => {
    const tracked = new Set(trials.flatMap((t) => Object.keys(t.tracking ?? {}).map((c) => `${t.id} truth ${c}`)));
    for (const k of knownFailures()) assert.ok(!tracked.has(k.test), `${k.test} is tracked; take it out of tests/known-failures.json`);
  });
});

describe("the trials' host lock", () => {
  const order = (log: string[]) => log.join(" ");

  test("one slot runs audits one at a time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-lock-"));
    const log: string[] = [];
    const run = async (name: string) => {
      const release = await acquireHost(dir, { slots: 1, exclusive: false, label: name, pollMs: 5 });
      log.push(`${name}+`);
      await new Promise((r) => setTimeout(r, 20));
      log.push(`${name}-`);
      release();
    };
    await Promise.all([run("a"), run("b")]);
    assert.match(order(log), /^(a\+ a- b\+ b-|b\+ b- a\+ a-)$/);
  });

  test("an exclusive audit waits for every slot, and no new audit starts while it waits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-lock-"));
    const log: string[] = [];
    const first = await acquireHost(dir, { slots: 2, exclusive: false, label: "a", pollMs: 5 });
    log.push("a+");
    const edge = acquireHost(dir, { slots: 2, exclusive: true, label: "edge", pollMs: 5 }).then((release) => {
      log.push("edge+");
      return release;
    });
    await new Promise((r) => setTimeout(r, 30));
    const later = acquireHost(dir, { slots: 2, exclusive: false, label: "b", pollMs: 5 }).then((release) => {
      log.push("b+");
      release();
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(log, ["a+"], "the exclusive audit waits for a, and b waits behind it");
    log.push("a-");
    first();
    const release = await edge;
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(log, ["a+", "a-", "edge+"]);
    release();
    await later;
    assert.deepEqual(log, ["a+", "a-", "edge+", "b+"]);
  });

  test("a slot left by a process that has gone is freed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-lock-"));
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
    mkdirSync(join(dir, "slot-0"));
    writeFileSync(join(dir, "slot-0", "pid"), gone);
    const release = await acquireHost(dir, { slots: 1, exclusive: false, label: "a", pollMs: 5 });
    release();
  });
});
