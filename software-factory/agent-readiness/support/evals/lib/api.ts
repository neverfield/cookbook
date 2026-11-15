import * as cursorSdk from "@cursor/sdk";
import type { ModelListItem } from "@cursor/sdk";

// Every call the evals make to the Cursor API goes through here: one model catalog per process, a
// limiter shared by every call in the process, and retries with jittered backoff when the API says
// to slow down. A call still refused after the last retry throws ApiExhaustedError; callers let it
// end the run rather than record a missing score.

// The SDK checks each Agent.create's model against this catalog instead of fetching it (the
// get_models endpoint, limited to 30 calls a minute per key). Child processes inherit it, so an
// eval run's workers make no catalog calls of their own.
export const CATALOG_ENV = "CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON";

export type Sdk = Pick<typeof cursorSdk, "Agent" | "Cursor">;
let current: Sdk = cursorSdk;

export function sdk(): Sdk {
  return current;
}

export interface ApiSettings {
  retry: RetryOptions;
  max: number;
  gapMs: number;
}

// Tests swap in a fake SDK, and may shorten the waits; returns a function that puts everything back.
export function useSdk(fake: Sdk, settings: Partial<ApiSettings> = {}): () => void {
  const prev = { sdk: current, retry: defaults, max: limiter.max, gapMs: limiter.gapMs };
  current = fake;
  defaults = { ...defaults, ...settings.retry };
  limiter = new Limiter(settings.max ?? limiter.max, settings.gapMs ?? limiter.gapMs, settings.retry?.sleep);
  catalog = null;
  return () => {
    current = prev.sdk;
    defaults = prev.retry;
    limiter = new Limiter(prev.max, prev.gapMs);
    catalog = null;
  };
}

export class ApiExhaustedError extends Error {
  constructor(what: string, attempts: number, last: unknown) {
    super(`${what} was still rate-limited or unavailable after ${attempts} attempts: ${(last as Error)?.message ?? String(last)}`);
    this.name = "ApiExhaustedError";
  }
}

// A refusal the API wants retried later: a rate limit, or a transient server or network failure.
export function retryable(e: unknown): boolean {
  if (e instanceof ApiExhaustedError) return false;
  const err = e as { name?: string; status?: number; code?: string; isRetryable?: boolean; message?: string };
  if (err?.name === "RateLimitError" || err?.status === 429 || err?.code === "resource_exhausted") return true;
  if (err?.status !== undefined && [502, 503, 504].includes(err.status)) return true;
  if (err?.name === "NetworkError") return true;
  return /rate limit|too many requests|\b429\b|resource.?exhausted|\b50[234]\b|ECONNRESET|ETIMEDOUT|socket hang up/i.test(err?.message ?? String(e));
}

// Seconds or an HTTP date, from a Retry-After header on the error, its cause, or its message.
export function retryAfterMs(e: unknown, now = Date.now()): number | null {
  const parse = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v * 1000);
    if (typeof v !== "string" || !v.trim()) return null;
    const s = Number(v.trim());
    if (Number.isFinite(s)) return Math.max(0, s * 1000);
    const at = Date.parse(v);
    return Number.isNaN(at) ? null : Math.max(0, at - now);
  };
  const header = (h: unknown): unknown => {
    if (!h) return undefined;
    if (typeof (h as Headers).get === "function") return (h as Headers).get("retry-after");
    const rec = h as Record<string, unknown>;
    return rec["retry-after"] ?? rec["Retry-After"];
  };
  const err = e as { retryAfter?: unknown; headers?: unknown; metadata?: unknown; cause?: { headers?: unknown; metadata?: unknown; retryAfter?: unknown }; message?: string };
  for (const v of [err?.retryAfter, header(err?.headers), header(err?.metadata), err?.cause?.retryAfter, header(err?.cause?.headers), header(err?.cause?.metadata)]) {
    const ms = parse(v);
    if (ms !== null) return ms;
  }
  const m = (err?.message ?? "").match(/retry[- ]after:?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?)?/i);
  if (m) return Number(m[1]) * (/^m/i.test(m[2] ?? "") ? 1 : 1000);
  return null;
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  capMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (line: string) => void;
}

