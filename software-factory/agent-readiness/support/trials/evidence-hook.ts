import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { HOOK_CALLS_ENV, HOOK_MISS_ENV, HOOK_MODE_ENV, HOOK_SCRIPTS_ENV, MISS_EXIT, sha256 } from "./evidence.ts";
import type { RecordedCall } from "./evidence.ts";

// Loaded with --import by the trial runner, never by the shipped CLI. Records, or answers from a
// recording, every call the audit makes to its container runtime: the ContainerSession methods and
// the runtime commands the audit runs outside a session. Everything else (scan, git, scoring,
// levels, the seal and the report) runs as it is.
//
// A replayed call matches only when the command, its working folder, its options, the image and
// the files the audit has changed in its copy of the repo (a planted fault) are all the same, and
// only as many times as it was recorded. Anything else writes the miss and ends the audit at once.

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
const cp = require("node:child_process") as typeof import("node:child_process");

const mode = process.env[HOOK_MODE_ENV];
const callsFile = process.env[HOOK_CALLS_ENV] ?? "";
const missFile = process.env[HOOK_MISS_ENV] ?? "";
const scripts = process.env[HOOK_SCRIPTS_ENV] ?? "";
if (mode !== "record" && mode !== "replay") throw new Error(`${HOOK_MODE_ENV} takes record or replay; got ${mode}`);
if (!callsFile || !scripts || (mode === "replay" && !missFile)) throw new Error(`the evidence hook needs ${HOOK_CALLS_ENV}, ${HOOK_SCRIPTS_ENV} and, to replay, ${HOOK_MISS_ENV}`);

const realNow = Date.now.bind(Date);
const realWrite = fs.writeFileSync;
const realRead = fs.readFileSync;
const realExists = fs.existsSync;
const realSpawnSync = cp.spawnSync;
const t0 = realNow();
let offset = 0;

const SESSION_METHODS = ["start", "pullImage", "exec", "asImageUser", "copyFromImage", "reclaimHome", "enableCorepack", "disconnectNetwork", "reconnectNetwork", "readOomKills", "stop", "remove"] as const;
const STATE_FIELDS = ["user", "userEntry", "offline", "cutFrom", "oomKills"] as const;
const RUNTIMES = new Set(["docker", "podman"]);

// The audit's copies of the repo, where a write by the audit itself (a planted fault or type error)
// changes what the next command sees. Each file's content before the audit first wrote it.
const roots = new Set<string>();
const original = new Map<string, string>();
const current = new Map<string, string>();

function digestOf(data: unknown): string {
  return typeof data === "string" || Buffer.isBuffer(data) ? sha256(data) : sha256(String(data));
}

fs.writeFileSync = function (file: unknown, data: unknown, ...rest: unknown[]) {
  if (typeof file === "string") {
    for (const root of roots) {
      if (!file.startsWith(root + sep)) continue;
      const rel = relative(root, file);
      if (!original.has(rel)) original.set(rel, realExists(file) ? sha256(realRead(file)) : "absent");
      current.set(rel, digestOf(data));
    }
  }
  return (realWrite as (...a: unknown[]) => void)(file, data, ...rest);
} as typeof fs.writeFileSync;

function changedFiles(): [string, string][] {
  return [...current].filter(([rel, d]) => original.get(rel) !== d).sort(([a], [b]) => a.localeCompare(b));
}

const TEMP_NAMES = /readiness-(replay|home|copy|env)-[A-Za-z0-9]+/g;

function normalize(value: unknown): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const root of roots) s = s.split(root).join("<copy>");
    return s.split(tmpdir()).join("<tmp>").replace(TEMP_NAMES, "readiness-$1-*");
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v !== "function").map(([k, v]) => [k, normalize(v)]));
  return value;
}

// exec's timeout is left out of its key: it comes from the time left in the budget. The replay checks
// instead that the recorded result stands under the new limit.
function keyOf(kind: string, image: string | null, args: unknown[]): string {
  const plain = args.filter((a) => typeof a !== "function");
  const shown = kind === "exec" ? [plain[0], plain[1], plain[3] ?? null] : plain;
  return JSON.stringify({ kind, image, args: normalize(shown), changed: changedFiles() });
}

