import { basename } from "node:path";
import type { Rubric } from "../rubric.ts";
import { STACKS } from "../support.ts";
import type { Component, Profile } from "../types.ts";
import { addDays, git, ownSkillPath, today } from "../util.ts";

// Who owns each change in the history window: the deepest component under which it lies, else the
// satellite or cut folder that lists it, else nobody. Every counted change lands in exactly one of
// those, so the shares and the unowned share add up to the whole.

export interface ChangeCounts {
  byFile: Map<string, number>;
  total: number;
  // Files a generated pattern (dist/, build/) matched, held apart: one under a component whose own
  // folder carries the pattern, such as services/build, is that component's source, not output.
  generated: Map<string, number>;
}

// Counted up to the audited commit, so a commit made after `init` can't move the shares. Bots,
// lockfile-only commits, generated files and the audit's own records don't count.
export function changeCounts(repo: string, rubric: Rubric, commit = "HEAD"): ChangeCounts {
  const since = addDays(today(), -rubric.components.historyDays);
  const r = git(["log", commit, `--since=${since}`, "--no-merges", "--name-status", "--no-renames", "--format=@@%an%x09%ae"], repo);
  const byFile = new Map<string, number>();
  const generated = new Map<string, number>();
  let total = 0;
  let author = "";
  let commitFiles: string[] = [];
  const flush = () => {
    const isBot = rubric.components.botAuthorPatterns.some((p) => author.toLowerCase().includes(p.toLowerCase()));
    const lockOnly = commitFiles.length > 0 && commitFiles.every((f) => rubric.components.lockfiles.includes(basename(f)));
    if (!isBot && !lockOnly) {
      for (const f of commitFiles) {
        // Installing this skill, or committing its records, isn't work in the repo's components.
        if (ownSkillPath(f) || f.startsWith(".agent-readiness/")) continue;
        if (rubric.components.lockfiles.includes(basename(f))) continue;
        if (rubric.components.generatedPatterns.some((g) => f.includes(g))) {
          generated.set(f, (generated.get(f) ?? 0) + 1);
          continue;
        }
        byFile.set(f, (byFile.get(f) ?? 0) + 1);
        total++;
      }
    }
    commitFiles = [];
  };
  if (r.ok) {
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("@@")) {
        flush();
        author = line.slice(2);
      } else if (/^[AMD]\t/.test(line)) {
        commitFiles.push(line.slice(2));
      }
    }
    flush();
  }
  return { byFile, total, generated };
}

const under = (file: string, dir: string) => dir === "." || file === dir || file.startsWith(dir + "/");

// The share of all counted changes that lie under a folder.
export function shareUnder(counts: ChangeCounts, dir: string): number {
  if (counts.total === 0) return 0;
  let n = 0;
  for (const [f, k] of counts.byFile) if (under(f, dir)) n += k;
  return n / counts.total;
}

// Two components at the root split its files: the root package keeps the Node files, and the app
// next to it, such as Django or Laravel, takes its own files and the rest of the root.
function ownsByType(c: Component, file: string): boolean {
  return Boolean(c.stack && STACKS.find((s) => s.id === c.stack)?.files?.test(file));
}

const NODE_FILE = /\.(c|m)?[jt]sx?$|\.(vue|svelte|astro|css|scss|sass|less|html?)$|(^|\/)(package(-lock)?\.json|pnpm-(lock|workspace)\.yaml|yarn\.lock|bun\.lockb?|\.nvmrc|\.npmrc|tsconfig[^/]*\.json)$/;

export function owningComponent(file: string, comps: Component[]): Component | null {
  let best: Component | null = null;
  let bestLen = -1;
  for (const c of comps) {
    const len = c.path === "." ? 0 : c.path.length;
    if (under(file, c.path) && len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  const roots = comps.filter((c) => c.path === ".");
  if (best?.path !== "." || roots.length < 2) return best;
  const app = roots.find((c) => c !== best && STACKS.find((s) => s.id === c.stack)?.files);
  return roots.find((c) => ownsByType(c, file)) ?? (NODE_FILE.test(file) || !app ? best : app);
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export type Satellite = Profile["satellites"][number];

// Sets each component's changes and share, each satellite's own share where no component holds it,
// and returns what no component or satellite holds. Under a rubric that counts the unowned changes,
// shares are of every counted change; under an older one, of the changes components own, as before.
export function assignShares(comps: Component[], satellites: Satellite[], counts: ChangeCounts, rubric: Rubric): NonNullable<Profile["ownership"]> {
  const byComp = new Map<string, number>();
  const bySat = new Map<string, number>();
  const unownedByTop = new Map<string, number>();
  let unowned = 0;
  const files = new Map(counts.byFile);
  for (const [f, k] of counts.generated) {
    const owner = owningComponent(f, comps);
    if (owner && owner.path !== "." && rubric.components.generatedPatterns.some((g) => f.includes(g) && `${owner.path}/`.includes(g))) files.set(f, k);
  }
  const total = [...files.values()].reduce((s, k) => s + k, 0);
  for (const [f, k] of files) {
    const owner = owningComponent(f, comps);
    if (owner) {
      byComp.set(owner.id, (byComp.get(owner.id) ?? 0) + k);
      continue;
    }
    const sat = satellites.filter((s) => under(f, s.path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (sat) {
      bySat.set(sat.path, (bySat.get(sat.path) ?? 0) + k);
      continue;
    }
    unowned += k;
    const top = f.includes("/") ? f.split("/")[0] + "/" : f;
    unownedByTop.set(top, (unownedByTop.get(top) ?? 0) + k);
  }
  let owned = 0;
  for (const c of comps) {
    c.changes = byComp.get(c.id) ?? 0;
    owned += c.changes;
  }
  const counted = rubric.components.unowned === "counted";
  const denominator = counted ? total : owned;
  for (const c of comps) c.changeShare = denominator > 0 ? round(c.changes / denominator) : round(1 / comps.length);
  for (const s of satellites) s.changeShare = total > 0 ? round((bySat.get(s.path) ?? 0) / total) : 0;
  const unownedTop = [...unownedByTop.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([p]) => p);
  return { changes: total, unowned, unownedShare: total > 0 ? round(unowned / total) : 0, unownedTop, counted };
}
