import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// How many audits run at once on one machine, across every shard process that shares the lock
// folder. Each audit holds one slot; an exclusive audit, one whose result a time budget decides,
// waits for every slot so nothing else runs beside it, and while it waits no new audit starts.
// A slot is a folder, so taking one is atomic, and it names its process, so a slot left by a killed
// run is freed.

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function owner(dir: string): number | null {
  try {
    return Number(readFileSync(join(dir, "pid"), "utf8")) || null;
  } catch {
    return null;
  }
}

// Removes a slot or waiting mark whose process has gone. A folder with no pid yet is being made.
function freeIfStale(dir: string): void {
  const pid = owner(dir);
  if (pid !== null && !alive(pid)) rmSync(dir, { recursive: true, force: true });
}

function take(dir: string, label: string): boolean {
  try {
    mkdirSync(dir);
  } catch {
    freeIfStale(dir);
    return false;
  }
  writeFileSync(join(dir, "pid"), String(process.pid));
  writeFileSync(join(dir, "label"), label);
  return true;
}

// Whether an exclusive audit is waiting. A mark still being made counts, so nothing slips in.
function waiting(lockDir: string): boolean {
  return readdirSync(lockDir)
    .filter((n) => n.startsWith("waiting-"))
    .some((n) => {
      freeIfStale(join(lockDir, n));
      const pid = owner(join(lockDir, n));
      return pid === null ? true : alive(pid);
    });
}

export interface HostLockOptions {
  slots: number;
  exclusive: boolean;
  label: string;
  pollMs?: number;
}

// Resolves with a release function once the audit may start.
export async function acquireHost(lockDir: string, opts: HostLockOptions): Promise<() => void> {
  const slots = Math.max(1, Math.floor(opts.slots));
  const poll = opts.pollMs ?? 2000;
  mkdirSync(lockDir, { recursive: true });
  const slot = (i: number) => join(lockDir, `slot-${i}`);
  if (!opts.exclusive) {
    for (;;) {
      if (!waiting(lockDir)) for (let i = 0; i < slots; i++) if (take(slot(i), opts.label)) return () => rmSync(slot(i), { recursive: true, force: true });
      await sleep(poll);
    }
  }
  const mark = `waiting-${process.pid}-${Date.now()}`;
  while (!take(join(lockDir, mark), opts.label)) await sleep(poll);
  const held: number[] = [];
  try {
    for (let i = 0; i < slots; i++) {
      while (!take(slot(i), opts.label)) await sleep(poll);
      held.push(i);
    }
  } finally {
    rmSync(join(lockDir, mark), { recursive: true, force: true });
  }
  return () => {
    for (const i of held) rmSync(slot(i), { recursive: true, force: true });
  };
}
