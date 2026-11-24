import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Scores the audit against truth written from each repository (PROTOCOL.md). Frozen by digest with
// the protocol, schemas and thresholds: the adapter that turns a report into an Observation
// (observe.ts) may follow the report's format, and this file may not change. It reads no report
// itself, so a change to the report can't change what counts as right.

export const HOLDOUT = dirname(fileURLToPath(import.meta.url));

export const ECOSYSTEMS = ["node", "python", "go", "rust", "jvm", "dotnet", "php", "ruby", "swift", "dart", "elixir", "terraform", "cpp", "android", "xcode", "other"] as const;
export const PLACEMENTS = ["component", "member", "satellite", "excluded"] as const;
export const CI_CONCLUSIONS = ["success", "failure", "none", "undetermined"] as const;
export const TESTS_NEED = ["nothing", "service", "network", "undetermined"] as const;
export const CLEAN_PASSES = ["yes", "no", "undetermined"] as const;
export const NEXT_ACTIONS = ["fix_failing_tests", "make_tests_hermetic", "add_tests", "strengthen_tests", "pin_toolchain", "add_lockfile", "fix_instructions", "add_agent_instructions", "remove_secret", "declare_environment", "none", "other"] as const;
export const CRITICAL = ["K1", "K2", "K3", "K4", "K5", "K6", "K7"] as const;
export const RATES = ["R1", "R2", "R3", "R4", "R5", "R6"] as const;
// The only feedback the Project receives from a look, besides PASS or FAIL: counts of these.
export const CLASSES = [
  ...CRITICAL,
  "R1_missing",
  "R1_misplaced",
  "R2_no_command",
  "R2_other_command",
  "R3_missing",
  "R3_level_0",
  "R3_unproven",
  "R3_undetermined",
  "R3_not_assessed",
  "R4_rejected",
  "R5_disagree",
  "R6_off",
  "R6_not_reported",
] as const;
export const ENVIRONMENTS = ["container", "disposable_vm", "host", "none"] as const;
export const ARMS = ["scripted", "agent"] as const;

export type Critical = (typeof CRITICAL)[number];
export type Rate = (typeof RATES)[number];
export type FailureClass = (typeof CLASSES)[number];

export interface TruthComponent {
  path: string;
  ecosystem: (typeof ECOSYSTEMS)[number];
  placement: (typeof PLACEMENTS)[number];
  of?: string;
  changeShare: number | null;
  hasTests: boolean;
  install: string[];
  test: string[];
  testsNeed: (typeof TESTS_NEED)[number];
  cleanPasses: (typeof CLEAN_PASSES)[number];
  notes?: string;
}

export interface Truth {
  schema: "agent-readiness/holdout-truth@1";
  repo: string;
  commit: string;
  writtenAt?: string;
  ci: { conclusion: (typeof CI_CONCLUSIONS)[number]; source?: string };
  components: TruthComponent[];
  unownedShare: number | null;
  secrets: { file: string; line?: number | null; real: boolean; why?: string }[];
  nextAction: { kind: (typeof NEXT_ACTIONS)[number]; text?: string };
  dropped: number;
}

// What one run of the audit said, in terms that don't depend on the report's format.
export interface ObservedComponent {
  path: string;
  placement: (typeof PLACEMENTS)[number] | "unplaced";
  // The standard level given, or null when none was.
  level: number | null;
  status: "proven" | "unproven" | "undetermined" | "not_assessed";
  // The report says the component has no tests.
  noTests: boolean;
  // The test command the audit ran or planned, as run from path.
  testCommand: string | null;
}

