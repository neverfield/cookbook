// Splits the trials into shards of about equal wall time, from each trial's measured minutes: the
// longest first, each onto the shard with the least so far (ties to the lower shard, then by id), so
// the split is the same on every machine and only moves when the minutes or the trials do.

export interface Sized {
  id: string;
  minutes: number;
}

export function shards<T extends Sized>(trials: T[], count: number): T[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error(`a shard count is a whole number, at least 1; got ${count}`);
  const out: T[][] = Array.from({ length: count }, () => []);
  const load = new Array<number>(count).fill(0);
  const order = [...trials].sort((a, b) => b.minutes - a.minutes || a.id.localeCompare(b.id));
  for (const t of order) {
    const i = load.indexOf(Math.min(...load));
    out[i].push(t);
    load[i] += t.minutes;
  }
  return out;
}

// SA_TRIALS_SHARD=k/n: the k-th of n shards, counted from 1.
export function parseShard(value: string | undefined): { index: number; count: number } | null {
  if (!value) return null;
  const m = /^(\d+)\/(\d+)$/.exec(value.trim());
  const index = m ? Number(m[1]) : NaN;
  const count = m ? Number(m[2]) : NaN;
  if (!m || count < 1 || index < 1 || index > count) throw new Error(`SA_TRIALS_SHARD takes k/n with 1 <= k <= n, such as 2/3; got ${value}`);
  return { index, count };
}

export function minutesOf<T extends Sized>(trials: T[]): number {
  return Math.round(trials.reduce((s, t) => s + t.minutes, 0) * 10) / 10;
}
