import { fmtDuration } from "./format.ts";
import type { Budget, Executor } from "./replay.ts";

// A long replay is never silent: while a command runs, a line at least every interval says which
// one and for how long; each command's duration is kept; and at the end the reader learns where the
// time budget went and which flag gives the largest consumer more.

export const PROGRESS_SEC_ENV = "SA_READINESS_PROGRESS_SEC";
const DEFAULT_SEC = 30;

export interface CommandTime {
  command: string;
  cwd: string;
  ms: number;
}

export function progressIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const sec = Number(env[PROGRESS_SEC_ENV]);
  return Number.isFinite(sec) && sec > 0 ? Math.min(sec, DEFAULT_SEC) * 1000 : DEFAULT_SEC * 1000;
}

export class Progress {
  readonly times: CommandTime[] = [];
  private readonly log: (s: string) => void;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly watched = new WeakSet<Executor>();

  constructor(log: (s: string) => void, intervalMs = progressIntervalMs(), now: () => number = Date.now) {
    this.log = log;
    this.intervalMs = intervalMs;
    this.now = now;
  }

  // Wraps the executor's exec (and execFresh) in place, so every caller's commands are watched.
  watch(ex: Executor): void {
    if (this.watched.has(ex) || ex.unavailable) return;
    this.watched.add(ex);
    ex.exec = this.timed(ex.exec.bind(ex));
    if (ex.execFresh) ex.execFresh = this.timed(ex.execFresh.bind(ex));
  }

  private timed(exec: Executor["exec"]): Executor["exec"] {
    return async (command, cwd, timeoutSec, opts) => {
      const start = this.now();
      const where = cwd && cwd !== "." ? ` in ${cwd}` : "";
      const timer = setInterval(() => this.log(`  … still running \`${oneLine(command)}\`${where}: ${fmtDuration(this.now() - start)} so far`), this.intervalMs);
      try {
        return await exec(command, cwd, timeoutSec, opts);
      } finally {
        clearInterval(timer);
        const ms = this.now() - start;
        this.times.push({ command, cwd, ms });
        if (ms >= this.intervalMs) this.log(`  … \`${oneLine(command)}\`${where} took ${fmtDuration(ms)}`);
      }
    };
  }
}

function oneLine(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

// Where the replay's time went, by component, and the flag that gives the largest consumer more.
// Empty when nothing was charged.
export function budgetSummary(b: Budget, componentMinutes: number, cut: { components: string[]; total: boolean }): string[] {
  const used = [...b.used.entries()].filter(([, ms]) => ms > 0).sort((x, y) => y[1] - x[1]);
  if (!used.length) return [];
  const name = (id: string) => (id === "*" ? "the repo-wide steps" : id);
  const lines = [`Time by component: ${used.map(([id, ms]) => `${name(id)} ${fmtDuration(ms)}`).join(", ")}.`];
  const [top, topMs] = used[0];
  const budgetMin = (id: string) => Math.round((b.floorMs?.get(id) ?? componentMinutes * 60000) / 60000);
  if (cut.total) lines.push(`The audit's total time budget ran out. Rerun with --budget-total ${Math.ceil((b.totalMs * 2) / 60000)} to give it more.`);
  const starved = cut.components.filter((c) => c !== "*");
  if (starved.length) lines.push(`${starved.map(name).join(", ")} ran out of ${starved.length === 1 ? "its" : "their"} time budget. Rerun with --budget-component ${Math.max(...starved.map((c) => budgetMin(c))) * 2} to give ${starved.length === 1 ? "it" : "them"} more.`);
  else if (top !== "*") lines.push(`${top} used the most (${fmtDuration(topMs)} of its ${budgetMin(top)}-minute budget); if its checks are cut off, rerun with --budget-component ${budgetMin(top) * 2}.`);
  return lines;
}
