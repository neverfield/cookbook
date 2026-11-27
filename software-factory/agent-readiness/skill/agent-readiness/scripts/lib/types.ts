import type { ProofEnv } from "./proofenv.ts";
export type Strength = "asserted" | "static" | "executed" | "clean_replay" | "outcome_validated";
export type Tier = "read-only" | "local-exec" | "external-systems";
export type ScenarioId = "first_pr" | "bug_fixes" | "features" | "repo_wide";
export type SecretClass = "provider_token" | "private_key" | "url_credential" | "generic_assignment";

// An optional breakdown a user adds; reported nested under the components it names. "*" names
// every assessed component.
export interface ScenarioSpec {
  id: ScenarioId;
  components: string[];
}
export type CondId =
  | "clean.install"
  | "clean.build"
  | "clean.test"
  | "commands"
  | "faults"
  | "instructions"
  | "safety"
  | "toolchain"
  | "lockfile";
// blocked: a limit of this machine (a missing tool, no container runtime, a refused sudo) kept a
// deciding check from running. It never counts against the repo, and it never counts as met.
export type CondState = "met" | "not_met" | "unknown" | "blocked";
export type Level = 0 | 1 | 2 | 3 | 4;
export type CommandKind = "doctor" | "install" | "build" | "lint" | "typecheck" | "test" | "start";
export type Where = "static" | "host" | "fresh_copy" | "disposable_vm" | "container";
export type Result = "pass" | "fail" | "not_run";
// Every language a file in scripts/lib/languages/ can score. A component's language picks its
// language file; "other" is a component no language file scores.
export type Language = "ts" | "js" | "py" | "go" | "rust" | "java" | "kotlin" | "csharp" | "php" | "ruby" | "other";
// Every ecosystem a language file defines a frozen install for (scripts/lib/languages/).
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "pip" | "uv" | "poetry" | "go" | "cargo" | "maven" | "gradle" | "nuget" | "composer" | "bundler";
export type Effort = "small" | "medium" | "large";

export interface ImageRun {
  image: string;
  digest?: string;
  // "*" for the repo-wide commands, then the component ids that ran here.
  components: string[];
  started: boolean;
  // Why nothing ran in this image, when its container didn't start.
  notRun?: string;
}

export interface Component {
  id: string;
  path: string;
  language: Language;
  manifest: string | null;
  scripts: Record<string, string>;
  changes: number;
  changeShare: number;
  assessed: boolean;
  notAssessedReason?: string;
  packageManager?: PackageManager | null;
  toolchain?: string;
  lockfile?: string | null;
  // The entry in scripts/lib/support.ts this component falls under.
  stack?: string;
  // Files under the component, and no other component, that match its language's test-file rule.
  // Unset when the scan didn't count them.
  testFiles?: number;
}

export interface Profile {
  repoType: "single" | "monorepo";
  packageManager: PackageManager | null;
  manifests: string[];
  lockfiles: string[];
  ciFiles: string[];
  instructionFiles: string[];
  toolchain: { pinned: boolean; files: string[]; missing: string[] };
  environmentJson: { path: string; install?: string; start?: string; build?: { dockerfile: string; context?: string } } | null;
  components: Component[];
  // Nested manifests deferred as tests, samples or tooling; never components while the repo has others.
  // changeShare is the satellite's own share, of changes no component holds.
  satellites: { path: string; manifest: string | null; toolchain: string; reason: string; changeShare?: number }[];
  // Workspace members built and tested only through another component's commands, such as packages
  // with no test script of their own that the workspace root's test runner covers.
  members?: { path: string; manifest: string; of: string; reason: string }[];
  // Every folder that holds a manifest, and where it was placed, so nothing found is dropped.
  units?: Unit[];
  // Every counted change in the window, and the share no component or satellite holds.
  ownership?: { changes: number; unowned: number; unownedShare: number; unownedTop: string[]; counted: boolean };
  historyDays: number;
  totalChanges: number;
  scope?: ScanScope;
}

export interface Unit {
  path: string;
  manifest: string;
  placement: "component" | "member" | "satellite" | "excluded" | "unplaced";
  // For a member or satellite, the component it belongs to, when it has one.
  of?: string;
  // What placed it: the repo's workspace declaration, the manifest itself, or a folder-name hint.
  source: "workspace" | "manifest" | "hint";
  reason: string;
}

