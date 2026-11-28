import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A pull request may change the scripts or the instrument that measures them, not both, so "the
// product improved" and "the grader moved" can't hide in one change. The instrument is everything
// that decides whether a result is right: the eval harness, cases and graders, each fixture's
// expected.json and truth.json, the holdout's scorer and adapter, the trials (their recordings,
// ceilings, tracking and tiers in trials.json, their truth and runner), the known-failures list, and
// the agent-readiness workflows, which are the gate itself, with the docs list that lets CI skip part
// of it (ci-scope.ts). A fixture's repo/ tree is an input, not
// a grader, so a new fixture can land with the fix it tests, and a change to tests/known-failures.json
// that only removes entries is the fix landing, not the instrument moving. A PR that must change both
// says why on a line of its description:
//   Instrument-freeze exception: <reason>
//
// The cheapest way to go green is to assert less, which an instrument-only PR can do without
// touching the scripts. So the ledger below counts what the trials, the known failures and CI's
// negative evals assert, at the base and at the head, and any move toward asserting less needs a
// line of the description:
//   Asserting less: <reason>
//
// CI runs the base's copy of this file, so a PR is judged by the rules it was opened against. It
// reads both sides with git and runs nothing from the PR, and needs nothing beyond Node's own modules.
//
// node support/tools/instrument-freeze.ts --base <ref> [--head <ref>]   (the PR body in SA_PR_BODY)

export type Side = "scripts" | "instrument" | "other";

export const KNOWN_FAILURES = "tests/known-failures.json";
const TRIALS = "support/trials/trials.json";
const TRUTH = "support/trials/truth/";
const RUBRICS = "skill/agent-readiness/rubric/";
// Paths outside the accelerator are named from it, as git sees them from the repo root.
const WORKFLOWS = "../../.github/workflows/";
const CI_WORKFLOW = `${WORKFLOWS}agent-readiness.yml`;

