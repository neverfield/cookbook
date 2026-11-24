import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A pull request may change the scripts or the instrument that measures them, not both, so "the
// product improved" and "the grader moved" can't hide in one change. The instrument is everything
// that decides whether a result is right: the eval harness, cases and graders, each fixture's
// expected.json and truth.json, the holdout's scorer and adapter, and the trials' truth and runner.
// A fixture's repo/ tree is an input, not a grader, so a new fixture can land with the fix it tests.
// A PR that must change both says why on a line of its description:
//   Instrument-freeze exception: <reason>
//
// node support/tools/instrument-freeze.ts --base <ref> [--head <ref>]   (the PR body in SA_PR_BODY)

const ACCELERATOR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Side = "scripts" | "instrument" | "other";

export function sideOf(path: string): Side {
  if (path.startsWith("skill/agent-readiness/")) {
    if (path.startsWith("skill/agent-readiness/rubric/") || path === "skill/agent-readiness/RELEASE.json") return "other";
    return "scripts";
  }
  if (/^support\/evals\/(lib|cases)\//.test(path) || path === "support/evals/run.ts") return "instrument";
  if (path === "support/tools/fixture.ts" || path === "support/tools/known-failures.ts" || path === "support/tools/instrument-freeze.ts") return "instrument";
  if (/^support\/fixtures\/[^/]+\/(expected|truth)\.json$/.test(path)) return "instrument";
  if (path.startsWith("support/holdout/") && path !== "support/holdout/collision-log.json" && !path.startsWith("support/holdout/records/")) return "instrument";
  if (path.startsWith("support/trials/truth/") || path === "support/trials/trials.test.ts") return "instrument";
  return "other";
}

export const EXCEPTION = /^Instrument-freeze exception:[ \t]*(\S.{9,})$/m;

export function freezeProblems(changed: string[], body: string): string[] {
  const scripts = changed.filter((p) => sideOf(p) === "scripts");
  const instrument = changed.filter((p) => sideOf(p) === "instrument");
  if (!scripts.length || !instrument.length || EXCEPTION.test(body)) return [];
  const show = (xs: string[]) => xs.slice(0, 8).join(", ") + (xs.length > 8 ? `, and ${xs.length - 8} more` : "");
  return [
    `This pull request changes the scripts (${show(scripts)}) and the instrument that measures them (${show(instrument)}).`,
    "Land the instrument change in its own pull request, measured with the scripts held fixed, or add a line `Instrument-freeze exception: <reason>` to the description.",
  ];
}

function changedFiles(base: string, head: string): string[] {
  const prefix = spawnSync("git", ["rev-parse", "--show-prefix"], { cwd: ACCELERATOR, encoding: "utf8" }).stdout.trim();
  const r = spawnSync("git", ["diff", "--name-only", `${base}...${head}`, "--", "."], { cwd: ACCELERATOR, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git diff ${base}...${head} failed: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p));
}

function main(argv: string[]): void {
  const arg = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const base = arg("base");
  if (!base) {
    process.stderr.write("usage: instrument-freeze.ts --base <ref> [--head <ref>]\n");
    process.exit(2);
  }
  const changed = changedFiles(base, arg("head") ?? "HEAD");
  const problems = freezeProblems(changed, process.env.SA_PR_BODY ?? "");
  const count = (s: Side) => changed.filter((p) => sideOf(p) === s).length;
  process.stdout.write(`${changed.length} files changed: ${count("scripts")} scripts, ${count("instrument")} instrument, ${count("other")} other.\n`);
  if (problems.length) {
    for (const p of problems) process.stdout.write(`::error::${p}\n`);
    process.exit(1);
  }
  process.stdout.write(EXCEPTION.test(process.env.SA_PR_BODY ?? "") && count("scripts") && count("instrument") ? "Both change, with the exception the description gives.\n" : "The instrument freeze holds.\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