// What the scan read. On a large repo the listing stops at a file cap, and the secret scan and the
// agent assets' git history stop at the scan's time bound; the report states what was sampled.
export interface ScanScope {
  boundMinutes: number;
  files: number;
  fileCap: number | null;
  secrets: { scanned: number; total: number };
  assetHistory: { read: number; total: number };
}

export interface ScanBound {
  until: number;
  scope: ScanScope;
}

export interface ContractCommand {
  id: string;
  kind: CommandKind;
  component: string;
  cwd: string;
  command: string;
  source: string;
  reason: string;
  timeoutSec: number;
  // Runs only when this machine blocks the named command, as a frozen install behind a declared one.
  fallbackFor?: string;
  // The command as the repo declares it, when the audit runs a check-only form without its write flags.
  declared?: string;
  // Where the command came from, most authoritative first: a command added with `contract add`, a CI
  // workflow's run step, the repo's environment file, a task runner, the manifest's scripts, or the
  // language's convention. confidence: declared by the repo, derived from what it declares, or guessed.
  tier?: CommandTier;
  confidence?: "declared" | "derived" | "guessed";
  // Literal variables the repo's CI workflow sets for the step that runs this command's script.
  env?: Record<string, string>;
}

export type CommandTier = "override" | "ci" | "environment" | "task_runner" | "manifest" | "convention";

// Whose failure a failed step is. repo: an experiment showed it, or the step ran in an environment
// whose self-check passed and failed on its own terms. environment: a limit of the audit's machine or
// of a choice the audit made. undetermined: the audit can't tell, and says what would settle it.
export interface Attribution {
  verdict: "repo" | "environment" | "undetermined";
  basis: "experiment" | "canary" | "known_cause";
  // For an experiment, what the rerun changed.
  changed?: "network" | "image" | "tool";
  detail: string;
}

export interface Evidence {
  id: string;
  checkId: string;
  condition?: CondId;
  component?: string;
  kind?: CommandKind;
  contractId?: string;
  strength: Strength;
  where: Where;
  result: Result;
  command?: string;
  cwd?: string;
  image?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  outputTail?: string;
  outputDigest?: string;
  summary: string;
  diagnosis?: Diagnosis;
  blocked?: string;
  // The flag that skipped this step on purpose, such as --no-mutants.
  skipped?: string;
  // For a fault check, the planted faults the tests missed; the seal names where they were.
  missedFaults?: string[];
  // For a repo-wide command that failed, the components every failing file belongs to, when the
  // output names them all. The other components aren't failed by it.
  failedIn?: string[];
  // A type-check canary: the known type error planted in `file`. exempt: the component's tests import
  // no file of a language with a canary, so its type-check counts on its exit code alone.
  canary?: { kind: "typecheck"; file: string | null; line?: string; exempt?: boolean };
  // The planted-fault estimate behind a faults result, from 2026-12-beta.
  estimate?: FaultEstimate;
  // Whose failure this is, for a failed step (lib/attribute.ts).
  attribution?: Attribution;
  // "on": the step ran with the network on, as the rerun of a test that failed with it cut.
  network?: "on";
  // The later row that is the current result for the same check, component and command.
  supersededBy?: string;
  at: string;
}

export interface Diagnosis {
  // missing_ref: a git ref or remote the audit's single-commit clean copy doesn't have, such as origin/main.
  // interactive: the command stopped at a prompt that wants a person's answer.
  // missing_library: a shared system library the code loads isn't in the image.
  // resource: the command ran out of memory or disk, a limit of this machine or the audit's container.
  cause: "service" | "credential" | "registry" | "missing_tool" | "missing_module" | "missing_library" | "network" | "permission" | "timeout" | "compile" | "missing_ref" | "interactive" | "resource" | "unknown";
  // For a resource limit: which one the command ran into.
  limit?: "memory" | "disk";
  detail: string;
  // For a refused connection, the service usually on that port. It names the service in report text
  // only when serviceNamed says the output named it; otherwise it only guides remediation drafts.
  service?: string;
  serviceNamed?: boolean;
  // The detail is the tool's own root error (Maven's failed goal, Gradle's "What went wrong",
  // Composer's problem, PHPStan's first error, Ruby's uncaught error), not a guessed last line, so
  // report text may quote it as the cause.
  fromTool?: boolean;
}