export function sideOf(path: string): Side {
  if (path.startsWith("skill/agent-readiness/")) {
    if (path.startsWith(RUBRICS) || path === "skill/agent-readiness/RELEASE.json") return "other";
    return "scripts";
  }
  if (/^support\/evals\/(lib|cases)\//.test(path) || path === "support/evals/run.ts") return "instrument";
  if (["support/tools/fixture.ts", "support/tools/known-failures.ts", "support/tools/instrument-freeze.ts", "support/tools/ci-scope.ts"].includes(path)) return "instrument";
  if (/^support\/fixtures\/[^/]+\/(expected|truth)\.json$/.test(path)) return "instrument";
  if (path.startsWith("support/holdout/") && path !== "support/holdout/collision-log.json" && !path.startsWith("support/holdout/records/")) return "instrument";
  if (path.startsWith("support/trials/")) return "instrument";
  if (path === KNOWN_FAILURES) return "instrument";
  if (path.startsWith(WORKFLOWS) && /^agent-readiness[^/]*\.ya?ml$/.test(path.slice(WORKFLOWS.length))) return "instrument";
  return "other";
}

export const EXCEPTION = /^Instrument-freeze exception:[ \t]*(\S.{9,})$/m;
export const ASSERTING_LESS = /^Asserting less:[ \t]*(\S.{9,})$/m;

const show = (xs: string[]) => xs.slice(0, 8).join(", ") + (xs.length > 8 ? `, and ${xs.length - 8} more` : "");

// `removalOnly` lists instrument files whose change only takes entries out, which count as other.
export function freezeProblems(changed: string[], body: string, removalOnly: string[] = []): string[] {
  const scripts = changed.filter((p) => sideOf(p) === "scripts");
  const instrument = changed.filter((p) => sideOf(p) === "instrument" && !removalOnly.includes(p));
  if (!scripts.length || !instrument.length || EXCEPTION.test(body)) return [];
  return [
    `This pull request changes the scripts (${show(scripts)}) and the instrument that measures them (${show(instrument)}).`,
    "Land the instrument change in its own pull request, measured with the scripts held fixed, or add a line `Instrument-freeze exception: <reason>` to the description.",
  ];
}

// Each failure in the head's list is also in the base's: the change only removes entries.
export function onlyRemoves(base: string | null, head: string | null): boolean {
  if (base === null || head === null) return false;
  try {
    const key = (f: unknown) => JSON.stringify(f);
    const before = new Set((JSON.parse(base).failures as unknown[]).map(key));
    return (JSON.parse(head).failures as unknown[]).every((f) => before.has(key(f)));
  } catch {
    return false;
  }
}

// ---- The ledger: what the gate asserts, counted the same way at both ends of the PR. ----

// One tree's files, as text, null where the file doesn't exist.
export interface Tree {
  trials: string | null;
  truth: Record<string, string>;
  knownFailures: string | null;
  workflow: string | null;
  rubric: string | null;
}

export interface TrialLedger {
  asserted: number;
  truth: number;
  ceiling: number;
  tracking: string[];
  scan: boolean;
  budgets: Record<string, number>;
}

export interface Ledger {
  trials: Record<string, TrialLedger>;
  assertedFields: number;
  truthFields: number;
  ceilingTotal: number;
  tracking: number;
  scans: number;
  knownFailures: number;
  negativeCases: number;
}

// A recorded value's leaves: each primitive, each array element, and an empty array or object as one.
export function leaves(v: unknown): number {
  if (Array.isArray(v)) return v.length ? v.reduce((s: number, x) => s + leaves(x), 0) : 1;
  if (v && typeof v === "object") {
    const vals = Object.values(v);
    return vals.length ? vals.reduce((s: number, x) => s + leaves(x), 0) : 1;
  }
  return 1;
}

interface TrialEntry {
  id: string;
  tier?: string;
  tracking?: Record<string, string>;
  falseInstructionFindings?: number;
  recorded?: unknown;
  recordedAlso?: unknown;
  [k: string]: unknown;
}

// The negative cases CI runs: the workflow's NEGATIVE_CASES list.
export function negativeCases(workflow: string | null): string[] {
  const m = workflow?.match(/NEGATIVE_CASES: >-\n([\s\S]*?)\n\s*steps:/);
  return m ? m[1].replace(/\s/g, "").split(",").filter(Boolean) : [];
}

export function ledgerOf(tree: Tree): Ledger {
  const rubric = tree.rubric ? (JSON.parse(tree.rubric).budgets ?? {}) : {};
  const trials: Record<string, TrialLedger> = {};
  for (const t of (tree.trials ? (JSON.parse(tree.trials).trials as TrialEntry[]) : [])) {
    // The budget an audit gets: the trial's own, or the latest rubric's default.
    const budgets: Record<string, number> = {};
    if (typeof rubric.componentMinutes === "number") budgets.componentMinutes = rubric.componentMinutes;
    if (typeof rubric.totalMinutes === "number") budgets.totalMinutes = rubric.totalMinutes;
    if (typeof rubric.commandTimeoutSec === "number") budgets.commandTimeoutSec = rubric.commandTimeoutSec;
    for (const [k, v] of Object.entries(t)) {
      const m = /^budget(\w+)Minutes$/.exec(k);
      if (m && typeof v === "number") budgets[`${m[1][0].toLowerCase()}${m[1].slice(1)}Minutes`] = v;
    }
    trials[t.id] = {
      asserted: leaves(t.recorded ?? {}) + (t.recordedAlso ? leaves(t.recordedAlso) : 0),
      truth: tree.truth[t.id] ? leaves(JSON.parse(tree.truth[t.id])) : 0,
      ceiling: t.falseInstructionFindings ?? 0,
      tracking: Object.keys(t.tracking ?? {}).sort(),
      scan: t.tier === "read-only",
      budgets,
    };
  }
  const all = Object.values(trials);
  const sum = (f: (t: TrialLedger) => number) => all.reduce((s, t) => s + f(t), 0);
  return {
    trials,
    assertedFields: sum((t) => t.asserted),
    truthFields: sum((t) => t.truth),
    ceilingTotal: sum((t) => t.ceiling),
    tracking: sum((t) => t.tracking.length),
    scans: sum((t) => (t.scan ? 1 : 0)),
    knownFailures: tree.knownFailures ? (JSON.parse(tree.knownFailures).failures as unknown[]).length : 0,
    negativeCases: negativeCases(tree.workflow).length,
  };
}

// Every move from base to head toward asserting less. A new trial adds what it asserts; only a
// trial kept from the base is compared field by field.
export function lessMoves(base: Ledger, head: Ledger): string[] {
  const moves: string[] = [];
  for (const [id, b] of Object.entries(base.trials)) {
    const h = head.trials[id];
    if (!h) {
      moves.push(`trial ${id} is removed`);
      continue;
    }
    if (h.asserted < b.asserted) moves.push(`${id} asserts ${h.asserted} recorded fields, down from ${b.asserted}`);
    if (h.truth < b.truth) moves.push(`${id}'s truth has ${h.truth} fields, down from ${b.truth}`);
    if (h.ceiling > b.ceiling) moves.push(`${id}'s false-finding ceiling rises from ${b.ceiling} to ${h.ceiling}`);
    const tracked = h.tracking.filter((c) => !b.tracking.includes(c));
    if (tracked.length) moves.push(`${id} moves ${tracked.join(", ")} to tracking`);
    if (h.scan && !b.scan) moves.push(`${id} turns from an executed trial into a read-only scan`);
    for (const [k, v] of Object.entries(b.budgets)) {
      if (h.budgets[k] === undefined || h.budgets[k] < v) moves.push(`${id}'s ${k} budget falls from ${v} to ${h.budgets[k] ?? "none"}`);
    }
  }
  if (head.knownFailures > base.knownFailures) moves.push(`known failures rise from ${base.knownFailures} to ${head.knownFailures}`);
  if (head.negativeCases < base.negativeCases) moves.push(`CI's negative evals fall from ${base.negativeCases} cases to ${head.negativeCases}`);
  return moves;
}

export function ledgerProblems(base: Ledger, head: Ledger, body: string): string[] {
  const moves = lessMoves(base, head);
  if (!moves.length || ASSERTING_LESS.test(body)) return [];
  return [
    `This pull request moves the gate toward asserting less: ${show(moves)}.`,
    "Say why on a line `Asserting less: <reason>` in the description, or keep what the gate asserts.",
  ];
}

export function ledgerTable(base: Ledger, head: Ledger): string {
  const rows: [string, keyof Ledger][] = [
    ["trials", "trials"],
    ["asserted recorded fields", "assertedFields"],
    ["truth fields", "truthFields"],
    ["false-finding ceiling total", "ceilingTotal"],
    ["tracking guards", "tracking"],
    ["read-only scan trials", "scans"],
    ["known failures", "knownFailures"],
    ["CI negative eval cases", "negativeCases"],
  ];
  const n = (l: Ledger, k: keyof Ledger) => (k === "trials" ? Object.keys(l.trials).length : (l[k] as number));
  return ["What the gate asserts         base   head", ...rows.map(([label, k]) => `${label.padEnd(28)}${String(n(base, k)).padStart(6)} ${String(n(head, k)).padStart(6)}`)].join("\n") + "\n";
}

// ---- git ----

function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// The accelerator's path from the repo root, from the working directory CI runs this in.
function prefix(): string {
  return git(["rev-parse", "--show-prefix"]).stdout.trim();
}

function fileAt(ref: string, path: string): string | null {
  const r = git(["show", `${ref}:${pathFromRoot(path)}`]);
  return r.status === 0 ? r.stdout : null;
}

function pathFromRoot(path: string): string {
  return path.startsWith("../../") ? path.slice(6) : `${prefix()}${path}`;
}

export function treeAt(ref: string): Tree {
  const truth: Record<string, string> = {};
  const listed = git(["ls-tree", "--full-tree", "--name-only", `${ref}:${pathFromRoot(TRUTH).replace(/\/$/, "")}`]);
  if (listed.status === 0) for (const name of listed.stdout.split("\n").filter((n) => n.endsWith(".json"))) truth[name.slice(0, -5)] = fileAt(ref, TRUTH + name) ?? "";
  const rubrics = git(["ls-tree", "--full-tree", "--name-only", `${ref}:${pathFromRoot(RUBRICS).replace(/\/$/, "")}`]);
  const latest = rubrics.status === 0 ? rubrics.stdout.split("\n").filter((n) => n.endsWith(".json")).sort().pop() : undefined;
  return { trials: fileAt(ref, TRIALS), truth, knownFailures: fileAt(ref, KNOWN_FAILURES), workflow: fileAt(ref, CI_WORKFLOW), rubric: latest ? fileAt(ref, RUBRICS + latest) : null };
}

function mergeBase(base: string, head: string): string {
  const r = git(["merge-base", base, head]);
  if (r.status !== 0) throw new Error(`git merge-base ${base} ${head} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export function changedFiles(base: string, head: string): string[] {
  const p = prefix();
  const r = git(["diff", "--name-only", `${base}...${head}`, "--", ".", ":(top).github/workflows"]);
  if (r.status !== 0) throw new Error(`git diff ${base}...${head} failed: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((f) => (f.startsWith(p) ? f.slice(p.length) : `../../${f}`));
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
  const head = arg("head") ?? "HEAD";
  const body = process.env.SA_PR_BODY ?? "";
  const from = mergeBase(base, head);
  const changed = changedFiles(base, head);
  const removalOnly = changed.includes(KNOWN_FAILURES) && onlyRemoves(fileAt(from, KNOWN_FAILURES), fileAt(head, KNOWN_FAILURES)) ? [KNOWN_FAILURES] : [];
  const problems = freezeProblems(changed, body, removalOnly);
  const count = (s: Side) => changed.filter((p) => sideOf(p) === s && !(s === "instrument" && removalOnly.includes(p))).length;
  process.stdout.write(`${changed.length} files changed: ${count("scripts")} scripts, ${count("instrument")} instrument, ${changed.length - count("scripts") - count("instrument")} other.\n`);

  const before = ledgerOf(treeAt(from));
  const after = ledgerOf(treeAt(head));
  process.stdout.write(`\n${ledgerTable(before, after)}`);
  const moves = lessMoves(before, after);
  for (const m of moves) process.stdout.write(`asserting less: ${m}\n`);
  problems.push(...ledgerProblems(before, after, body));

  if (problems.length) {
    for (const p of problems) process.stdout.write(`::error::${p}\n`);
    process.exit(1);
  }
  process.stdout.write(EXCEPTION.test(body) && count("scripts") && count("instrument") ? "Both change, with the exception the description gives.\n" : "The instrument freeze holds.\n");
  if (moves.length) process.stdout.write("The gate asserts less, for the reason the description gives.\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