const env = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const RETRY_DEFAULTS = { attempts: env("SA_READINESS_API_ATTEMPTS", 8), baseMs: 2000, capMs: 90_000 };
let defaults: RetryOptions = {};
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Full jitter: a wait drawn from 0 to the capped exponential step, or Retry-After plus up to a
// second when the API gives one.
export function backoffMs(attempt: number, e: unknown, o: Required<Pick<RetryOptions, "baseMs" | "capMs" | "random">>): number {
  const after = retryAfterMs(e);
  if (after !== null) return Math.min(o.capMs * 2, after) + Math.floor(o.random() * 1000);
  return Math.floor(o.random() * Math.min(o.capMs, o.baseMs * 2 ** (attempt - 1)));
}

export async function withRetry<T>(what: string, fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const attempts = o.attempts ?? RETRY_DEFAULTS.attempts;
  const opts = { baseMs: o.baseMs ?? RETRY_DEFAULTS.baseMs, capMs: o.capMs ?? RETRY_DEFAULTS.capMs, random: o.random ?? Math.random };
  const sleep = o.sleep ?? realSleep;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!retryable(e)) throw e;
      last = e;
      if (attempt === attempts) break;
      const wait = backoffMs(attempt, e, opts);
      (o.log ?? ((l: string) => process.stderr.write(`${l}\n`)))(`${what}: ${(e as Error).message ?? e}; retry ${attempt} of ${attempts - 1} in ${(wait / 1000).toFixed(1)} s`);
      await sleep(wait);
    }
  }
  throw new ApiExhaustedError(what, attempts, last);
}

// At most `max` calls at once in this process, and starts at least `gapMs` apart.
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  private nextStart = 0;
  readonly max: number;
  readonly gapMs: number;
  private sleep: (ms: number) => Promise<void>;
  constructor(max: number, gapMs: number, sleep: (ms: number) => Promise<void> = realSleep) {
    this.max = max;
    this.gapMs = gapMs;
    this.sleep = sleep;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      const now = Date.now();
      const start = Math.max(now, this.nextStart);
      this.nextStart = start + this.gapMs;
      if (start > now) await this.sleep(start - now);
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

let limiter = new Limiter(env("SA_READINESS_API_CONCURRENCY", 4), env("SA_READINESS_API_GAP_MS", 250));
let catalog: Promise<ModelListItem[]> | null = null;

export function sharedLimiter(): Limiter {
  return limiter;
}

// One call through the shared limiter, retried while the API refuses it. Each attempt waits for a
// slot again, so a backoff never holds one.
export function apiCall<T>(what: string, fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  return withRetry(what, () => limiter.run(fn), { ...defaults, ...o });
}

function catalogFromEnv(): ModelListItem[] | null {
  const raw = process.env[CATALOG_ENV];
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as ModelListItem[] | { items?: ModelListItem[] };
    const items = Array.isArray(v) ? v : v.items;
    return Array.isArray(items) ? items : null;
  } catch {
    return null;
  }
}

// The key's model catalog, fetched at most once per process (or inherited from the parent) and
// published to CATALOG_ENV for the SDK and for child processes.
export function modelCatalog(apiKey: string, o: RetryOptions = {}): Promise<ModelListItem[]> {
  const inherited = catalogFromEnv();
  if (inherited) return Promise.resolve(inherited);
  catalog ??= apiCall("listing the models", () => sdk().Cursor.models.list({ apiKey }), o).then((items) => {
    process.env[CATALOG_ENV] = JSON.stringify(items);
    return items;
  });
  catalog.catch(() => {
    catalog = null;
  });
  return catalog;
}

interface RunLike {
  id: string;
  repeat: number;
  arm?: string;
  error: string | null;
  grade: { soft: { judgeError?: string } };
  infra?: { lost: boolean; errors: string[] } | null;
}

const REFUSED = /rate.?limit|too many requests|\b429\b|resource.?exhausted|still rate-limited or unavailable/i;

// Runs that lost a call to the API's refusals: a judge call refused after every retry, or an agent
// run whose every attempt the API refused. Either leaves a draw out, so the eval run must fail.
export function apiRefusals(runs: RunLike[]): string[] {
  const out: string[] = [];
  for (const r of runs) {
    const name = `${r.id} #${r.repeat}${r.arm && r.arm !== "agent" ? ` [${r.arm}]` : ""}`;
    if (r.grade.soft.judgeError) out.push(`${name}: a judge call was refused after every retry: ${r.grade.soft.judgeError}`);
    else if (r.infra?.lost && [r.error ?? "", ...r.infra.errors].some((e) => REFUSED.test(e))) out.push(`${name}: every attempt was refused by the API: ${r.error ?? r.infra.errors.at(-1)}`);
  }
  return out;
}