// A secret-shaped value the seal masked in the repo's own text: its pattern and where it came from.
export interface MaskedValue {
  type: string;
  where: string;
}

export interface InstructionItem {
  id: string;
  source: string;
  line: number;
  kind: "command" | "path";
  text: string;
  // skipped: from a vendored skill, or a placeholder, interactive or package-adding command; never run.
  category: "replay" | "install" | "long_running" | "risky" | "needs_access" | "path" | "skipped";
  staticResult: Result;
  staticReason?: string;
  result: Result;
  reason?: string;
  blocked?: string;
  evidenceId?: string;
  // The folder a command runs in: the package that owns the instruction file, or the repo root.
  cwd?: string;
  // The id of the rule in INSTRUCTION_RULES (static.ts) that produced the result.
  rule?: string;
  waived?: AppliedWaiver;
}

export interface SafetyFinding {
  id: string;
  kind: "secret" | "lifecycle_hook" | "network_piped" | "destructive" | "deploy_publish" | "credential_needed" | "elevated" | "host_mode";
  file: string;
  line?: number;
  detail: string;
  blocking: boolean;
  // The id of the rule in SAFETY_RULES (static.ts) that decided whether it blocks.
  rule?: string;
  // For a secret: its class in secrets.ts, which decides whether it can block and what advice it gets.
  secretClass?: SecretClass;
  waived?: AppliedWaiver;
}

// A finding a committed waiver file treats as a false positive. The finding keeps what it was, so
// the report can show it next to the waiver's reason.
export interface AppliedWaiver {
  waiver: string;
  reason: string;
  by: string;
  was: string;
}

export interface WaiverEntry {
  id: string;
  check: string;
  match: string;
  reason: string;
  by: string;
  expires?: string;
}

// The waiver file as read from the audited commit, the waivers that apply, and the ones refused.
export interface WaiverRecord {
  file: string;
  digest: string | null;
  entries: WaiverEntry[];
  rejected: { id: string; reason: string }[];
  ignored: string | null;
}

// Where a fault was planted stays outside the repository until the seal: the draft holds only
// each fault's result, so nothing in the working tree says which lines the tests were checked on.
// The planted-fault estimate (mutate.ts faultEstimate): low and high are the rule's one-sided Wilson
// bounds on the share of faults the tests catch.
export interface FaultEstimate {
  planted: number;
  decided: number;
  caught: number;
  rate: number;
  low: number;
  high: number;
  verdict: "strong" | "weak" | "inconclusive";
  // Faults an earlier sealed audit planted that this one planted again.
  carried: number;
}

export interface Mutant {
  id: string;
  component: string;
  file?: string;
  line?: number;
  operator?: string;
  before?: string;
  after?: string;
  result: "caught" | "survived" | "discarded" | "not_run";
  exitCodes: number[];
  // mutate.ts faultId(): kept with the site details, so it is revealed only at the seal.
  faultId?: string;
}

export interface Asset {
  kind: "agents_md" | "skill" | "rules" | "hooks" | "environment" | "mcp" | "instructions";
  path: string;
  authors: { name: string; commits: number }[];
  lastChanged: string | null;
  status: string;
  ok: boolean;
  frontmatterOk?: boolean;
  // Set when an environment config needs sudo, which a clean container setup must not.
  elevated?: string;
  // Set for a verify-<app> skill: how many features its feature map lists.
  features?: number;
}

export interface PrRecord {
  number: number;
  headRefName: string;
  author: string;
  labels: string[];
  createdAt: string;
  mergedAt: string | null;
  state: string;
  files: string[];
  firstCheck: "success" | "failure" | null;
  changesRequested: boolean;
  coAuthors?: string[];
  // GitHub listed more changed files than it returns, so the PR isn't attributed to components.
  filesIncomplete?: boolean;
  title?: string;
  // When the first revert of this PR landed, null when none was found, and absent when reverts
  // weren't looked for. revertedBy names it: "#245" or "commit 1a2b3c4".
  revertedAt?: string | null;
  revertedBy?: string;
}

