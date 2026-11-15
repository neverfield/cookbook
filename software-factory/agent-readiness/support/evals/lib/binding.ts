import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ACCELERATOR, SKILL, SUPPORT } from "../../tools/fixture.ts";

// What an eval run measured, so a release pass names the exact code it passed on. Each digest is
// canonical: POSIX paths relative to the accelerator, sorted, contents with LF line endings, so the
// Mac and Linux machines that run evals agree on it.
export interface Binding {
  // HEAD when the run started; null outside a git checkout.
  commit: string | null;
  // Uncommitted changes under any bound path when the run started.
  dirty: boolean;
  // The copyable skill except its rubrics and RELEASE.json, which is regenerated from it.
  scripts: string;
  rubric: string;
  // The harness, grader, judges, cases and fixtures: the instrument.
  evals: string;
}

const SKILL_REL = relative(ACCELERATOR, SKILL);
const RUBRIC_DIR = join(SKILL, "rubric");
const EVALS = [join(SUPPORT, "evals", "lib"), join(SUPPORT, "evals", "cases"), join(SUPPORT, "evals", "run.ts"), join(SUPPORT, "fixtures"), join(SUPPORT, "tools", "fixture.ts")];

function files(path: string, skip: (p: string) => boolean): string[] {
  if (!existsSync(path) || skip(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((n) => files(join(path, n), skip));
}

const posix = (p: string) => relative(ACCELERATOR, p).split(sep).join("/");

export function canonicalDigest(paths: string[], skip: (p: string) => boolean = () => false): string {
  const h = createHash("sha256");
  const all = paths.flatMap((p) => files(p, skip)).map((f) => [posix(f), f] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [rel, f] of all) {
    const body = createHash("sha256").update(readFileSync(f, "utf8").replace(/\r\n/g, "\n")).digest("hex");
    h.update(`${rel}\0${body}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

function git(args: string[]): string | null {
  const r = spawnSync("git", args, { cwd: ACCELERATOR, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

const skipScripts = (p: string) => p === RUBRIC_DIR || p === join(SKILL, "RELEASE.json") || p.includes(`${sep}node_modules`) || p.endsWith(`${sep}.DS_Store`);

export function currentBinding(): Binding {
  const bound = [SKILL_REL, ...EVALS.map((p) => relative(ACCELERATOR, p))];
  const status = git(["status", "--porcelain", "--", ...bound]);
  return {
    commit: git(["rev-parse", "HEAD"]),
    dirty: status === null ? false : status.length > 0,
    scripts: canonicalDigest([SKILL], skipScripts),
    rubric: canonicalDigest([RUBRIC_DIR]),
    evals: canonicalDigest(EVALS, (p) => p.includes(`${sep}node_modules`) || p.endsWith(`${sep}.DS_Store`)),
  };
}

// Why a run's binding doesn't let it release the code checked out now; empty when it does.
export function bindingProblems(run: Binding | undefined, now: Binding): string[] {
  if (!run) return ["the run records no commit or code digests, so it can't be bound to a release; rerun it with this harness"];
  const out: string[] = [];
  if (!run.commit) out.push("the run records no commit");
  if (run.dirty) out.push(`the run started from uncommitted changes on ${run.commit?.slice(0, 7) ?? "an unknown commit"}, so no commit holds the code it measured`);
  for (const [k, label] of [["scripts", "the skill's scripts"], ["rubric", "the rubric"], ["evals", "the eval harness, cases or fixtures"]] as const) {
    if (run[k] !== now[k]) out.push(`${label} changed since the run (${run[k]} in the run, ${now[k]} now)`);
  }
  return out;
}