export interface Observation {
  schema: "agent-readiness/holdout-observation@1";
  arm: (typeof ARMS)[number];
  environment: (typeof ENVIRONMENTS)[number];
  sealed: boolean;
  crashed: boolean;
  overBudget: boolean;
  components: ObservedComponent[];
  unownedShare: number | null;
  blocking: { file: string; line: number | null }[];
  // Remediation steps that would break the repo, such as ignoring a tracked source file.
  harmfulAdvice: number;
  after: { testCommandRefused: boolean | null; treeChanged: boolean | null; leftovers: boolean | null };
  factConflicts: number | null;
  agent: { undefinedCommands: number; repoCodeOutsideScripts: number } | null;
  // The report names a fact of its environment that changes a level, such as the network being on.
  statesDifference: boolean;
}

export interface Thresholds {
  schema: "agent-readiness/holdout-thresholds@1";
  sets: { validation: number; test: number; reserve: number };
  looks: { validation: string; testSpentAtFail: number; amendments: number; amendmentWindow: string };
  infraRetries: number;
  agentArmRepos: number;
  supportedEcosystems: string[];
  componentShareFloor: number;
  unownedTolerance: number;
  critical: Record<Critical, string>;
  rates: Record<Rate, { bar: number; unit: "repo" | "component"; what: string }>;
  interval: { method: "wilson"; confidence: number; published: boolean; decides: boolean };
}

export interface Tally {
  hit: number;
  of: number;
}

export interface RepoScore {
  critical: Record<Critical, number>;
  // Repo-unit rates are a tally of at most one; component-unit rates count components.
  rates: Record<Rate, Tally>;
  classes: Partial<Record<FailureClass, number>>;
}

// The files frozen before the first look. The record carries their digest, so a look scored under
// any other protocol is visibly a different instrument.
export const PROTOCOL_FILES = ["PROTOCOL.md", "record.schema.json", "score.ts", "thresholds.json", "truth.schema.json"] as const;

export function fileDigest(file: string): string {
  return createHash("sha256").update(readFileSync(file, "utf8").replace(/\r\n/g, "\n")).digest("hex");
}

export function protocolDigest(dir = HOLDOUT): string {
  const h = createHash("sha256");
  for (const f of PROTOCOL_FILES) h.update(`${f}\0${fileDigest(join(dir, f))}\n`);
  return h.digest("hex");
}

export function loadThresholds(file = join(HOLDOUT, "thresholds.json")): Thresholds {
  return JSON.parse(readFileSync(file, "utf8")) as Thresholds;
}

export function normPath(p: string): string {
  const s = p.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  return s === "" ? "." : s;
}

const SCRIPT_RUNNERS = ["npm", "pnpm", "yarn", "bun"];
const SUBCOMMAND_RUNNERS = ["go", "cargo", "make", "dotnet", "mvn", "./mvnw", "mvnw", "gradle", "./gradlew", "gradlew", "mix", "rake", "just", "task", "lerna", "nx", "turbo", "deno", "swift", "flutter", "dart", "composer", "php", "bin/rails", "rails", "hatch", "nox"];
const WRAPPERS: Record<string, string[]> = {
  corepack: [],
  npx: ["--yes", "-y"],
  uv: ["--frozen", "--locked", "--isolated", "--no-project", "--all-extras", "--group", "--extra", "--with", "--with-requirements", "--python", "--package", "--project", "--directory"],
  poetry: [],
  pipenv: [],
  pdm: [],
  bundle: [],
  timeout: [],
  "xvfb-run": ["-a"],
};
const WRAPPER_VERB: Record<string, string> = { uv: "run", poetry: "run", pipenv: "run", pdm: "run", bundle: "exec", npx: "", corepack: "", timeout: "", "xvfb-run": "" };
const VALUE_FLAGS = new Set(["--group", "--extra", "--with", "--with-requirements", "--python", "--package", "--project", "--directory"]);