export interface OutcomeStats {
  opened: number;
  merged: number;
  firstTimeCiPass: number;
  firstTimeCiKnown: number;
  changesRequested: number;
  medianDaysToMerge: number | null;
  addingPaths: Record<string, number>;
  mergedByActivity: Record<string, number>;
  // Merged PRs reverted within the rubric's revertDays, out of the merged PRs reverts were looked for
  // in. Absent under rubrics without revertDays, and in history lines written before them.
  reverted?: number;
  revertKnown?: number;
}

export interface RevertsSnapshot {
  days: number;
  // The merged agent PRs reverted within `days`, and what reverted each.
  agent: { number: number; by: string }[];
  // Merged agent PRs younger than `days` at the end of the window, which had less time to be reverted.
  mergedRecently: number;
  // Why reverts couldn't be looked for, when they couldn't.
  unavailable?: string;
  // What the search stopped short of, when it read only part of the revert PRs or commits.
  limited?: string;
}

export interface OutcomesSnapshot {
  source: "gh" | "file";
  window: { from: string; to: string; days: number };
  filter: { branchPrefixes: string[]; labels: string[]; authors: string[]; coAuthorTrailers: string[] };
  agent: OutcomeStats;
  control: OutcomeStats;
  byComponent: Record<string, OutcomeStats>;
  matchedAgentPrs: number[];
  multiComponentPrs: number;
  // gh returned as many PRs as it was asked for, so the window may hold more than were read.
  truncated?: boolean;
  // Agent PRs left out of byComponent because their file list was incomplete.
  filesIncomplete?: number;
  reverts?: RevertsSnapshot;
}

export interface AuditSkillInfo {
  version: string;
  scriptsDigest: string;
  rubricDigest: string;
  release: string | null;
}

export interface Audit {
  schema: "agent-readiness/audit@1";
  id: string;
  kind: "audit";
  createdAt: string;
  state: "draft" | "sealed";
  // shallow: the audited clone is shallow, so change shares come from the commits it has.
  // submodulesMissing and lfsPointers: what the audit tree lacks that a full CI checkout would have.
  repo: { name: string; commit: string; dirtyTree: boolean; shallow?: boolean; submodulesMissing?: string[]; lfsPointers?: number };
  scenarios: ScenarioSpec[];
  tier: Tier;
  rubric: string;
  skill: AuditSkillInfo;
  seed: { value: string; pinned: boolean };
  // tools: what the audit added to its own image for the frozen install, such as bun@1.2.19, and whether it could.
  environment: {
    containerRuntime: string | null;
    image: string | null;
    imageOverride?: string;
    registryEnv: string[];
    inheritEnv: boolean;
    tools?: { spec: string; added: boolean }[];
    // Toolchains copied in from another pinned image beside the image's own, such as a second JDK a
    // Gradle toolchain asks for, why, and whether it could be.
    toolchains?: { spec: string; image: string; reason: string; added: boolean }[];
    // The digest the audit's image was pulled at, when the audit pins it.
    imageDigest?: string;
    // The container's CPU, memory and process limits.
    limits?: { cpus: number | null; memoryMb: number; pids: number };
    // The user allowed repo commands to run on this machine, outside a container.
    hostMode?: boolean;
    // The user's yes to that, as `readiness allow-host --note` recorded it; null when none was.
    hostConsent?: { note: string; at: string } | null;
    // Where the replay's results were proved, and the canary that checked that environment first.
    proofEnv?: ProofEnv;
    // Why no repo command ran: no container runtime, or a container that didn't start, and host mode not allowed.
    notRun?: string;
    // One entry per image the replay used, the repo's first. A mixed-language repo runs each
    // component in its own toolchain's image; `image` above is the first entry's.
    images?: ImageRun[];
    // Images where the ordinary user has no /etc/passwd line and the audit couldn't add one, with
    // the uid, so a tool that looks up its user and fails there is explained.
    userEntryMissing?: { uid: string; images: string[] };
  };
  profile: Profile | null;
  assets: Asset[];
  contract: ContractCommand[];
  instructions: InstructionItem[];
  safety: SafetyFinding[];
  evidence: Evidence[];
  mutants: Mutant[];
  outcomes: OutcomesSnapshot | null;
  narration: Narration | null;
  signals?: Signal[];
  // Read by the scan from the audited commit's waiver file; sealed with the rest of the audit.
  waivers?: WaiverRecord;
  // Secret-shaped values in the repo's own text that the seal masked as [redacted:<type>].
  masked?: MaskedValue[];
  sealed?: { at: string; digest: string; reportJsonDigest: string; reportMdDigest: string; reportHtmlDigest?: string; roadmapItemsDigest?: string; historyLineDigest?: string; keyed?: boolean };
}

