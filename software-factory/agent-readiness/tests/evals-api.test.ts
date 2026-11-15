import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ApiExhaustedError, CATALOG_ENV, Limiter, apiCall, apiRefusals, backoffMs, modelCatalog, retryAfterMs, retryable, useSdk, withRetry } from "../support/evals/lib/api.ts";
import type { Sdk } from "../support/evals/lib/api.ts";
import { judgeLabels } from "../support/evals/labels/check.ts";
import { LABELS, loadBase } from "../support/evals/labels/labels.ts";
import { availableModels, judge, judgePanel } from "../support/evals/lib/judge.ts";

// What the Mac labels run got back for 39 of 180 calls.
const LIMIT = "You have exceeded the rate limit of 30 requests per minute for the get_models endpoint";

class FakeRateLimit extends Error {
  status = 429;
  headers?: Record<string, string>;
  constructor(message = LIMIT, retryAfter?: string) {
    super(message);
    this.name = "RateLimitError";
    if (retryAfter !== undefined) this.headers = { "retry-after": retryAfter };
  }
}

interface FakeOptions {
  // How many Agent.create calls are refused before they succeed; Infinity refuses every one.
  refuseCreates?: number;
  reply?: string;
  // The SDK's own model check: each Agent.create lists the models unless the catalog is in the env.
  listOnCreate?: boolean;
}

function fakeSdk(o: FakeOptions = {}) {
  const stats = { creates: 0, refused: 0, lists: 0, active: 0, maxActive: 0 };
  const list = async () => {
    stats.lists++;
    return [{ id: "gpt-5.6-sol", displayName: "GPT" }, { id: "gemini-4-argon", displayName: "Gemini" }];
  };
  const sdk = {
    Cursor: { models: { list } },
    Agent: {
      create: async () => {
        stats.creates++;
        if (o.listOnCreate && !process.env[CATALOG_ENV]) await list();
        if (stats.refused < (o.refuseCreates ?? 0)) {
          stats.refused++;
          throw new FakeRateLimit();
        }
        stats.active++;
        stats.maxActive = Math.max(stats.maxActive, stats.active);
        return {
          send: async () => ({
            supports: () => false,
            stream: async function* () {
              await new Promise((r) => setTimeout(r, 2));
              yield { type: "assistant", message: { content: [{ type: "text", text: o.reply ?? '{"score": 0.8, "reasons": ["ok"]}' }] } };
            },
            wait: async () => ({ status: "finished" }),
          }),
          [Symbol.asyncDispose]: async () => {
            stats.active--;
          },
        };
      },
    },
  } as unknown as Sdk;
  return { sdk, stats };
}

const sleeps: number[] = [];
const instant = { sleep: async (ms: number) => void sleeps.push(ms), baseMs: 10, capMs: 1000, attempts: 6 };
const report = loadBase("healthy-node");
let restore: (() => void) | null = null;
let savedCatalog: string | undefined;

beforeEach(() => {
  savedCatalog = process.env[CATALOG_ENV];
  delete process.env[CATALOG_ENV];
  sleeps.length = 0;
});
afterEach(() => {
  restore?.();
  restore = null;
  if (savedCatalog === undefined) delete process.env[CATALOG_ENV];
  else process.env[CATALOG_ENV] = savedCatalog;
});