const recorded: RecordedCall[] = [];
const queues = new Map<string, RecordedCall[]>();
const made: string[] = [];
if (mode === "replay") {
  const raw = realRead(callsFile);
  const calls = JSON.parse((callsFile.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8")) as RecordedCall[];
  for (const c of calls) queues.set(c.key, [...(queues.get(c.key) ?? []), c]);
  Date.now = () => realNow() + offset;
}

let missed = false;
function miss(why: string): never {
  missed = true;
  realWrite(missFile, why.slice(0, 4000) + "\n");
  process.exit(MISS_EXIT);
}

function take(key: string, timeoutSec?: number): RecordedCall {
  const q = queues.get(key);
  const call = q?.shift();
  if (!call) miss(`not in the evidence store${q ? " (made more often than recorded)" : ""}: ${key}; the call before it: ${made[made.length - 1] ?? "none"}`);
  if (timeoutSec !== undefined) {
    const r = call.result as { timedOut?: boolean; durationMs?: number };
    // A recorded timeout stands only under the same limit; a recorded finish, under any limit it fits.
    const recordedLimit = call.timeoutSec;
    if (r.timedOut ? recordedLimit === undefined || Math.abs(recordedLimit - timeoutSec) > 1 : (r.durationMs ?? 0) > timeoutSec * 1000) miss(`recorded under another time limit (${recordedLimit ?? "?"} s, now ${timeoutSec} s): ${key}`);
  }
  made.push(key);
  // The clock goes on from where the recording's did when this call ended, so a budget reads the same.
  offset = Math.max(offset, t0 + call.end - realNow());
  return call;
}

function snapshot(self: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(STATE_FIELDS.map((f) => [f, self[f]]));
}

let depth = 0;

async function loadSession(): Promise<{ prototype: Record<string, unknown> }> {
  const mod = (await import(pathToFileURL(join(scripts, "lib", "container.ts")).href)) as { ContainerSession: { prototype: Record<string, unknown> } };
  return mod.ContainerSession;
}

const Session = await loadSession();
for (const name of SESSION_METHODS) {
  const realMethod = Session.prototype[name] as (...a: unknown[]) => unknown;
  Session.prototype[name] = function (this: Record<string, unknown>, ...args: unknown[]) {
    if (name === "start" && typeof this.hostDir === "string") roots.add(this.hostDir);
    // A call made inside another session call is part of that one's recorded result.
    if (depth > 0) return realMethod.apply(this, args);
    const key = keyOf(name, (this.image as string) ?? null, args);
    const timeoutSec = name === "exec" ? (args[2] as number) : undefined;
    if (mode === "replay") {
      const call = take(key, timeoutSec);
      Object.assign(this, call.state ?? {});
      return name === "exec" ? Promise.resolve(call.result) : call.result;
    }
    const start = realNow() - t0;
    const done = (result: unknown) => {
      recorded.push({ key, result: result ?? null, state: snapshot(this), start, end: realNow() - t0, ...(timeoutSec !== undefined ? { timeoutSec } : {}) });
      return result;
    };
    depth++;
    let out: unknown;
    try {
      out = realMethod.apply(this, args);
    } catch (e) {
      depth--;
      throw e;
    }
    if (out instanceof Promise) {
      return out.then(
        (r) => {
          depth--;
          return done(r);
        },
        (e) => {
          depth--;
          throw e;
        },
      );
    }
    depth--;
    return done(out);
  };
}

// Runtime commands outside a session: whether a runtime answers, its limits, a declared image's
// build, and the leftovers of earlier audits.
cp.spawnSync = function (command: string, args?: readonly string[] | object, options?: object) {
  const argv = Array.isArray(args) ? args : [];
  if (depth > 0 || !RUNTIMES.has(command)) return (realSpawnSync as (...a: unknown[]) => unknown)(command, args, options);
  const key = keyOf("spawnSync", command, [argv]);
  if (mode === "replay") {
    const r = take(key).result as { status: number | null; signal: string | null; stdout: string; stderr: string };
    return { pid: 0, output: [null, r.stdout, r.stderr], stdout: r.stdout, stderr: r.stderr, status: r.status, signal: r.signal };
  }
  const start = realNow() - t0;
  const r = (realSpawnSync as (...a: unknown[]) => { status: number | null; signal: string | null; stdout: unknown; stderr: unknown })(command, args, options);
  recorded.push({ key, result: { status: r.status, signal: r.signal, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") }, start, end: realNow() - t0 });
  return r;
} as typeof cp.spawnSync;

// The audit's own reads of its copy once a container has run there: what an install put in place
// (node_modules/.bin/tsc), a lockfile it rewrote, the file a fault is planted in. Recorded as calls,
// since the replay's copy is the bare checkout.
type Reader = (...a: unknown[]) => unknown;
const READERS = ["existsSync", "readFileSync", "readdirSync", "statSync", "lstatSync"] as const;

function underRoot(p: unknown): boolean {
  return typeof p === "string" && [...roots].some((r) => p === r || p.startsWith(r + sep));
}

interface FsResult {
  error?: string;
  value?: unknown;
  buffer?: string;
  stat?: { file: boolean; dir: boolean; link: boolean; size: number };
  entries?: { name: string; file: boolean; dir: boolean; link: boolean }[];
}

function freeze(name: string, args: unknown[], out: unknown): FsResult {
  if (name === "readFileSync") return Buffer.isBuffer(out) ? { buffer: out.toString("base64") } : { value: out };
  if (name === "statSync" || name === "lstatSync") {
    const s = out as import("node:fs").Stats | undefined;
    return s ? { stat: { file: s.isFile(), dir: s.isDirectory(), link: s.isSymbolicLink(), size: s.size } } : { value: null };
  }
  const opts = args[1] as { withFileTypes?: boolean } | undefined;
  if (name === "readdirSync" && opts?.withFileTypes) return { entries: (out as import("node:fs").Dirent[]).map((d) => ({ name: String(d.name), file: d.isFile(), dir: d.isDirectory(), link: d.isSymbolicLink() })) };
  return { value: out };
}

function thaw(r: FsResult, args: unknown[]): unknown {
  if (r.error) throw Object.assign(new Error(`${r.error}: replayed from the trial's evidence`), { code: r.error });
  if (r.buffer !== undefined) return Buffer.from(r.buffer, "base64");
  const kind = (k: { file: boolean; dir: boolean; link: boolean }) => ({ isFile: () => k.file, isDirectory: () => k.dir, isSymbolicLink: () => k.link });
  if (r.stat) return { ...kind(r.stat), size: r.stat.size };
  if (r.entries) return r.entries.map((e) => ({ name: e.name, parentPath: args[0], path: args[0], ...kind(e) }));
  return r.value;
}

for (const name of READERS) {
  const realFn = fs[name] as unknown as Reader;
  (fs as unknown as Record<string, Reader>)[name] = function (...args: unknown[]) {
    if (depth > 0 || !underRoot(args[0])) return realFn(...args);
    const key = keyOf(`fs.${name}`, null, [args[0], ...args.slice(1).filter((a) => typeof a !== "object" || a === null), ...args.slice(1).filter((a) => a && typeof a === "object").map((a) => Object.fromEntries(Object.entries(a as object).sort()))]);
    if (mode === "replay") return thaw(take(key).result as FsResult, args);
    const start = realNow() - t0;
    let result: FsResult;
    let out: unknown;
    try {
      out = realFn(...args);
      result = freeze(name, args, out);
    } catch (e) {
      result = { error: (e as NodeJS.ErrnoException).code ?? "EIO" };
      recorded.push({ key, result, start, end: realNow() - t0 });
      throw e;
    }
    recorded.push({ key, result, start, end: realNow() - t0 });
    return out;
  };
}

syncBuiltinESMExports();

process.on("exit", () => {
  if (mode === "record") {
    realWrite(callsFile, JSON.stringify(recorded));
    return;
  }
  if (missed) return;
  const left = [...queues.values()].flat();
  if (left.length) realWrite(missFile, `recorded but never made (${left.length}), first: ${left[0].key}`.slice(0, 4000) + "\n");
  realWrite(callsFile + ".made", JSON.stringify(made));
});