// found is null when the signal doesn't apply, for example no AGENTS.md to measure.
export interface Signal {
  id: "ci" | "targeted_tests" | "env_sample" | "isolation" | "agents_md_length" | "drive_app";
  label: string;
  found: boolean | null;
  detail: string;
  // drive_app: the assessed components with an app to run and no way found to drive it, and what
  // says there is an app. The roadmap's drive step reads it.
  undriven?: { id: string; surface: string }[];
}

// The agent's narration is a choice of ids from the report model; templates write the words.
// lead: the component the headline names first, one of the components that set the level.
// cause: the condition and evidence row the headline gives as the cause, for the lead.
// works: passing evidence rows the headline names as already working.
// ask: the roadmap item part 1's decision is about, or "settle" for what settles the level.
export interface Narration {
  lead?: string;
  cause?: { condition: CondId; evidence: string } | null;
  works?: string[];
  ask?: string;
}

export interface Watch {
  metric: string;
  scope: string;
  baseline: string;
  n: number | null;
  window: string | null;
}

export interface Fix {
  condition: CondId;
  component: string;
}

export type RoadmapStatus = "done" | "in_progress" | "next" | "start_now" | "waiting" | "later";

export interface RoadmapItem {
  id: string;
  order: number;
  kind: "fix" | "decision" | "rollout";
  template: string;
  title: string;
  status: RoadmapStatus;
  fixes: Fix[];
  unlocks: string;
  impact: number;
  effort: Effort;
  size: string;
  ownerRole: string;
  decision: string | null;
  dependsOn: string[];
  why: string;
  doneWhen: string;
  steps: { title: string; detail: string }[];
  expected: { outcome: string; watch: Watch };
  evidence: string[];
  createdAt: string;
  createdBy: string;
  closedAt: string | null;
  closedBy: string | null;
  observed: { value: string; sharedWith: string[] } | null;
}

export interface Targets {
  mergeRate: number;
  firstPass: number;
  maxChangesRequested: number;
  minAgentPrs: number;
}

export interface Roadmap {
  schema: "agent-readiness/roadmap@1";
  owner: string | null;
  targets: Targets | null;
  items: RoadmapItem[];
  updatedBy: string;
  updatedAt: string;
}

export interface HistoryLine {
  id: string;
  kind: "audit" | "recheck";
  date: string;
  commit: string;
  rubric: string;
  scriptsDigest: string;
  result: "sealed" | "passed" | "failed" | "blocked";
  note?: string;
  // Each assessed component's standard level, and the repo rollup over the active ones.
  levels: Record<string, Level>;
  repoLevel: Level;
  // Only the scenarios a user added, under the components they apply to.
  scenarioLevels: Record<string, Partial<Record<ScenarioId, Level>>>;
  noLevel?: boolean;
  // Level 1 was unproven on this machine: every Level 1 condition left was blocked here and none failed.
  unproven?: boolean;
  // Level 1 was undetermined: none failed for a reason in the repo, and the audit couldn't tell the rest.
  undetermined?: boolean;
  shares: Record<string, number>;
  active: string[];
  outcomes?: { window: string; agent: OutcomeStats; control: OutcomeStats; byComponent: Record<string, OutcomeStats>; source?: "gh" | "file" } | null;
  seedPinned: boolean;
}

export interface RateValue {
  count: number;
  n: number;
  rate: number | null;
  window: string;
}