// What a test command runs, without its flags and wrappers: the runner and the script, subcommand
// or module it runs. `.venv/bin/python -m pytest -q`, `uv run pytest -n auto` and `pytest` are one
// command; `npm test` and `npm run test` are one; `go test -count=1 ./...` is `go test`.
export function commandSignature(c: string): string {
  const segment = c.split(/&&|;/).map((s) => s.trim()).filter(Boolean).pop() ?? "";
  let t = segment.replace(/["']/g, "").split(/\s+/).filter(Boolean);
  while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t.shift();
  for (let changed = true; changed && t.length; ) {
    changed = false;
    t[0] = t[0].replace(/^.*\/(?=(python3?|pytest|node|tox|ruby|php|rspec|jest|vitest)$)/, "");
    const w = WRAPPERS[t[0]];
    if (w) {
      const verb = WRAPPER_VERB[t[0]];
      t.shift();
      if (verb && t[0] === verb) t.shift();
      while (t.length && (t[0].startsWith("-") || /^\d+[smh]?$/.test(t[0]))) {
        const flag = t.shift()!;
        if (VALUE_FLAGS.has(flag)) t.shift();
      }
      changed = true;
    } else if ((t[0] === "python" || t[0] === "python3") && t[1] === "-m") {
      t = t.slice(2);
      changed = true;
    }
  }
  const [prog, ...rest] = t;
  if (!prog) return "";
  const words = rest.filter((x) => !x.startsWith("-"));
  if (SCRIPT_RUNNERS.includes(prog)) {
    const script = words[0] === "run" || words[0] === "run-script" ? words[1] : words[0];
    return `${prog} run ${script ?? ""}`.trim();
  }
  if (SUBCOMMAND_RUNNERS.includes(prog)) return `${prog} ${words[0] ?? ""}`.trim();
  if (prog === "node") return rest.includes("--test") ? "node --test" : `node ${words[0] ?? ""}`.trim();
  return prog;
}

export function normCommand(c: string): string {
  return commandSignature(c);
}

const zeroCritical = (): Record<Critical, number> => Object.fromEntries(CRITICAL.map((k) => [k, 0])) as Record<Critical, number>;
const zeroRates = (): Record<Rate, Tally> => Object.fromEntries(RATES.map((r) => [r, { hit: 0, of: 0 }])) as Record<Rate, Tally>;

export interface ScoreOptions {
  thresholds?: Thresholds;
  // The disposable-VM run of the same repo and commit, for R5.
  vm?: Observation | null;
  // The two steward judges' verdicts on the next action, for R4.
  judged?: [boolean, boolean] | null;
}

export function scoreRepo(truth: Truth, obs: Observation, opts: ScoreOptions = {}): RepoScore {
  const th = opts.thresholds ?? loadThresholds();
  const critical = zeroCritical();
  const rates = zeroRates();
  const classes: Partial<Record<FailureClass, number>> = {};
  const mark = (c: FailureClass) => (classes[c] = (classes[c] ?? 0) + 1);
  const event = (k: Critical) => {
    critical[k]++;
    mark(k);
  };
  const seen = new Map(obs.components.map((c) => [normPath(c.path), c]));
  const supported = (c: TruthComponent) => th.supportedEcosystems.includes(c.ecosystem);
  const green = truth.ci.conclusion === "success";
  const product = truth.components.filter((c) => c.placement === "component");

  // K1: a confident Level 0 or "no tests" on a component that is tested and green upstream.
  for (const c of product) {
    if (!green || !supported(c) || !c.hasTests || c.testsNeed !== "nothing" || c.cleanPasses === "no") continue;
    const o = seen.get(normPath(c.path));
    if (o && (o.level === 0 || o.noTests)) event("K1");
  }
  // K2: a level above the truth.
  for (const c of truth.components) {
    if (c.cleanPasses !== "no") continue;
    const o = seen.get(normPath(c.path));
    if (o && o.level !== null && o.level >= 1) event("K2");
  }
  // K3: a blocking finding the truth doesn't list as real, or advice that would break the repo.
  for (const b of obs.blocking) {
    const real = truth.secrets.some((s) => s.real && normPath(s.file) === normPath(b.file) && (s.line == null || b.line === null || s.line === b.line));
    if (!real) event("K3");
  }
  for (let i = 0; i < obs.harmfulAdvice; i++) event("K3");
  // K4: no sealed report.
  if (obs.crashed || !obs.sealed || obs.overBudget) event("K4");
  // K5: the repo is worse off after the audit.
  if (obs.after.testCommandRefused || obs.after.treeChanged || obs.after.leftovers) event("K5");
  // K6: one fact rendered with two values.
  if ((obs.factConflicts ?? 0) > 0) event("K6");
  // K7: the agent arm stepped outside the scripts.
  if (obs.arm === "agent" && obs.agent && (obs.agent.undefinedCommands > 0 || obs.agent.repoCodeOutsideScripts > 0)) event("K7");

  // R1: every component with enough of the changes is present and placed as the truth says.
  const weighty = truth.components.filter((c) => c.changeShare === null || c.changeShare >= th.componentShareFloor);
  let missing = 0;
  let misplaced = 0;
  for (const c of weighty) {
    const o = seen.get(normPath(c.path));
    if (c.placement === "excluded") {
      if (o && (o.placement === "component" || o.placement === "member")) misplaced++;
      continue;
    }
    if (!o) {
      const covered = c.placement === "member" && c.of !== undefined && seen.get(normPath(c.of))?.placement === "component";
      if (!covered) missing++;
      continue;
    }
    const ok =
      c.placement === "component"
        ? o.placement === "component" || (!supported(c) && o.placement === "excluded")
        : c.placement === "member"
          ? o.placement === "member" || o.placement === "component"
          : o.placement === "satellite" || o.placement === "excluded";
    if (!ok) misplaced++;
  }
  if (weighty.length) {
    rates.R1 = { hit: missing === 0 && misplaced === 0 ? 1 : 0, of: 1 };
    if (missing) mark("R1_missing");
    if (misplaced) mark("R1_misplaced");
  }

  // R2 and R3: per green, supported, tested component.
  for (const c of product) {
    if (!green || !supported(c) || !c.hasTests) continue;
    const o = seen.get(normPath(c.path));
    if (c.test.length) {
      rates.R2.of++;
      const accepted = new Set(c.test.map(normCommand));
      if (o?.testCommand && accepted.has(normCommand(o.testCommand))) rates.R2.hit++;
      else mark(o?.testCommand ? "R2_other_command" : "R2_no_command");
    }
    if (obs.environment === "container" && c.cleanPasses === "yes" && c.testsNeed === "nothing") {
      rates.R3.of++;
      if (!o) mark("R3_missing");
      else if (o.status === "proven" && o.level !== null && o.level >= 1) rates.R3.hit++;
      else if (o.level === 0) mark("R3_level_0");
      else mark(o.status === "undetermined" ? "R3_undetermined" : o.status === "not_assessed" ? "R3_not_assessed" : "R3_unproven");
    }
  }

  // R4: the next action, judged by the steward's two judges.
  if (opts.judged) {
    rates.R4 = { hit: opts.judged[0] && opts.judged[1] ? 1 : 0, of: 1 };
    if (!rates.R4.hit) mark("R4_rejected");
  }

  // R5: the container and disposable-VM runs agree, or the report says what differed.
  if (opts.vm) {
    const vm = new Map(opts.vm.components.map((c) => [normPath(c.path), c]));
    const agree = [...seen.entries()].every(([p, c]) => {
      const v = vm.get(p);
      return v !== undefined && v.level === c.level && v.status === c.status;
    });
    rates.R5 = { hit: agree || obs.statesDifference || opts.vm.statesDifference ? 1 : 0, of: 1 };
    if (!rates.R5.hit) mark("R5_disagree");
  }

  // R6: the unowned share is within the tolerance.
  if (truth.unownedShare !== null) {
    if (obs.unownedShare === null) {
      rates.R6 = { hit: 0, of: 1 };
      mark("R6_not_reported");
    } else {
      const ok = Math.abs(obs.unownedShare - truth.unownedShare) <= th.unownedTolerance + 1e-9;
      rates.R6 = { hit: ok ? 1 : 0, of: 1 };
      if (!ok) mark("R6_off");
    }
  }
  return { critical, rates, classes };
}

// The score a single development-set repo must meet: no critical event and no rate item missed.
export function repoShortfalls(s: RepoScore): FailureClass[] {
  return (Object.entries(s.classes) as [FailureClass, number][]).filter(([, n]) => n > 0).map(([c]) => c);
}

// Wilson score interval for k of n.
export function wilson(k: number, n: number, confidence = 0.95): { low: number; high: number } | null {
  if (n === 0) return null;
  const z = confidence === 0.95 ? 1.959963984540054 : confidence === 0.9 ? 1.6448536269514722 : 1.959963984540054;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { low: r(Math.max(0, centre - half)), high: r(Math.min(1, centre + half)) };
}

export interface RunTotals {
  environment: (typeof ENVIRONMENTS)[number];
  arm: (typeof ARMS)[number];
  repos: number;
  critical: Record<Critical, number>;
  rates: Record<Rate, { hit: number; of: number; rate: number | null; low: number | null; high: number | null }>;
  classes: Partial<Record<FailureClass, number>>;
}

export function totals(scores: RepoScore[], environment: RunTotals["environment"], arm: RunTotals["arm"], th: Thresholds = loadThresholds()): RunTotals {
  const critical = zeroCritical();
  const sum = zeroRates();
  const classes: Partial<Record<FailureClass, number>> = {};
  for (const s of scores) {
    for (const k of CRITICAL) critical[k] += s.critical[k];
    for (const r of RATES) {
      sum[r].hit += s.rates[r].hit;
      sum[r].of += s.rates[r].of;
    }
    for (const [c, n] of Object.entries(s.classes) as [FailureClass, number][]) classes[c] = (classes[c] ?? 0) + n;
  }
  const rates = Object.fromEntries(
    RATES.map((r) => {
      const { hit, of } = sum[r];
      const w = wilson(hit, of, th.interval.confidence);
      return [r, { hit, of, rate: of ? Math.round((hit / of) * 1000) / 1000 : null, low: w?.low ?? null, high: w?.high ?? null }];
    }),
  ) as RunTotals["rates"];
  return { environment, arm, repos: scores.length, critical, rates, classes };
}

// A test attempt passes with no critical event in any run, and every rate's point estimate at its
// bar in the runs that measure it: R3 in the container run, R5 in the paired runs, and the others in
// the scripted container run. A rate with nothing to count fails: abstaining can't pass.
export function verdict(runs: RunTotals[], th: Thresholds = loadThresholds()): { pass: boolean; failed: (Critical | Rate)[] } {
  const failed: (Critical | Rate)[] = [];
  for (const k of CRITICAL) if (runs.some((r) => r.critical[k] > 0)) failed.push(k);
  const main = runs.find((r) => r.environment === "container" && r.arm === "scripted");
  for (const r of RATES) {
    const t = main?.rates[r];
    if (!t || t.rate === null || t.rate < th.rates[r].bar) failed.push(r);
  }
  return { pass: failed.length === 0, failed };
}

export interface HoldoutRecord {
  schema: "agent-readiness/holdout-record@1";
  kind: "commitment" | "look";
  date: string;
  commitment: string;
  set?: "validation" | "test";
  attempt?: number;
  toolCommit?: string;
  digests?: { scripts: string; rubric: string; protocol: string };
  counts?: { repos: number; dropped: number; infraLost: number; swapped: number; collisions: number; tripwire: number };
  runs?: RunTotals[];
  verdict?: "PASS" | "FAIL" | null;
  failed?: (Critical | Rate)[];
}

// The keys of a record and of each of its parts; record.schema.json allows nothing else, and no
// field holds free text.
export function recordProblems(r: HoldoutRecord): string[] {
  const out: string[] = [];
  const hex = (s: unknown, n: number) => typeof s === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
  const only = (o: object | undefined, keys: string[], at: string) => {
    for (const k of Object.keys(o ?? {})) if (!keys.includes(k)) out.push(`${at}${k} isn't allowed`);
  };
  only(r, ["schema", "kind", "date", "commitment", "set", "attempt", "toolCommit", "digests", "counts", "runs", "verdict", "failed"], "");
  only(r.digests, ["scripts", "rubric", "protocol"], "digests.");
  only(r.counts, ["repos", "dropped", "infraLost", "swapped", "collisions", "tripwire"], "counts.");
  for (const n of Object.values(r.counts ?? {})) if (!Number.isInteger(n) || n < 0) out.push("counts hold whole numbers");
  for (const f of r.failed ?? []) if (!(CRITICAL as readonly string[]).includes(f) && !(RATES as readonly string[]).includes(f)) out.push(`failed ${f}`);
  if (r.verdict !== undefined && r.verdict !== null && r.verdict !== "PASS" && r.verdict !== "FAIL") out.push("verdict");
  for (const run of r.runs ?? []) {
    only(run, ["environment", "arm", "repos", "critical", "rates", "classes"], "runs[].");
    only(run.critical, [...CRITICAL], "runs[].critical.");
    only(run.rates, [...RATES], "runs[].rates.");
    for (const t of Object.values(run.rates ?? {})) only(t, ["hit", "of", "rate", "low", "high"], "runs[].rates[].");
  }
  if (r.schema !== "agent-readiness/holdout-record@1") out.push("schema");
  if (r.kind !== "commitment" && r.kind !== "look") out.push("kind");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) out.push("date");
  if (!hex(r.commitment, 64)) out.push("commitment");
  if (r.kind === "look") {
    if (r.set !== "validation" && r.set !== "test") out.push("set");
    if (!Number.isInteger(r.attempt) || (r.attempt ?? 0) < 1) out.push("attempt");
    if (!hex(r.toolCommit, 40)) out.push("toolCommit");
    if (!r.digests || !hex(r.digests.scripts, 16) || !hex(r.digests.rubric, 16) || !hex(r.digests.protocol, 64)) out.push("digests");
    if (!r.runs?.length) out.push("runs");
    for (const run of r.runs ?? []) {
      if (!ENVIRONMENTS.includes(run.environment) || !ARMS.includes(run.arm)) out.push("run environment or arm");
      for (const c of Object.keys(run.classes)) if (!(CLASSES as readonly string[]).includes(c)) out.push(`class ${c}`);
    }
    if (r.set === "validation" && r.verdict != null) out.push("a validation look has no verdict");
  }
  return out;
}

// Required fields and enumerations of truth.schema.json, checked without a schema library.
export function truthProblems(t: Truth): string[] {
  const out: string[] = [];
  const share = (x: unknown) => x === null || (typeof x === "number" && x >= 0 && x <= 1);
  if (t.schema !== "agent-readiness/holdout-truth@1") out.push("schema");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(t.repo ?? "")) out.push("repo");
  if (!/^[0-9a-f]{40}$/.test(t.commit ?? "")) out.push("commit");
  if (!CI_CONCLUSIONS.includes(t.ci?.conclusion)) out.push("ci.conclusion");
  if (!Array.isArray(t.components)) out.push("components");
  for (const [i, c] of (t.components ?? []).entries()) {
    const at = `components[${i}]`;
    if (typeof c.path !== "string" || normPath(c.path) !== c.path) out.push(`${at}.path`);
    if (!ECOSYSTEMS.includes(c.ecosystem)) out.push(`${at}.ecosystem`);
    if (!PLACEMENTS.includes(c.placement)) out.push(`${at}.placement`);
    if (!share(c.changeShare)) out.push(`${at}.changeShare`);
    if (typeof c.hasTests !== "boolean") out.push(`${at}.hasTests`);
    if (!Array.isArray(c.install) || !Array.isArray(c.test)) out.push(`${at}.install or test`);
    if (!TESTS_NEED.includes(c.testsNeed)) out.push(`${at}.testsNeed`);
    if (!CLEAN_PASSES.includes(c.cleanPasses)) out.push(`${at}.cleanPasses`);
  }
  if (!share(t.unownedShare)) out.push("unownedShare");
  if (!Array.isArray(t.secrets) || t.secrets.some((s) => typeof s.file !== "string" || typeof s.real !== "boolean")) out.push("secrets");
  if (!NEXT_ACTIONS.includes(t.nextAction?.kind)) out.push("nextAction.kind");
  if (!Number.isInteger(t.dropped) || t.dropped < 0) out.push("dropped");
  return out;
}