describe("retries on the API's refusals", () => {
  test("rate limits and transient failures are retried; anything else isn't", () => {
    assert.ok(retryable(new FakeRateLimit()));
    assert.ok(retryable(Object.assign(new Error("x"), { status: 503 })));
    assert.ok(retryable(new Error("[resource_exhausted] Too Many Requests")));
    assert.ok(!retryable(new Error("Cannot use this model: x")));
    assert.ok(!retryable(Object.assign(new Error("bad key"), { status: 401 })));
  });

  test("Retry-After is read from headers, Headers objects, the cause or the message, in seconds or as a date", () => {
    const now = Date.parse("2026-11-15T12:00:00Z");
    assert.equal(retryAfterMs(new FakeRateLimit(LIMIT, "7")), 7000);
    assert.equal(retryAfterMs(Object.assign(new Error("x"), { cause: { metadata: new Headers({ "Retry-After": "3" }) } })), 3000);
    assert.equal(retryAfterMs(new FakeRateLimit(LIMIT, "Sun, 15 Nov 2026 12:00:20 GMT"), now), 20000);
    assert.equal(retryAfterMs(new Error("slow down, retry after 12s")), 12000);
    assert.equal(retryAfterMs(new FakeRateLimit()), null);
  });

  test("waits are full jitter on a capped exponential step, or Retry-After plus under a second", () => {
    const o = { baseMs: 1000, capMs: 8000 };
    assert.equal(backoffMs(1, new FakeRateLimit(), { ...o, random: () => 0.999 }), 999);
    assert.equal(backoffMs(3, new FakeRateLimit(), { ...o, random: () => 0.5 }), 2000);
    assert.equal(backoffMs(9, new FakeRateLimit(), { ...o, random: () => 0.999 }), 7992, "capped");
    assert.equal(backoffMs(1, new FakeRateLimit(LIMIT, "7"), { ...o, random: () => 0.5 }), 7500);
  });

  test("a refused call is retried until it succeeds; one refused every time throws, never returns nothing", async () => {
    let calls = 0;
    const flaky = () => (++calls < 3 ? Promise.reject(new FakeRateLimit()) : Promise.resolve("ok"));
    assert.equal(await withRetry("x", flaky, { ...instant, log: () => {} }), "ok");
    assert.equal(calls, 3);
    assert.equal(sleeps.length, 2);
    await assert.rejects(withRetry("listing", () => Promise.reject(new FakeRateLimit()), { ...instant, log: () => {} }), (e: Error) => e instanceof ApiExhaustedError && /listing was still rate-limited or unavailable after 6 attempts: You have exceeded the rate limit/.test(e.message));
    await assert.rejects(withRetry("x", () => Promise.reject(new Error("Cannot use this model")), instant), /Cannot use this model/);
  });

  test("the limiter caps calls in flight and spaces their starts", async () => {
    const waits: number[] = [];
    const lim = new Limiter(2, 100, async (ms) => void waits.push(ms));
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => lim.run(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    })));
    assert.equal(peak, 2);
    assert.ok(waits.length >= 4 && waits.every((w) => w > 0 && w <= 500), JSON.stringify(waits));
  });
});

describe("the model catalog is fetched once per process", () => {
  test("concurrent callers share one fetch, which is published for the SDK and child processes", async () => {
    const f = fakeSdk();
    restore = useSdk(f.sdk, { retry: instant });
    const lists = await Promise.all(Array.from({ length: 12 }, () => modelCatalog("key")));
    assert.equal(f.stats.lists, 1);
    assert.ok(lists.every((l) => l.length === 2));
    assert.deepEqual(JSON.parse(process.env[CATALOG_ENV]!).map((m: { id: string }) => m.id), ["gpt-5.6-sol", "gemini-4-argon"]);
    assert.deepEqual(await availableModels("key"), ["gpt-5.6-sol", "gemini-4-argon"]);
    assert.equal(f.stats.lists, 1);
  });

  test("a catalog inherited from the parent process means no fetch at all", async () => {
    process.env[CATALOG_ENV] = JSON.stringify([{ id: "gpt-5.6-sol", displayName: "GPT" }]);
    const f = fakeSdk();
    restore = useSdk(f.sdk, { retry: instant });
    assert.deepEqual((await modelCatalog("key")).map((m) => m.id), ["gpt-5.6-sol"]);
    assert.equal(f.stats.lists, 0);
  });

  test("a rate-limited catalog fetch is retried, then fails loudly", async () => {
    let n = 0;
    const f = fakeSdk();
    const sdk = { ...f.sdk, Cursor: { models: { list: async () => (++n < 3 ? Promise.reject(new FakeRateLimit()) : [{ id: "m", displayName: "m" }]) } } } as unknown as Sdk;
    restore = useSdk(sdk, { retry: { ...instant, log: () => {} } });
    assert.equal((await modelCatalog("key"))[0].id, "m");
    restore();
    delete process.env[CATALOG_ENV];
    restore = useSdk({ ...f.sdk, Cursor: { models: { list: () => Promise.reject(new FakeRateLimit()) } } } as unknown as Sdk, { retry: { ...instant, log: () => {} } });
    await assert.rejects(availableModels("key"), ApiExhaustedError);
  });
});