export interface ReportJson {
  schema: "agent-readiness/report@1";
  repo: string;
  // The skill's Preview label (lib/preview.ts), shown at the top of every view; absent from 1.0.
  preview?: string;
  audit: {
    id: string;
    date: string;
    commit: string;
    dirtyTree: boolean;
    rubric: string;
    tier: Tier;
    scriptsDigest: string;
    seedPinned: boolean;
    sealStatus: string;
    staleCopy: string | null;
    previous: string | null;
    storedAt: string;
    // unsigned: an unkeyed digest that shows edits but not who sealed it. keyed: an HMAC only the
    // holder of SA_READINESS_SEAL_KEY can produce.
    integrity?: "unsigned" | "keyed";
  };
  scale: { level: Level; name: string; plain: string; meaning: string; measuredBy: string }[];
  // What the audit took as given, shown on the first screen.
  assumptions?: ReportAssumptions;
  scenarios: { id: ScenarioId; label: string; components: string[] }[];
  // Tier 1: the repo rollup.
  maturity: {
    level: Level;
    rule: string;
    couldBe: Level | null;
    couldBeReason: string | null;
    setBy: string[];
    partialCoverage: boolean;
    assessedComponents: number;
    // proven: the level rests on checks that ran. blocked: a limit of this machine stopped the
    // checks that decide the next level. not_assessed: no component could be assessed.
    outcome: "proven" | "blocked" | "not_assessed";
    // Separate from the level and never raises it.
    confidence: { level: "high" | "medium" | "low"; reasons: string[] };
    // What holds the level where it is: each condition of the next level that isn't met.
    capReasons: CapReason[];
    // True when the level is 0 only because this machine couldn't check Level 1.
    unproven: boolean;
    status: LevelStatus;
    provenIn: ProofEnvKind | null;
    settleBy: SettleBy | null;
    next: { level: Level; name: string; met: string[]; unmet: string[] } | null;
  };
  // Tier 2: each component found, with tier 3, the scenarios added for it, nested under it.
  components: {
    // sampled_monorepo: some supported components were left out because only the most active are assessed.
    shape: "single" | "monorepo" | "sampled_monorepo";
    included: ComponentLevel[];
    // placement: a component this audit doesn't assess, a satellite of one, or a manifest the scan
    // couldn't place.
    excluded: { id: string; path: string; toolchain: string; manifest: string | null; lockfile: string | null; changeShare: number; placement?: "component" | "satellite" | "unplaced"; reason: string }[];
    // The share of recent changes that lie in no component or satellite, and the folders holding most.
    unownedShare?: number;
    unownedTop?: string[];
  };
  executive: {
    heading: string;
    headline: string;
    numbers: { label: string; value: string; comparison: string }[];
    nextLine: string;
    gaps: { rank: number; text: string; blocks: string; itemId: string }[];
    ask: string;
    coverage: string;
    noBlocker: boolean;
    // What the level doesn't cover, and the support list when a stack isn't supported yet.
    unassessed: { share: number; text: string; supportDoc: string | null } | null;
  };
  actions: ReportAction[];
  // Page 1 notices, each phrased as what the reader should do. Provenance and eval-mode notes that
  // need no action live in the report's "About this report" section instead.
  notices?: { text: string }[];
  // y is the plotted impact; impact is the share of recent changes the action unblocks.
  matrix: { quadrants: string[]; points: { label: string; x: number; y: number; impact?: number; quadrant?: string; itemId: string }[] };
  roadmap: { owner: string | null; doneCount: number; total: number; items: ReportRoadmapItem[] };
  progress: ReportProgress | null;
  details: ReportDetails;
  // How each result was reached: every level, unproven or not-assessed result and every finding.
  explanations?: Explanation[];
  waivers?: ReportWaivers | null;
}

export interface ReportAssumptions {
  components: { id: string; path: string; manifest: string | null; assessed: boolean; note: string | null }[];
  commands: { component: string; kind: CommandKind; command: string; cwd: string; source: string; reason: string }[];
  environment: { kind: "container" | "disposable_vm" | "fresh_copy" | "none"; text: string };
  toolchains: { where: string; command: string; versions: string }[];
}

export interface Explanation {
  kind: "level" | "condition" | "not_assessed" | "instruction" | "safety";
  subject: string;
  result: string;
  ran: string;
  where: string;
  happened: string;
  rule: string;
}

export interface ReportWaivers {
  file: string;
  digest: string | null;
  ignored: string | null;
  applied: { id: string; check: string; match: string; reason: string; by: string; findings: number }[];
  unused: { id: string; match: string }[];
  rejected: { id: string; reason: string }[];
}

export type LevelStatus = "proven" | "unproven" | "undetermined" | "not_assessed";

// What settles an unproven or undetermined level: a rerun on another machine, a command the repo
// runs its tests with, a fix to the component map, or a declared environment.
export interface SettleBy {
  kind: "rerun" | "add_command" | "fix_map" | "declare_env";
  text: string;
}