// node score.ts --truth <dir> --observations <dir> --set validation|test --attempt N --commitment <sha256>
//   --tool-commit <sha> --scripts <digest> --rubric <digest> --protocol <digest> [--judged <file>] [--counts <file>] --out <file>
// Truth files are <key>.json; observations are <key>.<environment>.<arm>.json, where key is the
// steward's salted hash of the repo. The record names no repo.
function main(argv: string[]): void {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const need = (name: string) => arg(name) ?? (process.stderr.write(`missing --${name}\n`), process.exit(2));
  const th = loadThresholds();
  const truthDir = need("truth");
  const obsDir = need("observations");
  const judged = arg("judged") ? (JSON.parse(readFileSync(arg("judged")!, "utf8")) as Record<string, [boolean, boolean]>) : {};
  const counts = arg("counts") ? JSON.parse(readFileSync(arg("counts")!, "utf8")) : { dropped: 0, infraLost: 0, swapped: 0, collisions: 0, tripwire: 0 };
  const keys = readdirSync(truthDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  const read = <T>(f: string): T | null => {
    try {
      return JSON.parse(readFileSync(join(obsDir, f), "utf8")) as T;
    } catch {
      return null;
    }
  };
  const groups = new Map<string, RepoScore[]>();
  for (const key of keys) {
    const truth = JSON.parse(readFileSync(join(truthDir, `${key}.json`), "utf8")) as Truth;
    const vm = read<Observation>(`${key}.disposable_vm.scripted.json`);
    for (const env of ENVIRONMENTS) {
      for (const arm of ARMS) {
        const obs = read<Observation>(`${key}.${env}.${arm}.json`);
        if (!obs) continue;
        const s = scoreRepo(truth, obs, { thresholds: th, vm: env === "container" && arm === "scripted" ? vm : null, judged: env === "container" && arm === "scripted" ? (judged[key] ?? null) : null });
        const g = `${env}.${arm}`;
        groups.set(g, [...(groups.get(g) ?? []), s]);
      }
    }
  }
  const runs = [...groups.entries()].map(([g, s]) => totals(s, g.split(".")[0] as RunTotals["environment"], g.split(".")[1] as RunTotals["arm"], th));
  const set = need("set") as "validation" | "test";
  const v = verdict(runs, th);
  const record: HoldoutRecord = {
    schema: "agent-readiness/holdout-record@1",
    kind: "look",
    date: new Date().toISOString().slice(0, 10),
    commitment: need("commitment"),
    set,
    attempt: Number(need("attempt")),
    toolCommit: need("tool-commit"),
    digests: { scripts: need("scripts"), rubric: need("rubric"), protocol: need("protocol") },
    counts: { repos: keys.length, ...counts },
    runs,
    verdict: set === "test" ? (v.pass ? "PASS" : "FAIL") : null,
    failed: set === "test" ? v.failed : [],
  };
  const problems = recordProblems(record);
  if (problems.length) {
    process.stderr.write(`the record doesn't match record.schema.json: ${problems.join(", ")}\n`);
    process.exit(1);
  }
  writeFileSync(need("out"), JSON.stringify(record, null, 2) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
