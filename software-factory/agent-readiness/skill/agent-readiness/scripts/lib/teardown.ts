import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { constants, hostname, tmpdir } from "node:os";
import { join } from "node:path";

// What a run must undo when it stops early: its containers, its process groups and its temp folders.
// Each is undone on SIGINT, SIGTERM or SIGHUP and when the process exits, crash or not, so pressing
// Stop, a shell timeout or a cancelled CI job leaves nothing running and no copy of the repo behind.

const tasks = new Map<number, () => void>();
let next = 0;
let installed = false;

export const TEARDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function install(): void {
  if (installed) return;
  installed = true;
  process.on("exit", runTeardown);
  for (const sig of TEARDOWN_SIGNALS) {
    process.on(sig, () => {
      runTeardown();
      process.exit(128 + constants.signals[sig]);
    });
  }
}

// Registers an undo step; the returned function drops it once the thing is gone the normal way.
export function onTeardown(fn: () => void): () => void {
  install();
  const id = next++;
  tasks.set(id, fn);
  return () => {
    tasks.delete(id);
  };
}

// Newest first, as the container that mounts a folder has to go before the folder.
export function runTeardown(): void {
  for (const [id, fn] of [...tasks.entries()].reverse()) {
    tasks.delete(id);
    try {
      fn();
    } catch {
      // Undo what else can be undone.
    }
  }
}

export function pendingTeardown(): number {
  return tasks.size;
}

// The file in each of a run's temp folders that names the process that made it.
export const OWNER_FILE = ".readiness-owner.json";

interface Owner {
  pid: number;
  host: string;
}

export interface TempDir {
  path: string;
  dispose(): void;
  // Keeps the folder past this process, as a draft's tree is kept between commands.
  keep(): void;
}

// A temp folder that is removed when it is disposed of or when the process stops, whichever comes first.
export function tempDir(prefix: string): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  const owner: Owner = { pid: process.pid, host: hostname() };
  writeFileSync(join(path, OWNER_FILE), JSON.stringify(owner) + "\n");
  const drop = onTeardown(() => rmSync(path, { recursive: true, force: true }));
  return {
    path,
    dispose: () => {
      drop();
      rmSync(path, { recursive: true, force: true });
    },
    keep: () => {
      drop();
      rmSync(join(path, OWNER_FILE), { force: true });
    },
  };
}

// Whether the process that made something is gone: on this machine, with no process at that id.
// A process of another user still counts as running.
export function ownerGone(pid: number, host: string): boolean {
  if (host !== hostname() || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

// Temp folders a run made and never removed because it was killed before it could: their owner is
// gone, whatever their age. A folder without an owner file is left to `readiness cleanup`.
export function orphanedTempDirs(dir: string = tmpdir()): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.filter((n) => n.startsWith("readiness-"))) {
    const full = join(dir, name);
    try {
      const o = JSON.parse(readFileSync(join(full, OWNER_FILE), "utf8")) as Owner;
      if (ownerGone(o.pid, o.host)) out.push(full);
    } catch {
      continue;
    }
  }
  return out;
}

export function removeOrphanedTempDirs(dir: string = tmpdir()): string[] {
  return orphanedTempDirs(dir).map((full) => {
    rmSync(full, { recursive: true, force: true });
    return `temp folder ${full}`;
  });
}