export interface CapReason {
  component: string;
  condition: string;
  label: string;
  state: CondState;
  reason: string;
}

export type ProofEnvKind = "container" | "disposable_vm" | "host";

// level is null when the audit has no real results to give one from, or the component's Level 1 is
// undetermined.
export interface ComponentLevel {
  id: string;
  path: string;
  toolchain: string;
  manifest: string | null;
  lockfile: string | null;
  changeShare: number;
  placement?: "component";
  active: boolean;
  level: Level | null;
  couldBe: Level | null;
  unproven: boolean;
  status: LevelStatus;
  provenIn: ProofEnvKind | null;
  settleBy: SettleBy | null;
  capReasons: CapReason[];
  scenarios: { id: ScenarioId; label: string; level: Level | null; couldBe: Level | null; unproven: boolean }[];
}

export interface ReportAction {
  rank: number;
  itemId: string;
  title: string;
  startNow: boolean;
  why: string;
  movesTheNeedle: string;
  watch: string;
  research: string | null;
  effortAndOwner: string;
  decision: string | null;
  doneWhen: string;
  dependsOn: string[];
  impact: number;
  effort: Effort;
  // The evidence rows the roadmap item was raised from.
  evidence?: string[];
}

export interface ReportRoadmapItem {
  id: string;
  order: number;
  title: string;
  status: RoadmapStatus;
  statusText: string;
  unlocks: string;
  decision: string | null;
  // The level of the scale this step is part of reaching; null for steps that serve every level.
  level?: Level | null;
}

// What changed against the audit before this one, from its sealed report.
export interface ReportChanges {
  since: { audit: string; date: string };
  repo: { from: Level | null; to: Level | null };
  components: { id: string; from: Level | null; to: Level | null }[];
  // Conditions that held a component's level last time and don't now, and the reverse for a level the component had reached.
  nowMet: { component: string; label: string }[];
  nowFailing: { component: string; label: string; reason: string }[];
  // Checks whose result flipped between a pass and a failure.
  checks: { id: string; name: string; from: boolean | null; to: boolean | null }[];
}

export interface ReportProgress {
  history: { date: string; kind: string; result: string; note: string | null; levels: Record<string, Level | null>; repoLevel: Level | null; rubric: string }[];
  closed: { title: string; closed: string; expected: string; observed: string }[];
  weakening: string | null;
  rubricChanges: { date: string; from: string; to: string }[];
  // Null when the previous audit's sealed report isn't readable here.
  changes?: ReportChanges | null;
}

export interface ReportDetails {
  steps: { itemId: string; title: string; steps: { title: string; detail: string }[] }[];
  checks: { id: string; name: string; why: string; sources: { claim: string; caveat: string; url: string }[]; result: string; ok: boolean | null; counts: { passed: number; failed: number; notRun: number; skipped?: number }; evidence: string[] }[];
  notAssessed: string[];
  levelRules: { level1: string; level2: string; scenarios: { id: ScenarioId; label: string; bar: string }[] };
  outcomes: {
    window: string;
    filter: string;
    source: string;
    // reverted is absent under rubrics that don't report reverts, and null for a window measured without them.
    series: { label: string; opened: number; merged: RateValue; firstTimeCi: RateValue; changesRequested: RateValue; medianDaysToMerge: number | null; reverted?: RateValue | null }[];
    byComponent: { component: string; prs: number; firstTimeCi: RateValue; changesRequested: RateValue }[];
    multiComponentNote: string;
    matchedPrs: number[];
    caveat: string;
    // How reverts were found and which agent PRs were reverted; absent under rubrics that don't report them.
    reverts?: { days: number; note: string; agent: { number: number; by: string }[] };
  } | null;
  assets: { kind: string; path: string; authors: string[]; lastChanged: string | null; status: string; ok: boolean }[];
  missingAssets: string[];
  signals: Signal[];
  // Every row, current or not; supersededBy names the row that is now the result for the same check,
  // component and command. repro reruns the step from a clean checkout, or is null when nothing ran.
  evidence: { id: string; check: string; component: string | null; ran: string; where: string; result: string; summary: string; durationMs?: number | null; repro?: string | null; supersededBy?: string | null }[];
  record: { label: string; value: string }[];
}