describe("judge calls under the rate limit", () => {
  test("the labels run's burst: 12 calls at once make one catalog fetch, stay under the limiter, and every one scores", async () => {
    const f = fakeSdk({ listOnCreate: true, refuseCreates: 5 });
    restore = useSdk(f.sdk, { retry: { ...instant, log: () => {} }, max: 3, gapMs: 0 });
    const results = await Promise.all(Array.from({ length: 12 }, () => judge("headline", report, "gpt-5.6-sol", "key")));
    assert.deepEqual(results.map((r) => r.score), Array(12).fill(0.8));
    assert.equal(f.stats.lists, 1, "the SDK's model check reads the published catalog instead of fetching it");
    assert.ok(f.stats.maxActive <= 3, `at most 3 judge agents at once, saw ${f.stats.maxActive}`);
    assert.equal(f.stats.creates, 12 + 5);
  });

  test("a judge call still refused after every retry throws instead of scoring null", async () => {
    const f = fakeSdk({ refuseCreates: Infinity });
    restore = useSdk(f.sdk, { retry: { ...instant, log: () => {} } });
    await assert.rejects(judge("headline", report, "gpt-5.6-sol", "key"), ApiExhaustedError);
    await assert.rejects(judgePanel("headline", report, ["gpt-5.6-sol", "gemini-4-argon"], "key", 3), ApiExhaustedError);
  });

  test("the label check rejects when the API keeps refusing, and lists any call that gave no score", async () => {
    restore = useSdk(fakeSdk({ refuseCreates: Infinity }).sdk, { retry: { ...instant, log: () => {} } });
    await assert.rejects(judgeLabels(LABELS.slice(0, 2), ["gpt-5.6-sol"], 1, "key"), ApiExhaustedError);
    restore();
    restore = useSdk(fakeSdk({ reply: "no json here" }).sdk, { retry: instant });
    const r = await judgeLabels(LABELS.slice(0, 2), ["gpt-5.6-sol", "gemini-4-argon"], 1, "key");
    assert.equal(r.calls, 8);
    assert.equal(r.missing.length, 8);
    assert.match(r.missing[0], /judge reply wasn't JSON/);
    restore();
    restore = useSdk(fakeSdk({ refuseCreates: 7 }).sdk, { retry: { ...instant, log: () => {} } });
    const ok = await judgeLabels(LABELS.slice(0, 2), ["gpt-5.6-sol", "gemini-4-argon"], 1, "key");
    assert.deepEqual(ok.missing, []);
    assert.ok(ok.scored.every((s) => Object.values(s.calls).every((c) => c.length === 2)));
  });

  test("an eval run with a refused judge call or a run lost to the rate limit is named, so it fails", () => {
    const run = (extra: object) => ({ id: "fixtures/healthy-node", repeat: 2, arm: "agent", error: null, grade: { soft: {} }, ...extra });
    assert.deepEqual(apiRefusals([run({})]), []);
    assert.match(apiRefusals([run({ grade: { soft: { judgeError: "judging with gpt-5.6-sol was still rate-limited" } } })])[0], /^fixtures\/healthy-node #2: a judge call was refused/);
    assert.match(apiRefusals([run({ arm: "scripted", error: LIMIT, infra: { lost: true, errors: [LIMIT] } })])[0], /#2 \[scripted\]: every attempt was refused/);
    assert.deepEqual(apiRefusals([run({ error: "ECONNRESET", infra: { lost: true, errors: ["ECONNRESET"] } })]), [], "other infrastructure losses keep their existing handling");
  });

  test("apiCall goes through the shared limiter", async () => {
    restore = useSdk(fakeSdk().sdk, { max: 1, gapMs: 0, retry: instant });
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 4 }, () => apiCall("x", async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 3));
      active--;
    })));
    assert.equal(peak, 1);
  });
});
