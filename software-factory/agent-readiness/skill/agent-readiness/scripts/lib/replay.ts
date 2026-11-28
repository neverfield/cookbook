import { cpSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { ContainerSession, HOME_DIR, buildImage, detectRuntime, hostUser, probeLimits, removeOrphanedContainers } from "./container.ts";
import { hooked, imagePlan, toolchainCopies, toolSetup } from "./contract.ts";
import { ALLOW_HOST_ENV } from "./guard.ts";
import { BUNDLE_GAP, diagnose, rootError, testCounts } from "./diagnose.ts";
import { addEvidence, registryValuesOf } from "./evidence.ts";
import { attribute, networkVerdict, rerunsOnline } from "./attribute.ts";
import type { AttributionInput } from "./attribute.ts";
import { fmtDuration } from "./format.ts";
import { digestOf } from "./images.ts";
import { replayInstructions } from "./instructions.ts";
import { ecosystemOf } from "./languages/index.ts";
import { lockedEngineGap } from "./languages/node.ts";
import { TYPE_CANARIES, applySite, atLook, carriedCap, chooseSites, estimateRule, faultEstimate, faultId, faultsVerdict, keepPlanting, killRateOf, scopedCommand, testsReaching, typeCanarySite, withCanary, withControlComment } from "./mutate.ts";
import { Progress, budgetSummary } from "./progress.ts";
import { redact, tail } from "./redact.ts";
import type { Rubric } from "./rubric.ts";
import { SUDO_SHIM_MARK, disposeHome, endGroups, runCommand, scrubbedEnv } from "./run.ts";
import type { RunOutcome } from "./run.ts";
import type { Attribution, Audit, CommandKind, CondId, Component, ContractCommand, Diagnosis, Evidence, ImageRun, Language, Mutant, Profile, Strength, Where } from "./types.ts";
import { onTeardown, removeOrphanedTempDirs, tempDir } from "./teardown.ts";
import type { TempDir } from "./teardown.ts";
import { assertFreeSpace, containedPath, exists, fail, treeBytes, listFiles, randomHex, readJson, readText, sha256, shellQuote, writeJson } from "./util.ts";
import { commandsFor } from "./score.ts";
import { BUDGET_OUT, CUT_OFF } from "./scope.ts";
import { makeRecipe } from "./static.ts";
import { SUPPORTED_DOC, notSupportedReason } from "./support.ts";
import { loadSealedAudit, readHistory } from "./history.ts";
import { paths, plantSeed, refreshTree } from "./workspace.ts";
import { GIT_IDENTITY_CONFIG, canCutNetwork, canaryFailure, detectDisposableVm, normalizedEnv, offlineCommand, provesIn, runCanary, vmNotDetectedNote } from "./proofenv.ts";
import type { Canary, ProofEnv, VmDetection } from "./proofenv.ts";
import { loadRubric } from "./rubric.ts";
import { lease } from "./session.ts";

export interface Executor {
  where: Where;
  strength: Strength;
  image: string | null;
  // Who picked the image: a tool missing from one the repo declared is the repo's to add.
  imageSource: "audit" | "override" | "repo" | null;
  root: string;
  // imageUser: the repo's declared setup, run as its image's own user rather than an ordinary one.
  // registry: a setup step (the doctor or an install), the only commands the registry variables reach.
  // env: variables the command runs with, such as the literal ones a CI workflow sets for it.
  exec(command: string, cwd: string, timeoutSec: number, opts?: { imageUser?: boolean; registry?: boolean; env?: Record<string, string> }): Promise<RunOutcome>;
  offline(): boolean;
  // Turns the network back on after offline(), for one experiment; false when it can't.
  online?(): boolean;
  // Adds a tool the image the audit picked lacks, with the network on; false when it can't.
  addTool?(tool: string): boolean;
  // Whether the last offline() call cut the network; null before it runs and on the host.
  networkOff: boolean | null;
  close(): void;
  // Set when nothing may run here, with the reason: every command is recorded as not run, blocked by it.
  unavailable?: string;
  // exec without the ban on rerunning a command line that timed out: a run with a planted fault is
  // different code, even when the command line is the same.
  execFresh?: Executor["exec"];
  // The uid the repo's commands should run as, for the canary; null when it's the image's own user.
  runUser?: string | null;
}

export const RAN_OUT_BEFORE = "not run again: this command line timed out earlier in this audit";

// A command line that timed out once is never run again in the same audit, on any executor, so a
// server or a stalled install can't spend its timeout over and over. The repeat returns at once,
// as timed out, with the reason in its output.
export function banRepeats(ex: Executor, timedOut: Set<string>): Executor {
  if (ex.execFresh) return ex;
  const raw = ex.exec;
  ex.execFresh = raw;
  ex.exec = async (command, cwd, timeoutSec, opts) => {
    const key = `${cwd}\u0000${command}`;
    if (timedOut.has(key)) return { exitCode: null, timedOut: true, durationMs: 0, output: `readiness: ${RAN_OUT_BEFORE}` };
    const out = await raw(command, cwd, timeoutSec, opts);
    if (out.timedOut) timedOut.add(key);
    return out;
  };
  return ex;
}

export const SUDO = /(^|[\s;&|(`]|\$\()sudo(\s|$)/;
export const SUDO_REFUSED = "not run on the host: it uses sudo, which the audit only runs inside a container";
export const NETWORK_ON = "the network couldn't be switched off for the test phase, so this pass doesn't prove a clean checkout";
export const NEEDS_NETWORK = "the tests pass only with the network on, and it couldn't be switched back on to plant faults";

export { registryValuesOf };

// Host mode: the repo's commands run on this machine instead of in a container. Only on the user's
// explicit yes (`--allow-host`, which sets this variable), never as a fallback.
export { ALLOW_HOST_ENV };

export function hostAllowed(explicit?: boolean): boolean {
  return explicit ?? process.env[ALLOW_HOST_ENV] === "1";
}

// The user's yes to host mode, as the session holds it, copied into the audit: the seal deletes the
// session, and the report has to show whether anyone was asked. Null when host mode ran on the flag
// alone. Untouched when nothing ran on the host.
export function recordHostConsent(audit: Audit, repo: string): void {
  if (!audit.environment.hostMode && !audit.evidence.some((e) => e.where === "host")) return;
  const l = lease(repo);
  const grant = l.valid ? l.session?.grant : null;
  audit.environment.hostConsent = grant ? { note: redact(grant.note).slice(0, 300), at: grant.at } : null;
}

export const HOST_NOT_ALLOWED = `host mode wasn't allowed (--allow-host), so no repo command ran outside a container`;

// Why no runtime was found. With --runtime none (or SA_READINESS_RUNTIME=none) a runtime may well be
// installed, so the reason says the audit turned it off: an agent that sees `docker info` succeed
// then has no contradiction to probe with a container of its own.
export function noRuntimeReason(preference: string): string {
  if (preference === "none") return "no container runtime: this audit was run with container runtimes turned off (--runtime none or SA_READINESS_RUNTIME=none)";
  return `no container runtime on this machine: ${preference === "auto" ? "docker info" : `${preference} info`} didn't answer`;
}
export const HOST_MODE_NOTE = "host mode was allowed: the repo's commands ran on this machine as this user, outside a container, with a throwaway home and no account credentials, but they could read this user's local files; it isn't a sandbox, and Level 1 can't be proved there";
export function vmModeNote(vm: VmDetection): string {
  return `host mode was allowed on ${vm.label}, detected by ${vm.signals.join(" and ")}: the repo's commands ran on that machine as its user, outside a container, with a throwaway home and no account credentials; they could read its local files, which a disposable VM holds only for this run, and the secrets injected into it. A pass there proves the VM as provisioned, including its preinstalled tools and running services, which a clean container may not have`;
}

// Linux, macOS and cloud agents. The audit drives its container through bash on the host and its
// host mode runs bash, joins PATH with ":" and writes bash shims, none of which native Windows has.
export function assertPlatformSupported(platform: string = process.platform): void {
  if (platform === "win32") fail(`The audit doesn't run on native Windows: ${notSupportedReason("windows")}. See ${SUPPORTED_DOC} in the skill.`);
}

// A path from .cursor/environment.json, refused when it leaves the audited tree.
export function insideTree(root: string, ...parts: string[]): string {
  return containedPath(root, parts, ".cursor/environment.json");
}

export const assertHostFallbackSupported = assertPlatformSupported;

// allowHost: the user's yes for this run; without it the opt-in variable decides. Refused otherwise,
// so `readiness run` needs the same yes as a replay in host mode.
export function hostExecutor(root: string, registryEnv: string[], inheritEnv: boolean, where: Where = "fresh_copy", allowHost?: boolean): Executor {
  assertPlatformSupported();
  if (!hostAllowed(allowHost)) fail(`This runs the repo's commands on this machine, outside a container, which needs the user's yes first: ${HOST_NOT_ALLOWED}. Ask the user, then rerun with --allow-host.`);
  // --inherit-env is host mode's alone: a container never inherits this shell's variables.
  const setupEnv = scrubbedEnv({ registryEnv, inheritEnv });
  const gitConfig = join(setupEnv.HOME, "readiness-gitconfig");
  writeFileSync(gitConfig, GIT_IDENTITY_CONFIG);
  Object.assign(setupEnv, normalizedEnv(gitConfig));
  const env = { ...setupEnv };
  for (const k of registryEnv) delete env[k];
  // Each command's process group, so a service a start step left in the background on this machine
  // ends with the replay, or when it is stopped, instead of outliving the audit.
  const groups = new Set<number>();
  const dropGroups = onTeardown(() => endGroups(groups));
  return {
    where,
    strength: "executed",
    image: null,
    imageSource: null,
    root,
    exec: (command, cwd, timeoutSec, opts) => (SUDO.test(command) ? Promise.resolve({ exitCode: null, timedOut: false, durationMs: 0, output: `readiness: ${SUDO_REFUSED}` }) : runCommand(command, join(root, cwd), { ...(opts?.registry ? setupEnv : env), ...opts?.env }, timeoutSec, groups)),
    offline: () => false,
    networkOff: null,
    close: () => {
      dropGroups();
      endGroups(groups);
      disposeHome(setupEnv);
    },
    runUser: process.getuid ? String(process.getuid()) : null,
  };
}

// Host mode on a disposable cloud VM: the same scrubbed copy, which proves Level 1 when the rubric
// says a disposable VM does. The test phase runs with the network cut where the VM allows it.
export function vmExecutor(root: string, registryEnv: string[], inheritEnv: boolean, proves: boolean): Executor {
  const ex = hostExecutor(root, registryEnv, inheritEnv, "disposable_vm", true);
  const raw = ex.exec;
  let cut = false;
  ex.strength = proves ? "clean_replay" : "executed";
  ex.exec = (command, cwd, timeoutSec, opts) => raw(cut && !SUDO.test(command) ? offlineCommand(command) : command, cwd, timeoutSec, opts);
  ex.offline = () => {
    cut = canCutNetwork();
    ex.networkOff = cut;
    return cut;
  };
  ex.online = () => {
    cut = false;
    return true;
  };
  return ex;
}

// Nothing runs: no container runtime or a container that didn't start, and host mode not allowed.
// Every command is recorded as not run, blocked by the reason, so the result is unproven here.
export function unavailableExecutor(root: string, reason: string): Executor {
  return {
    where: "container",
    strength: "clean_replay",
    image: null,
    imageSource: null,
    root,
    exec: () => Promise.resolve({ exitCode: null, timedOut: false, durationMs: 0, output: `readiness: not run: ${reason}` }),
    offline: () => false,
    networkOff: null,
    close: () => {},
    unavailable: reason,
  };
}

export function containerExecutor(session: ContainerSession, root: string, imageSource: Executor["imageSource"] = "audit"): Executor {
  const ex: Executor = {
    where: "container",
    strength: "clean_replay",
    image: session.image,
    imageSource,
    root,
    exec: (command, cwd, timeoutSec, opts) => session.exec(command, cwd, timeoutSec, opts),
    offline: () => (ex.networkOff = session.disconnectNetwork()),
    online: () => session.reconnectNetwork(),
    addTool: (tool) => {
      const back = session.offline && session.reconnectNetwork();
      try {
        return session.asImageUser(addToolCommand(tool), 300000).ok;
      } finally {
        if (back) session.disconnectNetwork();
      }
    },
    networkOff: null,
    close: () => session.stop(),
    runUser: session.user ? session.user.split(":")[0] : null,
  };
  return ex;
}

const KIND_CHECK: Record<CommandKind, { check: string; condition?: CondId }> = {
  doctor: { check: "bootstrap.cold_replay" },
  install: { check: "bootstrap.cold_replay", condition: "clean.install" },
  build: { check: "bootstrap.cold_replay", condition: "clean.build" },
  start: { check: "bootstrap.cold_replay" },
  lint: { check: "verify.canonical_interface", condition: "commands" },
  typecheck: { check: "verify.canonical_interface", condition: "commands" },
  test: { check: "bootstrap.cold_replay", condition: "clean.test" },
};

// A test run's counts, by the component's language file when it reads its own runner.
export function countTests(profile: Profile | null | undefined, component: string, output: string): ReturnType<typeof testCounts> {
  const comp = profile?.components.find((c) => c.id === component);
  const own = comp ? hooked(comp)?.testCounts : undefined;
  return own ? own(output) : testCounts(output);
}

// Whether output says the code doesn't compile, by the component's language file when it has a rule.
function compileFailed(comp: Component, output: string, kind: CommandKind): boolean {
  const own = hooked(comp)?.mutation.compileError;
  return own ? own(output) : diagnose(output, false, kind).cause === "compile";
}

export interface PhaseResult {
  cmd: ContractCommand;
  status: "pass" | "fail" | "not_run";
  outcome: RunOutcome | null;
  diagnosis: Diagnosis | null;
  note: string;
  blocked?: string;
  // Where it ran, when the replay used more than one image.
  executor?: Executor;
  // Whose failure it is, when an experiment decided it.
  attribution?: Attribution;
  // The rerun, with the network on, of a test run that failed with it cut.
  networkOn?: boolean;
  // On a pass after a failed rerun with the network on: what that rerun failed on.
  flaky?: string;
}

export const INSTALL_BLOCKED = "not run because the install was blocked on this machine";

export interface WorkspacePackage {
  name: string;
  path: string;
}

// Every workspace package's name and folder, assessed or not, so a missing sibling is recognised.
export function workspacePackages(root: string, profile: Profile): WorkspacePackage[] {
  const dirs = [...profile.components.map((c) => c.path), ...profile.satellites.filter((s) => s.toolchain === "Node").map((s) => s.path)];
  return [...new Set(dirs)].flatMap((path) => {
    const f = join(root, path, "package.json");
    if (!exists(f)) return [];
    try {
      const name = readJson<{ name?: string }>(f).name;
      return name ? [{ name, path }] : [];
    } catch {
      return [];
    }
  });
}

const ONLINE_KINDS = new Set<CommandKind>(["doctor", "install", "build", "start"]);

function memoryNote(n: number): string {
  return n ? `; ${n} ${n === 1 ? "run with a planted fault was" : "runs with planted faults were"} stopped at the audit's memory limit, so ${n === 1 ? "it counts" : "they count"} neither way` : "";
}

// The repo's declared environment image didn't build. A base image the runtime couldn't pull is
// this machine's network or registry access, so the install is blocked; any other failure is the
// Dockerfile's, so the install fails for the repo. Either way nothing else runs, and the audit seals.
export function declaredBuildFailure(output: string, dockerfile: string): { result: "fail" | "not_run"; summary: string; blocked?: string; reason: string } {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const last = ([...lines].reverse().find((l) => /error|failed|denied|not found/i.test(l)) ?? lines[lines.length - 1] ?? "no output").slice(0, 200);
  const file = `.cursor/${dockerfile}`;
  if (/pull access denied|failed to resolve source metadata|manifest unknown|failed to do request|dial tcp|i\/o timeout|TLS handshake timeout|no such host|toomanyrequests|unauthorized: authentication required/i.test(output)) {
    const blocked = `the base image of the declared environment ${file} couldn't be pulled on this machine (${last})`;
    return { result: "not_run", summary: `install not run: ${blocked}`, blocked, reason: blocked };
  }
  return { result: "fail", summary: `install failed: the declared environment image ${file} doesn't build (${last})`, reason: `the repo's declared environment image ${file} didn't build` };
}

// Support entries the replay reports as blocked, rather than the scan as not assessed.
export const REPLAY_STACKS = ["task-graph"];

// A failure that comes from the audit's own environment, not the repo: a tool missing from an image
// the audit picked, a network, TLS or proxy error while the network is on, or a sibling workspace
// package the audit didn't build first. Returns the blocked reason, or undefined for a repo failure.
export function environmentLimit(ex: Pick<Executor, "where" | "image" | "imageSource">, cmd: ContractCommand, d: Diagnosis | null, packages: WorkspacePackage[]): string | undefined {
  if (!d) return undefined;
  // The image has Bundler; the gem sits in a Gemfile group the install leaves out, such as rack's
  // optional maintenance group, so the audit's command for it couldn't run.
  if (d.cause === "missing_tool" && d.detail.endsWith(BUNDLE_GAP)) return `${d.detail}, so the audit couldn't run its ${cmd.kind} command`;
  if (d.cause === "missing_tool") {
    if (ex.where !== "container") return `${d.detail} on this machine`;
    if (ex.imageSource !== "repo") return `${d.detail} in the audit's image (${ex.image})`;
  }
  if (d.cause === "missing_ref") return d.detail;
  if (d.cause === "network" && ONLINE_KINDS.has(cmd.kind)) return `the ${cmd.kind} hit ${d.detail}`;
  // The audit picks the user commands run as and the home they share, so this is never the repo's.
  if (d.cause === "permission") return `${d.detail} on this machine`;
  // Out of memory or disk: the audit's memory cap or this machine's disk, which a build that is fine
  // on a bigger machine runs into. Never the repo's failure.
  if (d.cause === "resource") return `${d.detail} on this machine; ${d.limit === "disk" ? "free disk space where the temp folder and the container runtime's storage are (TMPDIR moves the temp folder), then rerun" : ex.where === "container" ? "give the container more with `readiness replay --memory <MB>` (Docker needs that much to give), then rerun" : "rerun on a machine with more memory"}`;
  // A large repo's install can outlast the audit's limit on a slow machine or disk driver.
  if (d.cause === "timeout" && cmd.kind === "install") return `the install ran past the audit's ${Math.max(1, Math.round(cmd.timeoutSec / 60))}-minute limit on this machine`;
  if (d.cause === "missing_module") {
    const mod = d.detail.replace(/^module /, "").replace(/ is missing$/, "");
    const sibling = packages.find((p) => p.path !== cmd.cwd && p.path !== "." && (mod === p.name || mod.startsWith(`${p.name}/`) || mod.includes(`/node_modules/${p.name}/`) || mod.includes(`/${p.path}/`)));
    if (sibling) return `${sibling.name} is a sibling package the audit didn't build first, which isn't supported yet`;
  }
  return undefined;
}

export interface Budget {
  componentMs: number;
  totalMs: number;
  startedAt: number;
  used: Map<string, number>;
  // A slow toolchain's component budget, where its language file raises the floor.
  floorMs?: Map<string, number>;
}

export function newBudget(componentMinutes: number, totalMinutes: number, floors: Record<string, number> = {}): Budget {
  const floorMs = new Map(Object.entries(floors).filter(([, m]) => m * 60000 > componentMinutes * 60000).map(([id, m]) => [id, m * 60000]));
  return { componentMs: componentMinutes * 60000, totalMs: totalMinutes * 60000, startedAt: Date.now(), used: new Map(), ...(floorMs.size ? { floorMs } : {}) };
}

function componentMs(b: Budget, component: string): number {
  return b.floorMs?.get(component) ?? b.componentMs;
}

// The component budgets a slow toolchain's language file raises, in minutes.
export function budgetFloors(profile: Profile): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of profile.components.filter((x) => x.assessed)) {
    const m = hooked(c)?.budget?.componentMinutes;
    if (m) out[c.id] = m;
  }
  return out;
}

export function overBudget(b: Budget, component: string): boolean {
  if (Date.now() - b.startedAt > b.totalMs) return true;
  return component !== "*" && (b.used.get(component) ?? 0) > componentMs(b, component);
}

// Seconds of budget left for a component, the whole audit's for "*". A command gets no longer than
// this, so a large repo's install or test run stops at the budget instead of running past it.
export function budgetLeftSec(b: Budget, component: string): number {
  const total = b.totalMs - (Date.now() - b.startedAt);
  const mine = component === "*" ? total : Math.min(total, componentMs(b, component) - (b.used.get(component) ?? 0));
  return Math.max(0, Math.floor(mine / 1000));
}

// The timeout to run with, and whether the budget, not the command's own limit, set it.
function capped(b: Budget, component: string, timeoutSec: number): { sec: number; byBudget: boolean } {
  const left = budgetLeftSec(b, component);
  return left < timeoutSec ? { sec: Math.max(1, left), byBudget: true } : { sec: timeoutSec, byBudget: false };
}

export function charge(b: Budget, component: string, ms: number): void {
  b.used.set(component, (b.used.get(component) ?? 0) + ms);
}

// Digests of the files a check could rewrite: what the audited commit has under its folder.
function snapshot(root: string, listFrom: string, cwd: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const f of listFiles(join(listFrom, cwd), { includeHidden: true })) {
    const rel = join(cwd, f);
    const full = join(root, rel);
    if (exists(full)) digests.set(rel, sha256(readFileSync(full)));
  }
  return digests;
}

function rewritten(root: string, before: Map<string, string>): string[] {
  return [...before].filter(([rel, digest]) => !exists(join(root, rel)) || sha256(readFileSync(join(root, rel))) !== digest).map(([rel]) => rel);
}

export const REWROTE = "so it rewrites code instead of checking it";

// The work copy keeps the repo's links as they are committed. Node's default rewrites a relative
// link into an absolute path on this machine, which doesn't exist inside the container.
export function copyWorkTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

export async function runContract(
  ex: Executor,
  contract: ContractCommand[],
  // tree: the audited commit, to list the files a check must leave alone and put them back from.
  // reruns: the experiments a failed test run gets (lib/attribute.ts).
  opts: { components: Set<string>; budget: Budget; registryValues: string[]; tree?: string; onResult?: (r: PhaseResult) => void; workspacePackages?: WorkspacePackage[]; profile?: Profile | null; reruns?: ("network" | "tool")[] },
): Promise<PhaseResult[]> {
  const results: PhaseResult[] = [];
  const push = (r: PhaseResult) => {
    results.push(r);
    opts.onResult?.(r);
  };
  const wanted = (c: ContractCommand) => c.component === "*" || opts.components.has(c.component);
  // Lint runs first, so it never reads the build's output; one that fails runs again after the build
  // (below). A repo-wide command of a kind runs before the components' own, as CI builds the root
  // first.
  const order: CommandKind[] = ["doctor", "install", "lint", "build", "start"];
  const online = contract.filter((c) => order.includes(c.kind) && wanted(c)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || Number(b.component === "*") - Number(a.component === "*"));
  const offlineCmds = contract.filter((c) => !order.includes(c.kind) && wanted(c));
  const failedInstalls = new Set<string>();
  const blockedInstalls = new Set<string>();
  const blockedIds = new Set<string>();
  // Components whose own frozen install passed after the shared install was blocked.
  const rescued = new Set<string>();
  const gated = (cmd: ContractCommand) => {
    if (cmd.kind === "doctor" || cmd.fallbackFor) return false;
    if (failedInstalls.has(cmd.component) && !rescued.has(cmd.component)) return true;
    return failedInstalls.has("*") && !rescued.has(cmd.component) && !rescued.has("*");
  };
  // Outside a container the repo's commands run on this machine's Node. One older than a locked
  // dependency's engines.node allows, as undici 8 needs 22.19 where the machine has 22.14, is a
  // limit of the machine: the same lockfile passes in an image with a Node it supports.
  let hostNode: string | null | undefined;
  const hostEngineGap = async (cwd: string): Promise<Diagnosis | null> => {
    if (hostNode === undefined) {
      const v = await ex.exec("node --version", ".", 30);
      hostNode = v.exitCode === 0 ? (v.output.trim().split("\n").pop() ?? null) : null;
    }
    const gap = hostNode ? lockedEngineGap(ex.root, cwd, hostNode) : null;
    return gap ? { cause: "missing_tool", detail: `Node ${gap.range}, which the locked ${gap.pkg} needs, is not installed; Node ${hostNode} is` } : null;
  };
  const attempt = async (cmd: ContractCommand): Promise<PhaseResult | null> => {
    if (cmd.fallbackFor && (ex.unavailable || !blockedIds.has(cmd.fallbackFor))) return null;
    if (ex.unavailable) {
      if (cmd.kind === "install") {
        failedInstalls.add(cmd.component);
        blockedInstalls.add(cmd.component);
        blockedIds.add(cmd.id);
      }
      return { cmd, status: "not_run", outcome: null, diagnosis: null, note: `not run: ${ex.unavailable}`, blocked: ex.unavailable };
    }
    const cutOff = (): PhaseResult => {
      if (cmd.kind === "install") {
        failedInstalls.add(cmd.component);
        blockedInstalls.add(cmd.component);
        blockedIds.add(cmd.id);
      }
      return { cmd, status: "not_run", outcome: null, diagnosis: null, note: "cut off by the time budget", blocked: BUDGET_OUT };
    };
    if (overBudget(opts.budget, cmd.component)) return cutOff();
    if (gated(cmd)) {
      const blocked = blockedInstalls.has(cmd.component) || (blockedInstalls.has("*") && !failedInstalls.has(cmd.component));
      return { cmd, status: "not_run", outcome: null, diagnosis: null, note: blocked ? INSTALL_BLOCKED : "not run because the install failed", blocked: blocked ? "the install was blocked on this machine" : undefined };
    }
    if (ex.where !== "container" && SUDO.test(cmd.command)) {
      if (cmd.kind === "install") {
        failedInstalls.add(cmd.component);
        blockedInstalls.add(cmd.component);
        blockedIds.add(cmd.id);
      }
      return { cmd, status: "not_run", outcome: null, diagnosis: null, note: SUDO_REFUSED, blocked: `the ${cmd.kind} command uses sudo, which the audit never runs on the host` };
    }
    const watched = cmd.kind === "lint" || cmd.kind === "typecheck" ? snapshot(ex.root, opts.tree ?? ex.root, cmd.cwd) : null;
    const limit = capped(opts.budget, cmd.component, cmd.timeoutSec);
    const out = await ex.exec(cmd.command, cmd.cwd, limit.sec, { imageUser: cmd.source.startsWith(".cursor/environment.json"), registry: cmd.kind === "doctor" || cmd.kind === "install", ...(cmd.env ? { env: cmd.env } : {}) });
    charge(opts.budget, cmd.component, out.durationMs);
    if (out.timedOut && limit.byBudget) return cutOff();
    // A check that changes the code it checks has to fail, and the code goes back for the steps after it.
    const changed = watched ? rewritten(ex.root, watched) : [];
    if (changed.length && opts.tree) for (const rel of changed) if (exists(join(opts.tree, rel))) cpSync(join(opts.tree, rel), join(ex.root, rel), { verbatimSymlinks: true });
    // A runner that prints failures and still exits 0 hasn't passed.
    const reportedFailures = cmd.kind === "test" && out.exitCode === 0 ? (countTests(opts.profile, cmd.component, out.output)?.failed ?? 0) : 0;
    const ok = out.exitCode === 0 && !out.timedOut && reportedFailures === 0 && changed.length === 0;
    const rewroteDetail = `it changed ${changed.length} ${changed.length === 1 ? "file" : "files"} (${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", …" : ""}), ${REWROTE}`;
    // Read from the redacted output, so a cause quoted from it never carries a secret.
    let diagnosis: Diagnosis | null = ok ? null : changed.length ? { cause: "unknown" as const, detail: rewroteDetail } : reportedFailures > 0 ? { cause: "unknown" as const, detail: `the runner reported ${reportedFailures} failing tests but exited 0` } : diagnose(redact(out.output, opts.registryValues), out.timedOut, cmd.kind, out.exitCode);
    if (diagnosis && ex.where !== "container" && cmd.kind !== "doctor" && !environmentLimit(ex, cmd, diagnosis, opts.workspacePackages ?? [])) diagnosis = (await hostEngineGap(cmd.cwd)) ?? diagnosis;
    const sudoRefused = !ok && ex.where !== "container" && out.output.includes(SUDO_SHIM_MARK);
    const blocked = sudoRefused ? `the ${cmd.kind} command uses sudo, which the audit never runs on the host` : ok ? undefined : environmentLimit(ex, cmd, diagnosis, opts.workspacePackages ?? []);
    if (!ok && cmd.kind === "install") {
      failedInstalls.add(cmd.component);
      if (blocked) {
        blockedInstalls.add(cmd.component);
        blockedIds.add(cmd.id);
      }
    }
    if (ok && cmd.kind === "install" && cmd.fallbackFor) rescued.add(cmd.component);
    return { cmd, status: ok ? "pass" : "fail", outcome: out, diagnosis, note: cmd.fallbackFor && ok ? "ran on its own because the shared install was blocked on this machine" : "", blocked };
  };
  const run = async (cmd: ContractCommand) => {
    const r = await attempt(cmd);
    if (r) push(r);
  };
  // A lint that fails before the build may need what the build makes, such as a workspace
  // package's types, so it gets one more run after a build that passed.
  const builtFor = (comp: string) => online.some((c) => c.kind === "build" && (c.component === comp || c.component === "*" || comp === "*"));
  const beforeBuild = new Map<string, PhaseResult>();
  for (const cmd of online) {
    const r = await attempt(cmd);
    if (!r) continue;
    if (cmd.kind === "lint" && r.status === "fail" && !r.blocked && !r.diagnosis?.detail.endsWith(REWROTE) && builtFor(cmd.component)) beforeBuild.set(cmd.id, r);
    else push(r);
  }
  const firstOffline = results.length;
  const wentOffline = ex.offline();
  for (const first of beforeBuild.values()) {
    // One build that passed is enough to try again: a sibling package's failing build shouldn't keep
    // a lint that needs the root build's types from its second run.
    const built = results.filter((r) => r.cmd.kind === "build" && (r.cmd.component === first.cmd.component || r.cmd.component === "*" || first.cmd.component === "*"));
    const again = built.some((r) => r.status === "pass") ? await attempt(first.cmd) : null;
    if (again?.status === "pass") push({ ...again, note: "failed before the build and passed after it" });
    else push({ ...first, note: again ? "failed before the build and again after it" : first.note });
  }
  for (const cmd of offlineCmds) await run(cmd);
  if (opts.reruns?.includes("tool")) await toolExperiment(ex, results.slice(firstOffline), attempt, push);
  if (opts.reruns?.includes("network") && wentOffline) await networkExperiment(ex, results.slice(firstOffline), attempt, push);
  // A container whose network wouldn't go down failed a check of the audit's own environment, so
  // nothing from the offline phase counts, pass or fail. A disposable VM that can't cut its network
  // runs the tests with it on, and the report says so.
  if (ex.where === "container" && !wentOffline) {
    for (const r of results.slice(firstOffline)) if (r.status !== "not_run" || !r.blocked) r.blocked = NETWORK_ON;
  }
  return results;
}

// Each test run that failed with the network cut, for no reason the audit's install or image already
// explains, runs once more with the network on. A pass makes the failure the environment's. A second
// failure gets one more try with the network on, since a test flaky on its own fails a rerun as often
// as a first run: a pass there makes the failures flaky, recorded as such; a third failure makes them
// the repo's. The network goes back off for the steps after.
async function networkExperiment(ex: Executor, offline: PhaseResult[], attempt: (cmd: ContractCommand) => Promise<PhaseResult | null>, push: (r: PhaseResult) => void): Promise<void> {
  const verdictOf = (r: PhaseResult) => r.attribution ?? attribute(phaseAttributionInput(ex, r), ex.imageSource);
  const latest = [...new Map(offline.map((r) => [r.cmd.id, r])).values()];
  const failed = latest.filter((r) => r.cmd.kind === "test" && r.status === "fail" && !r.blocked && rerunsOnline(verdictOf(r)));
  if (!failed.length || !ex.online?.()) return;
  try {
    for (const r of failed) {
      const again = await attempt(r.cmd);
      if (!again || again.status === "not_run") continue;
      const first = verdictOf(r);
      const failedOnline = again.status === "fail" ? (again.diagnosis?.detail ?? "non-zero exit") : null;
      const last = failedOnline ? await attempt(r.cmd) : null;
      const flaky = last?.status === "pass" ? failedOnline : null;
      r.attribution = networkVerdict(first, again.status === "pass" || flaky !== null, failedOnline ?? "");
      push({ ...again, networkOn: true, attribution: again.status === "fail" && !flaky ? r.attribution : undefined, note: again.status === "pass" ? NETWORK_RERUN_PASSED : "failed again with the network on" });
      if (!last || last.status === "not_run") continue;
      push({ ...last, networkOn: true, attribution: flaky ? undefined : r.attribution, note: flaky ? FLAKY_RERUN_PASSED : "failed a third time with the network on", ...(flaky ? { flaky } : {}) });
    }
  } finally {
    ex.offline();
  }
}

export const NETWORK_RERUN_PASSED = "passed with the network on, after failing with it cut";
export const FLAKY_RERUN_PASSED = "passed on a second try with the network on, after failing once with it on as well, so the tests are flaky";

// The tools the audit adds to an image it picked when a test run fails for want of one: only git,
// since the audit already sets the identity tests that commit use.
const ADDABLE = new Set(["git"]);

export function addToolCommand(tool: string): string {
  return `command -v ${tool} >/dev/null 2>&1 || { (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ${tool} ca-certificates) >/dev/null 2>&1 || (apk add --no-cache ${tool} >/dev/null 2>&1); command -v ${tool} >/dev/null 2>&1; }`;
}

const missingTool = (r: PhaseResult) => (r.diagnosis?.cause === "missing_tool" ? r.diagnosis.detail.replace(/ is not installed$/, "") : null);

// A test run blocked because git is missing from an image the audit picked runs again once the audit
// adds it. A pass makes the failure the image's; the rerun's own result stands either way.
async function toolExperiment(ex: Executor, offline: PhaseResult[], attempt: (cmd: ContractCommand) => Promise<PhaseResult | null>, push: (r: PhaseResult) => void): Promise<void> {
  if (ex.where !== "container" || ex.imageSource === "repo" || !ex.addTool) return;
  const failed = offline.filter((r) => r.cmd.kind === "test" && r.status === "fail" && r.blocked && ADDABLE.has(missingTool(r) ?? ""));
  const added = new Map<string, boolean>();
  for (const r of failed) {
    const tool = missingTool(r)!;
    if (!added.has(tool)) added.set(tool, ex.addTool(tool));
    if (!added.get(tool)) continue;
    const again = await attempt(r.cmd);
    if (!again || again.status === "not_run") continue;
    r.attribution = { verdict: "environment", basis: "experiment", changed: "tool", detail: `${tool} was missing from the image the audit picked` };
    // Failing with the tool the audit added says nothing yet about the repo: the version it added may differ from the one the repo's CI runs.
    const after: Attribution | undefined = again.status === "fail" ? { verdict: "undetermined", basis: "experiment", changed: "tool", detail: `the tests failed with the ${tool} the audit added to its image, whose version may differ from the one the repo's CI uses` } : undefined;
    push({ ...again, attribution: after, note: `${again.status === "pass" ? "passed" : "ran"} once the audit added ${tool} to its image` });
  }
}

function phaseAttributionInput(ex: Pick<Executor, "where">, r: PhaseResult): AttributionInput {
  return { result: r.status, kind: r.cmd.kind, where: ex.where, blocked: r.blocked, diagnosis: r.diagnosis ?? undefined, timedOut: r.outcome?.timedOut, summary: r.diagnosis?.detail ?? "", outputTail: r.outcome?.output };
}

// A result as an evidence row that isn't added to any audit, so the recheck judges it as the audit would.
export function phaseRow(ex: Executor, r: PhaseResult): Evidence {
  const map = KIND_CHECK[r.cmd.kind];
  const attribution = r.attribution ?? attribute(phaseAttributionInput(ex, r), ex.imageSource) ?? undefined;
  return {
    id: r.cmd.id,
    checkId: map.check,
    condition: map.condition,
    component: r.cmd.component,
    kind: r.cmd.kind,
    contractId: r.cmd.id,
    strength: ex.strength,
    where: ex.where,
    result: r.status,
    command: r.cmd.command,
    timedOut: r.outcome?.timedOut ?? false,
    summary: r.status === "fail" ? `${r.cmd.kind} failed: ${r.diagnosis?.detail ?? "non-zero exit"}` : `${r.cmd.kind} ${r.status === "pass" ? "passed" : r.note || "not run"}`,
    diagnosis: r.diagnosis ?? undefined,
    blocked: r.blocked,
    ...(attribution ? { attribution } : {}),
    ...(r.networkOn ? { network: "on" as const } : {}),
    at: "",
  };
}

// The output's last 4 KB, led by the build tool's root error when that falls outside them, as
// Maven's does once its stack trace and resume hint fill the end.
export function outputTail(redacted: string): string {
  const kept = tail(redacted);
  const root = kept === redacted ? null : rootError(redacted);
  return root ? `${root}\n${kept}` : kept;
}

export function evidenceFromPhase(audit: Audit, ex: Executor, r: PhaseResult, registryValues: string[]): Evidence {
  const map = KIND_CHECK[r.cmd.kind];
  const redacted = r.outcome ? redact(r.outcome.output, registryValues) : "";
  let summary: string;
  const counts = r.cmd.kind === "test" && r.outcome ? countTests(audit.profile, r.cmd.component, r.outcome.output) : null;
  if (r.status === "pass") summary = `${r.cmd.kind} passed${counts ? ` (${counts.passed} of ${counts.total} tests)` : ""}`;
  else if (r.status === "not_run") summary = r.note.startsWith("not run") ? `${r.cmd.kind} ${r.note}` : `${r.cmd.kind} not run: ${r.note}`;
  else summary = `${r.cmd.kind} failed: ${r.diagnosis?.detail ?? "non-zero exit"}${counts && counts.failed ? ` (${counts.failed} of ${counts.total} tests failed)` : ""}`;
  if (r.status === "fail" && r.diagnosis?.detail === "registry credentials not provided" && audit.environment.registryEnv.length === 0) summary = `${r.cmd.kind} failed: registry credentials not provided (pass them with --registry-env)`;
  if (r.cmd.declared && r.status !== "not_run") summary += `; ran check-only, without the write flags in \`${r.cmd.declared}\``;
  if (r.flaky) summary = `${summary}, with the network on, on a second try: the first with it on failed (${r.flaky}), so the tests are flaky`;
  else if (r.networkOn) summary = r.status === "pass" ? `${summary}, with the network on, after failing with it cut` : `${summary}; it failed again with the network on`;
  else if (/once the audit added /.test(r.note)) summary += `, ${r.note.replace(/^(passed|ran) /, "")}`;
  const attribution = r.attribution ?? attribute(phaseAttributionInput(ex, r), ex.imageSource) ?? undefined;
  const failedIn = r.status === "fail" && r.cmd.component === "*" && ATTRIBUTED.has(r.cmd.kind) && r.outcome && !r.blocked ? failingComponents(r.outcome.output, r.cmd.cwd, audit.profile?.components.filter((c) => c.assessed) ?? [], ex.root) : null;
  if (failedIn) summary += `; every failure is in ${failedIn.join(", ")}`;
  return addEvidence(audit, {
    checkId: map.check,
    condition: map.condition,
    component: r.cmd.component,
    kind: r.cmd.kind,
    contractId: r.cmd.id,
    strength: ex.strength,
    where: ex.where,
    result: r.status,
    command: r.cmd.command,
    cwd: r.cmd.cwd,
    image: ex.image ?? undefined,
    exitCode: r.outcome?.exitCode ?? null,
    timedOut: r.outcome?.timedOut ?? false,
    durationMs: r.outcome?.durationMs,
    outputTail: r.outcome ? outputTail(redacted) : undefined,
    outputDigest: r.outcome ? sha256(redacted) : undefined,
    summary,
    diagnosis: r.diagnosis ?? undefined,
    blocked: r.blocked,
    ...(failedIn ? { failedIn } : {}),
    ...(attribution ? { attribution } : {}),
    ...(r.networkOn ? { network: "on" as const } : {}),
  });
}

const ATTRIBUTED = new Set<CommandKind>(["build", "lint", "typecheck", "test"]);

// Files a failing run names as failing: a test runner's FAIL line (vitest, jest, node --test with
// a file), pytest's FAILED, a TypeScript error, or an ESLint file header followed by an error.
const FAILING_FILE = [
  /^\s*(?:FAIL|×|✗|❯)\s+(\S+?\.[cm]?[jt]sx?)\b/gm,
  /^FAILED\s+(\S+?\.py)::/gm,
  /^(\S+?\.(?:[cm]?tsx?|vue|svelte))[(:]\d+[,:]\d+\)?:?\s+(?:-\s+)?error\b/gm,
  /^(\/?\S+?\.[cm]?[jt]sx?)\n(?:\s+\d+:\d+\s+(?:warning|error)\b.*\n)*?\s+\d+:\d+\s+error\b/gm,
];

// The components a repo-wide command's failures land in, by the paths of the files that failed.
// Null when the output names none, or names one outside every assessed component: then the failure
// can't be pinned and counts against every component, as before.
export function failingComponents(output: string, cwd: string, components: { id: string; path: string }[], root = "/work"): string[] | null {
  const files = new Set<string>();
  for (const re of FAILING_FILE) for (const m of output.matchAll(re)) files.add(m[1]);
  if (files.size === 0) return null;
  const owners = new Set<string>();
  const byDepth = components.filter((c) => c.path !== ".").sort((a, b) => b.path.length - a.path.length);
  for (const f of files) {
    const absolute = [`${root}/`, "/work/"].find((p) => f.startsWith(p));
    const rel = (absolute ? f.slice(absolute.length) : f).replace(/^\.\//, "");
    const path = absolute || cwd === "." ? rel : join(cwd, rel);
    const owner = byDepth.find((c) => path === c.path || path.startsWith(`${c.path}/`));
    if (!owner) return null;
    owners.add(owner.id);
  }
  return [...owners].sort();
}

// When the repo's declared image installs the tool this machine lacks, say so: it is the clearest
// sign that the failure is the machine's, not the repo's.
function declaredImageInstalls(copyDir: string, profile: Profile, tool: string): string | null {
  const dockerfile = profile.environmentJson?.build?.dockerfile;
  if (!dockerfile || !/^[\w.+-]+$/.test(tool)) return null;
  const path = insideTree(copyDir, ".cursor", dockerfile);
  return exists(path) && new RegExp(`(^|[^\\w.-])${tool.replace(/[.+]/g, "\\$&")}([^\\w.-]|$)`, "m").test(readText(path)) ? `.cursor/${dockerfile}` : null;
}

export interface ReplayOptions {
  component?: string;
  mutants: boolean;
  instructions: boolean;
  runtime: string;
  image?: string;
  budgetComponentMinutes: number;
  budgetTotalMinutes: number;
  log: (line: string) => void;
  // The user's yes to host mode for this run; without it the opt-in variable decides.
  allowHost?: boolean;
  // Whether this machine is a disposable VM; detected when left out.
  vm?: VmDetection | null;
}

// The ecosystem one of the audit's installs runs: the root's for a repo-wide one.
function installEcosystem(profile: Profile, cmd: ContractCommand) {
  const comp = profile.components.find((c) => c.id === cmd.component);
  return ecosystemOf(cmd.component === "*" ? profile.packageManager : (comp?.packageManager ?? profile.packageManager));
}

// The lockfiles to compare after the install: the ones the scan listed, and each install's own
// ecosystem's, as the audited commit has them.
export function lockfilesToCompare(profile: Profile, tree: string, installCmds: ContractCommand[]): string[] {
  const out = new Set(profile.lockfiles);
  for (const cmd of installCmds.filter((c) => c.kind === "install" && c.source === "readiness")) {
    for (const f of installEcosystem(profile, cmd)?.lockfiles ?? []) {
      const rel = cmd.cwd === "." ? f : join(cmd.cwd, f);
      if (exists(join(tree, rel))) out.add(rel);
    }
  }
  return [...out].sort();
}

// The lockfile condition, by each ecosystem's rule (languages/): every install the audit chose pins
// what it installs, is frozen, and leaves its lockfiles as committed. `tree` is the audited commit,
// so a lockfile the install wrote doesn't count as committed.
function lockfileEvidence(audit: Audit, ex: Executor, profile: Profile, tree: string, copyDir: string, before: Map<string, string>, installCmds: ContractCommand[]): void {
  let result: "pass" | "fail" = "pass";
  let summary = "frozen install reproduced the lockfile";
  const units = installCmds.filter((c) => c.source === "readiness");
  const failWith = (why: string, cwd = ".") => {
    result = "fail";
    summary = units.length > 1 && cwd !== "." ? `${cwd}: ${why}` : why;
  };
  if (units.length === 0 && profile.lockfiles.length === 0) failWith("no lockfile is committed");
  for (const u of units) {
    const eco = installEcosystem(profile, u);
    const unpinned = eco ? eco.unpinned(tree, u.cwd) : profile.lockfiles.length === 0 ? "no lockfile is committed" : null;
    if (unpinned) {
      failWith(unpinned, u.cwd);
      break;
    }
    if (!eco?.install(tree, u.cwd, { ignoreScripts: false }).frozen) {
      failWith("the install isn't frozen", u.cwd);
      break;
    }
  }
  if (result === "pass") {
    for (const [f, digest] of before) {
      const now = exists(join(copyDir, f)) ? sha256(readText(join(copyDir, f))) : "";
      if (now !== digest) failWith(`the install changed ${f}`);
    }
  }
  addEvidence(audit, { checkId: "bootstrap.cold_replay", condition: "lockfile", component: "*", strength: ex.strength, where: ex.where, result, summary, image: ex.image ?? undefined });
}

export const NO_MUTANTS = "planted faults skipped by --no-mutants";

// How to tell whether a planted fault compiles, on its own: the component's type-check command, or
// the TypeScript compiler the install put in place. A test script that runs tsc next to the tests
// can't tell it, because which of them reports first depends on how fast the machine is.
function compileProbe(audit: Audit, ex: Executor, comp: Component): { command: string; cwd: string } | null {
  const hooks = hooked(comp);
  if (hooks) return hooks.mutation.compileProbe(comp);
  const typecheck = audit.contract.find((c) => c.kind === "typecheck" && (c.component === comp.id || c.component === "*"));
  if (typecheck) return { command: typecheck.command, cwd: typecheck.cwd };
  if (comp.language !== "ts" || !exists(join(ex.root, comp.path, "tsconfig.json"))) return null;
  const tsc = [comp.path, "."].map((d) => join(d, "node_modules", ".bin", "tsc")).find((p) => exists(join(ex.root, p)));
  return tsc ? { command: `${shellQuote(tsc)} --noEmit -p ${shellQuote(join(comp.path, "tsconfig.json"))}`, cwd: "." } : null;
}

// How long one test run with a planted fault may take: the rubric's, or a slow toolchain's floor.
function faultRunSec(rubric: Rubric, comp: Component): number {
  return Math.max(rubric.mutation.runTimeoutSec, hooked(comp)?.budget?.mutationRunTimeoutSec ?? 0);
}

// Earlier sealed audits' faults in this component. `carried`: up to `cap` of the faults the last
// audit missed, planted again first and reported beside the estimate, never in it. `missed`: every
// other fault a sealed report named as missed, which is never planted as new again, so tests aimed at
// the named lines can't move the estimate. A fault an earlier audit caught stays in the pool: its
// line was never named, and tests can't be aimed at catching what they already catch.
function priorFaults(repo: string, componentId: string, cap: number): { carried: string[]; missed: string[] } {
  const p = paths(repo);
  const missedIn = (audit: Audit) => audit.mutants.filter((m) => m.component === componentId && m.file && m.operator && m.before && m.result === "survived");
  const idOf = (m: Mutant) => m.faultId ?? faultId({ file: m.file!, before: m.before!, operator: m.operator! });
  const ids = readHistory(p).filter((h) => h.kind === "audit").map((h) => h.id);
  const audits = new Map<string, Audit>();
  for (const id of ids) {
    try {
      audits.set(id, loadSealedAudit(p, id).audit);
    } catch {
      // An audit the history lists but this clone doesn't hold names nothing here.
    }
  }
  const last = audits.get(ids.at(-1) ?? "");
  const carried = last ? [...new Set(missedIn(last).map(idOf))].slice(0, cap) : [];
  const missed = [...new Set([...audits.values()].flatMap((a) => missedIn(a).map(idOf)))].filter((id) => !carried.includes(id));
  return { carried, missed };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const confidence = (x: number) => `${Math.round(x * 1000) / 10}%`;

// `cleanMs`: the longest clean run of the test command. From 2026-12-beta a run with a planted fault
// gets mutation.timeoutFactor times it, at least mutation.minRunSec and never more than the fixed limit,
// so a fault that makes the suite hang costs seconds rather than the whole limit.
export async function plantFaults(audit: Audit, repo: string, tree: string, ex: Executor, rubric: Rubric, testCmd: ContractCommand, budget: Budget, log: (s: string) => void, cleanMs?: number): Promise<void> {
  const comp = audit.profile!.components.find((c) => c.id === testCmd.component)!;
  const runSec = faultRunSec(rubric, comp);
  const factor = rubric.mutation.timeoutFactor;
  const faultSec = factor && cleanMs ? Math.min(runSec, Math.max(rubric.mutation.minRunSec ?? 30, Math.ceil((factor * cleanMs) / 1000))) : runSec;
  // Used only when the clean tree passes it, so a repo's own type errors don't discard every fault.
  let probe = compileProbe(audit, ex, comp);
  if (probe) {
    const clean = await ex.exec(probe.command, probe.cwd, capped(budget, comp.id, runSec).sec);
    charge(budget, comp.id, clean.durationMs);
    if (clean.exitCode !== 0 || clean.timedOut) probe = null;
  }
  const rule = estimateRule(rubric.mutation);
  const identity = rubric.mutation.identity;
  const earlier = identity === "fault" ? priorFaults(repo, comp.id, rule ? carriedCap(rule) : rubric.mutation.perComponent) : { carried: [], missed: [] };
  const prior = earlier.carried;
  const count = (rule ? rule.maxPlanted : rubric.mutation.perComponent) + (rule ? prior.length : 0);
  const sites = chooseSites(repo, tree, comp, plantSeed(audit, { tree, createdAt: audit.createdAt }), count, audit.repo.commit, { identity, prior, exclude: earlier.missed });
  if (sites.length === 0) {
    addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp.id, strength: ex.strength, where: ex.where, result: "not_run", summary: "no places to plant a fault were found in files the tests import" });
    return;
  }
  const raw = ex.execFresh ?? ex.exec;
  const fresh = (command: string, cwd: string, timeoutSec: number) => raw(command, cwd, timeoutSec, testCmd.env ? { env: testCmd.env } : undefined);
  const control = rule ? await controlRun(audit, ex, comp, testCmd, sites, budget, faultSec, fresh, log) : "";
  if (control === null) return;
  const mutants: Mutant[] = [];
  let n = audit.mutants.filter((m) => m.component === comp.id).length + 1;
  let cut = 0;
  // Runs with a planted fault that timed out on their own, not by the budget. Two in a row means the
  // runs stall whatever the fault, so the rest aren't run.
  let stalls = 0;
  let stalledOut = 0;
  const runs = rubric.mutation.caughtRuns ?? rubric.mutation.flakeRuns;
  const decided = () => mutants.filter((m) => m.result === "caught" || m.result === "survived");
  const isCarried = (m: Mutant) => prior.includes(m.faultId!);
  const newDecided = () => decided().filter((m) => !isCarried(m));
  const estimate = () => {
    const carried = decided().filter(isCarried);
    return faultEstimate(newDecided().filter((m) => m.result === "caught").length, newDecided().length, rule!, rubric.mutation.minForPass, mutants.filter((m) => m.result !== "not_run" && !isCarried(m)).length, carried.length, carried.filter((m) => m.result === "caught").length);
  };
  // A narrowed run is used only once it passed on the clean tree, so a test that depends on another
  // file's setup can't read as a caught fault.
  const scopes = new Map<string, boolean>();
  let reach: ReturnType<typeof testsReaching> | undefined;
  const testCommandFor = async (file: string): Promise<string> => {
    if (!rubric.mutation.scoped) return testCmd.command;
    reach ??= testsReaching(tree, comp);
    const tests = reach ? reach(file) : null;
    const scoped = tests ? scopedCommand(testCmd.command, testCmd.cwd, tests) : null;
    if (!scoped) return testCmd.command;
    if (!scopes.has(scoped)) {
      const clean = await fresh(scoped, testCmd.cwd, capped(budget, comp.id, faultSec).sec);
      charge(budget, comp.id, clean.durationMs);
      const counts = countTests(audit.profile, comp.id, clean.output);
      scopes.set(scoped, clean.exitCode === 0 && !clean.timedOut && (counts === null || counts.total > 0));
    }
    return scopes.get(scoped) ? scoped : testCmd.command;
  };
  let lookedAt = 0;
  let memoryStops = 0;
  for (const site of sites) {
    if (rule) {
      const d = newDecided().length;
      if (d >= rule.maxDecided) break;
      if (atLook(d, rule) && d !== lookedAt) {
        lookedAt = d;
        if (!keepPlanting(estimate(), rule)) break;
      }
    }
    const id = `mut-${comp.id}-${n++}`;
    const record = { id, component: comp.id, file: site.file, line: site.line, operator: site.operator, before: redact(site.before), after: redact(site.after), faultId: faultId(site) };
    if (stalls >= 2) {
      stalledOut++;
      mutants.push({ ...record, result: "not_run", exitCodes: [] });
      if (rule) break;
      continue;
    }
    if (overBudget(budget, comp.id) || budgetLeftSec(budget, comp.id) < 1) {
      cut++;
      mutants.push({ ...record, result: "not_run", exitCodes: [] });
      if (rule) break;
      continue;
    }
    const filePath = join(ex.root, site.file);
    const command = await testCommandFor(site.file);
    const original = readText(filePath);
    writeStamped(filePath, applySite(original, site));
    const codes: number[] = [];
    let result: Mutant["result"] = "survived";
    try {
      if (probe) {
        const compiled = await fresh(probe.command, probe.cwd, capped(budget, comp.id, runSec).sec);
        charge(budget, comp.id, compiled.durationMs);
        if (compiled.exitCode !== 0 && !compiled.timedOut && compileFailed(comp, compiled.output, "typecheck")) {
          codes.push(compiled.exitCode ?? -1);
          result = "discarded";
        }
      }
      for (let run = 0; run < runs && result !== "discarded"; run++) {
        const limit = capped(budget, comp.id, faultSec);
        const out = await fresh(command, testCmd.cwd, limit.sec);
        charge(budget, comp.id, out.durationMs);
        codes.push(out.exitCode ?? -1);
        if (out.timedOut) {
          if (limit.byBudget) cut++;
          else stalls++;
          result = "not_run";
          break;
        }
        stalls = 0;
        // Stopped at the audit's memory limit or a full disk: the run says nothing about the tests,
        // as an install, build or test stopped there doesn't, so it counts neither way.
        if (out.exitCode !== 0 && diagnose(out.output, false, "test", out.exitCode).cause === "resource") {
          memoryStops++;
          result = "not_run";
          break;
        }
        if (out.exitCode === 0 && !((countTests(audit.profile, comp.id, out.output)?.failed ?? 0) > 0)) {
          result = run === 0 ? "survived" : "discarded";
          break;
        }
        if (compileFailed(comp, out.output, "test")) {
          result = "discarded";
          break;
        }
        result = "caught";
      }
    } finally {
      writeStamped(filePath, original);
    }
    mutants.push({ ...record, result, exitCodes: codes });
  }
  saveMutantDetails(tree, mutants);
  audit.mutants.push(...mutants.map((m) => ({ id: m.id, component: m.component, result: m.result, exitCodes: m.exitCodes })));
  const counted = decided();
  const caught = counted.filter((m) => m.result === "caught").length;
  const operators = [...new Set(mutants.map((m) => m.operator))].join(", ");
  const missed = mutants.filter((m) => m.result === "survived").map((m) => m.id);
  const missedNote = missed.length ? `; missed ${missed.length}${MISSED_AFTER_SEAL}` : "";
  let result: Evidence["result"];
  let summary: string;
  let est: ReturnType<typeof faultEstimate> | null = null;
  if (rule) {
    est = estimate();
    const cutNote = (cut ? "; the time budget ran out before the estimate was decided" : "") + (stalledOut ? "; planting stopped after two runs with planted faults timed out" : "") + memoryNote(memoryStops);
    const scopedNote = [...scopes.values()].some(Boolean) ? "; each ran only the tests that import its file" : "";
    const share = `caught ${est.caught} of ${est.decided} ${est.carried ? "new " : ""}planted faults (${pct(est.rate)})`;
    result = est.verdict === "strong" ? "pass" : est.verdict === "weak" ? "fail" : "not_run";
    const why = est.decided < rubric.mutation.minForPass ? `; at least ${rubric.mutation.minForPass} must give a clear result` : est.decided >= rule.maxDecided || est.planted >= rule.maxPlanted ? `; the cap of ${rule.maxDecided} was reached` : !cut && !stalledOut ? "; no more places to plant a fault" : "";
    const tailNote = control + carriedNote(mutants.filter((m) => isCarried(m) && (m.result === "caught" || m.result === "survived"))) + missedNote;
    summary =
      est.verdict === "strong"
        ? `${share}: strong, at least ${pct(est.low)} with ${confidence(rule.strongConfidence)} confidence (tried: ${operators})${scopedNote}${cutNote}${tailNote}`
        : est.verdict === "weak"
          ? `${share}: weak, at most ${pct(est.high)} with ${confidence(rule.weakConfidence)} confidence${scopedNote}${cutNote}${tailNote}`
          : `${share}: inconclusive, between ${pct(est.low)} and ${pct(est.high)}, too few to tell strong tests from weak ones${why}${scopedNote}${cutNote}${tailNote}`;
  } else {
    const cutNote = (cut ? `; the time budget cut off ${cut} of ${sites.length}` : "") + (stalledOut ? `; ${stalledOut} weren't run after two runs with planted faults timed out` : "") + memoryNote(memoryStops);
    const need = killRateOf(rubric.mutation);
    result = faultsVerdict(caught, counted.length, rubric.mutation);
    const share = need < 1 ? ` the ${Math.round(need * 100)}% the rubric requires` : "";
    summary =
      result === "not_run"
        ? `only ${counted.length} planted faults gave a clear result; at least ${rubric.mutation.minForPass} are needed${cutNote}`
        : result === "pass" && caught === counted.length
          ? `caught ${caught} of ${counted.length} planted faults (tried: ${operators})${cutNote}`
          : result === "pass"
            ? `caught ${caught} of ${counted.length} planted faults, at or above${share} (tried: ${operators})${cutNote}${missedNote}`
            : `caught ${caught} of ${counted.length} planted faults${share ? `, below${share}` : ""}${cutNote}${missedNote}`;
  }
  log(`  faults in ${comp.id}: ${summary}`);
  // Too few results because the budget ran out is the audit's limit, not weak tests.
  const blocked = cut && result === "not_run" ? { blocked: BUDGET_OUT } : stalledOut && result === "not_run" ? { blocked: "test runs with planted faults kept timing out, so the fault check couldn't finish" } : memoryStops && result === "not_run" ? { blocked: `test runs with planted faults were stopped at the audit's memory limit, so the fault check couldn't finish; ${ex.where === "container" ? "give the container more with `readiness replay --memory <MB>`" : "rerun on a machine with more memory"}` } : {};
  addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp.id, strength: ex.strength, where: ex.where, result, summary, image: ex.image ?? undefined, ...(missed.length ? { missedFaults: missed } : {}), ...(est ? { estimate: est } : {}), ...blocked });
}

const MISSED_AFTER_SEAL = " (the sealed report says where)";

// Before any fault: one change that can't alter behaviour, a comment at the end of a file the faults
// go in, and one run of the tests. Tests that check the source's text (a `git diff`, a hash, a
// generated-code check chained before the runner) fail on it, and would read every planted fault as
// caught, so the fault check is left undetermined with the reason. A linter that rejects the comment
// fails it too; the reason names both. Returns the note for the faults
// row when the tests passed, "" when no file takes a comment, and null when it recorded the result.
async function controlRun(audit: Audit, ex: Executor, comp: Component, testCmd: ContractCommand, sites: { file: string }[], budget: Budget, faultSec: number, fresh: (command: string, cwd: string, timeoutSec: number) => Promise<RunOutcome>, log: (s: string) => void): Promise<string | null> {
  const file = [...new Set(sites.map((s) => s.file))].find((f) => withControlComment(f, readText(join(ex.root, f))) !== null);
  if (!file) return "";
  const record = (summary: string, extra: Partial<Evidence> = {}): null => {
    log(`  faults in ${comp.id}: ${summary}`);
    addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp.id, strength: ex.strength, where: ex.where, result: "not_run", summary, command: testCmd.command, cwd: testCmd.cwd, image: ex.image ?? undefined, ...extra });
    return null;
  };
  if (overBudget(budget, comp.id) || budgetLeftSec(budget, comp.id) < 1) return record("no fault was planted: the time budget ran out first", { blocked: BUDGET_OUT });
  const filePath = join(ex.root, file);
  const original = readText(filePath);
  writeFileSync(filePath, withControlComment(file, original)!);
  let out: RunOutcome;
  const limit = capped(budget, comp.id, faultSec);
  try {
    out = await fresh(testCmd.command, testCmd.cwd, limit.sec);
    charge(budget, comp.id, out.durationMs);
  } finally {
    writeFileSync(filePath, original);
  }
  if (out.timedOut) return record(`no fault was planted: the test run with only a comment added to ${file} timed out`, limit.byBudget ? { blocked: BUDGET_OUT } : {});
  if (out.exitCode !== 0 && diagnose(out.output, false, "test", out.exitCode).cause === "resource") return record(`no fault was planted: the test run with only a comment added to ${file} was stopped at the audit's memory limit`, { blocked: "the control run was stopped at the audit's memory limit, so the fault check couldn't start" });
  if (out.exitCode === 0 && !((countTests(audit.profile, comp.id, out.output)?.failed ?? 0) > 0)) return `; a comment added to ${file} left the tests passing`;
  return record(`no fault was planted: the test command failed when only a comment was added to ${file}, a change that can't alter behaviour, so a failure with a planted fault couldn't be told from a failure on any edit (a \`git diff\`, hash or generated-code check, or a linter that rejects the comment)`, { exitCode: out.exitCode ?? undefined });
}

// The faults the last audit missed, planted again and reported apart from the estimate they don't count in.
function carriedNote(carried: Mutant[]): string {
  if (!carried.length) return "";
  return `; ${carried.filter((m) => m.result === "caught").length} of the ${carried.length} faults the last audit missed are now caught, planted again and not counted`;
}

// A type-check that exits 0 proves nothing until it has been seen to fail: one known type error goes
// at the end of a file the component's tests import, the type-check must fail on it, and it must
// pass again once the line is removed. Runs only after every type-check of the component passed.
async function typecheckCanary(audit: Audit, repo: string, tree: string, ex: Executor, comp: Component, results: PhaseResult[], budget: Budget, log: (s: string) => void): Promise<void> {
  const typechecks = commandsFor(audit.contract, comp.id, "typecheck");
  const runs = results.filter((r) => typechecks.some((c) => c.id === r.cmd.id));
  if (typechecks.length === 0 || runs.length !== typechecks.length || runs.some((r) => r.status !== "pass")) return;
  const base = { checkId: "verify.canonical_interface", condition: "commands" as CondId, component: comp.id, strength: ex.strength, where: ex.where, image: ex.image ?? undefined };
  const site = typeCanarySite(repo, tree, comp, audit.repo.commit);
  if (!site) {
    const summary = `no type error was planted: ${comp.id}'s tests import no ${TYPE_CANARIES.map((c) => c.label).join(" or ")} file, so its type-check counts on its exit code alone`;
    log(`  type-check canary in ${comp.id}: ${summary}`);
    addEvidence(audit, { ...base, result: "not_run", summary, canary: { kind: "typecheck", file: null, exempt: true } });
    return;
  }
  const canary = { kind: "typecheck" as const, file: site.file, line: site.line };
  const cmd = typechecks[0];
  const record = (result: Evidence["result"], summary: string, extra: Partial<Evidence> = {}) => {
    log(`  type-check canary in ${comp.id}: ${summary}`);
    addEvidence(audit, { ...base, result, summary, command: cmd.command, cwd: cmd.cwd, canary, ...extra });
  };
  if (overBudget(budget, comp.id) || budgetLeftSec(budget, comp.id) < 1) return record("not_run", "no type error was planted: the time budget ran out first", { blocked: BUDGET_OUT });
  const fresh = ex.execFresh ?? ex.exec;
  const filePath = join(ex.root, site.file);
  const original = readText(filePath);
  const caught: ContractCommand[] = [];
  let stalled: string | null = null;
  writeStamped(filePath, withCanary(original, site.line));
  try {
    for (const c of typechecks) {
      const limit = capped(budget, comp.id, c.timeoutSec);
      const out = await fresh(c.command, c.cwd, limit.sec, c.env ? { env: c.env } : undefined);
      charge(budget, comp.id, out.durationMs);
      if (out.timedOut) {
        stalled = limit.byBudget ? BUDGET_OUT : `\`${c.command}\` timed out with the planted type error`;
        break;
      }
      if (out.exitCode !== 0) caught.push(c);
    }
  } finally {
    writeStamped(filePath, original);
  }
  if (stalled) return record("not_run", `the type-check with a type error planted in ${site.file} didn't finish: ${stalled}`, stalled === BUDGET_OUT ? { blocked: BUDGET_OUT } : {});
  const shown = `\`${site.line}\``;
  if (caught.length === 0) return record("fail", `the type-check (\`${cmd.command}\`) passed with a type error planted in ${site.file} (${shown}), so it doesn't check that file`, { exitCode: 0 });
  // The same command passing again without the line shows the failure came from the planted error.
  for (const c of caught) {
    const limit = capped(budget, comp.id, c.timeoutSec);
    const again = await fresh(c.command, c.cwd, limit.sec, c.env ? { env: c.env } : undefined);
    charge(budget, comp.id, again.durationMs);
    if (again.exitCode !== 0 || again.timedOut) return record("not_run", `the type-check failed with a type error planted in ${site.file}, but didn't pass again once it was removed, so the failure can't be pinned on it`);
  }
  record("pass", `the type-check (\`${caught[0].command}\`) failed on a type error planted in ${site.file} (${shown}) and passed again once it was removed`);
}

// Next to the audit tree, outside the repository, and deleted with it once the seal copies it in.
// Writes a planted fault, or the original back, with a modification time in whole seconds later than
// any this audit gave before and later than now. Caches that trust a file whose time and size are
// unchanged, such as Python's .pyc files (which compare whole seconds), can't then run one version as
// the other when a run takes under a second, and a build that compares times with its outputs sees
// each write as newer than anything built from the one before.
let lastStamp = 0;
export function writeStamped(path: string, text: string): void {
  writeFileSync(path, text);
  lastStamp = Math.max(Math.floor(Date.now() / 1000) + 1, lastStamp + 1);
  utimesSync(path, lastStamp, lastStamp);
}

export function mutantsFile(tree: string): string {
  return join(dirname(tree), "mutants.json");
}

function saveMutantDetails(tree: string, mutants: Mutant[]): void {
  const f = mutantsFile(tree);
  const prior = exists(f) ? readJson<Mutant[]>(f) : [];
  writeJson(f, [...prior, ...mutants]);
}

// At the seal, after every result is final: put each fault's site back and name the missed ones.
export function revealMutants(audit: Audit, tree: string): void {
  const f = mutantsFile(tree);
  if (!exists(f)) return;
  const details = new Map(readJson<Mutant[]>(f).map((m) => [m.id, m]));
  audit.mutants = audit.mutants.map((m) => ({ ...details.get(m.id), ...m }));
  for (const e of audit.evidence) {
    if (!e.missedFaults?.length || !e.summary.endsWith(MISSED_AFTER_SEAL)) continue;
    const where = e.missedFaults.map((id) => details.get(id)).filter((m): m is Mutant => Boolean(m)).map((m) => `${m.operator} at ${m.file}:${m.line}`);
    if (where.length) e.summary = e.summary.replace(/; missed \d+ \(the sealed report says where\)$/, `; missed: ${where.join(", ")}`);
  }
}

const TOOL_SETUP_MS = 10 * 60 * 1000;

// The last line of a runtime's error that says something: Docker ends with "Run 'docker run --help'".
function startError(output: string): string {
  const lines = output.trim().split("\n").map((l) => l.trim()).filter((l) => l && !/^Run '.+--help'/.test(l) && !/^See '.+--help'/.test(l));
  return (lines.pop() ?? "no output").replace(/^docker: /, "").slice(0, 300);
}

// A clean container, or host mode when the user allowed it, or nothing: never a silent fallback to
// the host. With nothing, every command is recorded as not run with the reason, so Level 1 is
// unproven on this machine and the report says why.
export interface ExecutorGroup {
  ex: Executor;
  // The assessed components whose commands run here.
  components: string[];
  // Whether the repo-wide commands ("*") run here too.
  repoWide: boolean;
}

// Every executor of one replay: one per image, so a mixed-language repo runs each component in its
// own toolchain's image.
export interface Executors {
  groups: ExecutorGroup[];
  // Where a component's commands and planted faults run.
  forComponent(id: string): Executor;
  // Where the repo-wide commands and the instruction replay run: the repo's image, or the most
  // active component's when nothing repo-wide runs.
  repo: Executor;
  close(): void;
  // Set when the repo's declared environment image didn't build, so nothing ran in it.
  declaredFailure?: ReturnType<typeof declaredBuildFailure>;
}

function executorSet(groups: ExecutorGroup[], profile: Profile): Executors {
  const timedOut = new Set<string>();
  for (const g of groups) banRepeats(g.ex, timedOut);
  const forComponent = (id: string) => (groups.find((g) => g.components.includes(id)) ?? groups[0]).ex;
  const top = profile.components.filter((c) => c.assessed).sort((a, b) => b.changeShare - a.changeShare)[0];
  const repo = groups.find((g) => g.repoWide)?.ex ?? (top ? forComponent(top.id) : groups[0].ex);
  return { groups, forComponent, repo, close: () => groups.forEach((g) => g.ex.close()) };
}

// The tool a command starts with, and the component languages it belongs to. A command that runs
// one of these goes to an assessed component of that language, in that component's image.
const TOOL_LANGUAGES: { tool: RegExp; codes: Language[] }[] = [
  { tool: /^(go|gofmt|golangci-lint)$/, codes: ["go"] },
  { tool: /^(cargo|rustc|rustup)$/, codes: ["rust"] },
  { tool: /^(mvn|\.\/mvnw|mvnw|gradle|\.\/gradlew|gradlew|java|javac|kotlinc)$/, codes: ["java", "kotlin"] },
  { tool: /^dotnet$/, codes: ["csharp"] },
  { tool: /^(composer|php|phpunit|vendor\/bin\/\S+)$/, codes: ["php"] },
  { tool: /^(bundle|bundler|ruby|rake|rspec|rails|bin\/rails|bin\/rake)$/, codes: ["ruby"] },
  { tool: /^(python3?|pip3?|pytest|uv|uvx|poetry|tox|nox)$/, codes: ["py"] },
  { tool: /^(npm|npx|pnpm|pnpx|yarn|node|bun|bunx|corepack|tsc|vitest|jest)$/, codes: ["ts", "js"] },
];

// The program a command line runs first, past `cd dir &&` and variable assignments.
function leadingTool(command: string): string {
  const first = command.split(/\s*(?:&&|;|\|\|)\s*/).map((p) => p.trim()).find((p) => p && !/^cd\s/.test(p)) ?? "";
  return first.split(/\s+/).find((w) => !/^[A-Za-z_]\w*=/.test(w)) ?? "";
}

// The executor for one replayed instruction: the component whose folder the command runs in, else
// the component of the language its tool (or its Make target's recipe) belongs to, preferring one
// whose folder holds the working directory, else the root component, else the repo's executor.
export function instructionExecutor(exs: Pick<Executors, "forComponent" | "repo">, profile: Profile, tree: string, cwd: string, command: string): Executor {
  const assessed = profile.components.filter((c) => c.assessed).sort((a, b) => b.path.length - a.path.length || b.changeShare - a.changeShare);
  const holds = (c: Component) => c.path === "." || cwd === c.path || cwd.startsWith(`${c.path}/`);
  const inside = assessed.find((c) => c.path !== "." && holds(c));
  if (inside) return exs.forComponent(inside.id);
  let tool = leadingTool(command);
  if (tool === "make") {
    const target = command.trim().split(/\s+/).slice(1).find((w) => !w.startsWith("-")) ?? "";
    tool = target ? leadingTool(makeRecipe(tree, cwd, target).split("\n")[0] ?? "") : "";
  }
  const codes = TOOL_LANGUAGES.find((t) => t.tool.test(tool))?.codes ?? [];
  const byTool = assessed.filter((c) => codes.includes(c.language)).sort((a, b) => Number(holds(b)) - Number(holds(a)) || b.changeShare - a.changeShare)[0];
  if (byTool) return exs.forComponent(byTool.id);
  const root = assessed.find((c) => c.path === ".");
  return root ? exs.forComponent(root.id) : exs.repo;
}

// Past the whole budget, the setup the budget doesn't count: pulls, added tools and toolchain copies.
const SETUP_ALLOWANCE_MIN = 120;

// How long the audit's containers live unless it stops them: the whole budget and the setup around it.
export function containerLifetimeSec(budgetTotalMinutes: number): number {
  return (budgetTotalMinutes + SETUP_ALLOWANCE_MIN) * 60;
}

// Starts one clean container and adds what the audit's own image lacks for these components.
function startContainer(audit: Audit, runtime: NonNullable<ReturnType<typeof detectRuntime>>, image: string, imageSource: Executor["imageSource"], copyDir: string, limits: ReturnType<typeof probeLimits>, comps: Component[], forWhom: string, log: (s: string) => void, lifetimeSec: number): Executor | { error: string } {
  const session = new ContainerSession(runtime, `readiness-${audit.id}-${randomHex(3)}`, image, copyDir, audit.environment.registryEnv, hostUser(), limits, lifetimeSec);
  const started = session.start(log);
  if (!started.ok) {
    session.remove();
    log(`Could not start a container${forWhom}: ${startError(started.output)}`);
    return { error: startError(started.output) };
  }
  session.enableCorepack();
  if (session.userEntry === "missing" && session.user) {
    const missing = (audit.environment.userEntryMissing ??= { uid: session.user.split(":")[0], images: [] });
    if (!missing.images.includes(image)) missing.images.push(image);
    log(`The image's user can't write /etc/passwd, so uid ${missing.uid} has no entry in ${image}; a tool that looks up its user may fail there.`);
  }
  const digest = digestOf(image);
  log(`Replaying${forWhom} in a clean ${runtime.bin} container (${image}${digest ? `, pinned at ${digest.slice(0, 19)}` : ""}; ${limits.cpus ? `${limits.cpus} CPUs, ` : ""}${limits.memoryMb} MB, ${limits.pids} processes).`);
  // Python components in the Node image, as with --image, need the venv module it lacks.
  if (image.startsWith("node:") && comps.some((c) => c.language === "py")) {
    const added = session.asImageUser("python3 -m venv /tmp/venv-probe >/dev/null 2>&1 || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv >/dev/null)", 600000);
    log(added.ok ? "Added python3-venv to the Node image for the Python components." : `Couldn't add python3-venv for the Python components: ${tail(added.output, 300)}`);
  }
  // A tool missing from the repo's own image is the repo's to add, so only the audit's images get
  // one. Poetry needs the venv module above.
  if (imageSource !== "repo") {
    for (const t of toolSetup(audit.profile!, copyDir, new Set(comps.map((c) => c.id)))) {
      if (session.asImageUser(t.present ?? `command -v ${t.tool}`, 60000).ok) continue;
      const added = session.asImageUser(t.install, TOOL_SETUP_MS, { registry: true });
      (audit.environment.tools ??= []).push({ spec: t.spec, added: added.ok });
      log(added.ok ? `Added ${t.spec} to the image for the frozen install.` : `Couldn't add ${t.spec} to the image, so its install will be blocked: ${tail(added.output, 300)}`);
    }
    const copies = toolchainCopies(audit.profile!, copyDir, new Set(comps.map((c) => c.id)));
    const registers = new Set<string>();
    for (const t of copies) {
      const copied = session.copyFromImage(t.image, t.from, t.to);
      (audit.environment.toolchains ??= []).push({ spec: t.spec, image: t.image, reason: t.reason, added: copied.ok });
      if (copied.ok) registers.add(t.register(HOME_DIR));
      log(copied.ok ? `Added ${t.spec} from ${t.image} at ${t.to}, because ${t.reason}.` : `Couldn't add ${t.spec} from ${t.image}, needed because ${t.reason}: ${tail(copied.output, 300)}`);
    }
    for (const r of registers) {
      const done = session.asImageUser(r, 60000);
      if (!done.ok) log(`Couldn't register the added toolchains: ${tail(done.output, 300)}`);
    }
  }
  session.reclaimHome();
  return containerExecutor(session, copyDir, imageSource);
}

function hostModeSafety(audit: Audit, vm: VmDetection | null = null): void {
  if (!audit.safety.some((s) => s.kind === "host_mode")) audit.safety.push({ id: `saf-${String(audit.safety.length + 1).padStart(3, "0")}`, kind: "host_mode", file: ".", detail: vm ? vmModeNote(vm) : HOST_MODE_NOTE, blocking: false });
}

// Host mode, on a disposable VM when this machine is one.
function hostModeExecutor(audit: Audit, copyDir: string, vm: VmDetection | null): Executor {
  hostModeSafety(audit, vm);
  audit.environment.hostMode = true;
  if (!vm) return hostExecutor(copyDir, audit.environment.registryEnv, audit.environment.inheritEnv, "fresh_copy", true);
  return vmExecutor(copyDir, audit.environment.registryEnv, audit.environment.inheritEnv, provesIn(loadRubric(audit.rubric), "disposable_vm"));
}

const PENDING: Canary = { ok: true, checks: [] };

// Where this replay's results are proved, before its canary has run.
function recordProofEnv(audit: Audit, ex: Executor, vm: VmDetection | null): void {
  const rubric = loadRubric(audit.rubric);
  const env = audit.environment;
  if (ex.unavailable) {
    delete env.proofEnv;
    return;
  }
  const kind: ProofEnv["kind"] = ex.where === "container" ? "container" : ex.where === "disposable_vm" ? "disposable_vm" : "host";
  const id = kind === "container" ? `${env.containerRuntime ?? "container"}:${env.image ?? ex.image ?? "none"}` : kind === "disposable_vm" ? vm!.kind : "host";
  env.proofEnv = { kind, id, imageSource: ex.imageSource, ...(kind === "disposable_vm" ? { detectedBy: vm!.signals } : {}), network: null, canary: PENDING, proves: kind !== "host" && provesIn(rubric, kind) };
}

// Runs the canary in every executor before any repo command. One that fails is replaced by an
// executor that runs nothing, so every result it would have given is blocked with the reason.
// mountHint: what to say instead of "the work tree is empty" once a second folder was tried too.
export async function checkExecutors(audit: Audit, exs: Executors, profile: Profile, log: (s: string) => void, mountHint?: string): Promise<Executors> {
  const checks: Canary["checks"] = [];
  let failed: string | null = null;
  const groups: ExecutorGroup[] = [];
  for (const g of exs.groups) {
    const c = await runCanary(g.ex, g.ex.runUser ?? null);
    if (mountHint) for (const k of c.checks) if (k.id === "mount_visible" && !k.ok) k.detail = mountHint;
    checks.push(...c.checks.filter((k) => !checks.some((x) => x.id === k.id && x.ok === k.ok)));
    if (c.ok) {
      groups.push(g);
      continue;
    }
    failed ??= canaryFailure(c);
    log(`The environment failed its self-check: ${canaryFailure(c)}.`);
    g.ex.close();
    groups.push({ ...g, ex: unavailableExecutor(g.ex.root, canaryFailure(c)) });
  }
  const pe = audit.environment.proofEnv;
  if (pe) {
    pe.canary = { ok: !failed, checks };
    if (failed) pe.proves = false;
  }
  if (failed) audit.environment.notRun = failed;
  return failed ? executorSet(groups, profile) : exs;
}

// The network the test phase had, once it has run.
export function recordNetwork(audit: Audit, exs: Executors): void {
  const pe = audit.environment.proofEnv;
  if (!pe) return;
  const states = exs.groups.map((g) => g.ex.networkOff).filter((x): x is boolean => x !== null);
  if (!states.length) return;
  pe.network = states.every(Boolean) ? "cut" : "on";
  pe.canary.checks = pe.canary.checks.filter((c) => c.id !== "network_cut");
  if (pe.kind === "container") {
    pe.canary.checks.push({ id: "network_cut", ok: pe.network === "cut", detail: pe.network === "cut" ? "ok" : "the container's network wouldn't go down" });
    if (pe.network === "on") {
      pe.canary.ok = false;
      pe.proves = false;
    }
  }
}

// Clean containers, one per image in the plan, or host mode when the user allowed it, or nothing:
// never a silent fallback to the host. With nothing, every command is recorded as not run with the
// reason, so Level 1 is unproven on this machine and the report says why. `repoWide`: whether any
// repo-wide command runs, which the repo's image is started for even when no component runs in it.
// budgetTotalMinutes: the replay's whole budget, which bounds how long its containers live.
export function makeExecutors(audit: Audit, copyDir: string, runtimePref: string, log: (s: string) => void, imageOverride?: string, allowHost?: boolean, repoWide = true, vmDetected?: VmDetection | null, budgetTotalMinutes?: number): Executors {
  assertPlatformSupported();
  const vm = vmDetected === undefined ? detectDisposableVm() : vmDetected;
  const lifetimeSec = containerLifetimeSec(budgetTotalMinutes ?? loadRubric(audit.rubric).budgets.totalMinutes);
  const exs = pickExecutors(audit, copyDir, runtimePref, log, imageOverride, allowHost, repoWide, vm, lifetimeSec);
  recordProofEnv(audit, exs.repo, vm);
  return exs;
}

function pickExecutors(audit: Audit, copyDir: string, runtimePref: string, log: (s: string) => void, imageOverride: string | undefined, allowHost: boolean | undefined, repoWide: boolean, vm: VmDetection | null, lifetimeSec: number): Executors {
  const profile = audit.profile!;
  const runtime = detectRuntime(runtimePref);
  let single = imageOverride;
  let imageSource: Executor["imageSource"] = imageOverride ? "override" : "audit";
  const declared = profile.environmentJson?.build;
  if (runtime && declared && !imageOverride) {
    const dockerfile = insideTree(copyDir, ".cursor", declared.dockerfile);
    const context = insideTree(copyDir, ".cursor", declared.context ?? ".");
    const tag = `readiness-env-${sha256(readText(dockerfile)).slice(0, 12)}`;
    log(`Building the repo's declared environment image from .cursor/${declared.dockerfile}.`);
    const built = buildImage(runtime, context, dockerfile, tag);
    if (!built.ok) {
      const found = declaredBuildFailure(built.output, declared.dockerfile);
      log(`The repo's declared environment image didn't build: ${found.summary}. Nothing else runs in it; the audit goes on to the seal.`);
      audit.environment.containerRuntime = runtime.bin;
      audit.environment.image = tag;
      audit.environment.notRun = found.reason;
      delete audit.environment.limits;
      delete audit.environment.imageDigest;
      delete audit.environment.images;
      const ids = profile.components.filter((c) => c.assessed).map((c) => c.id);
      return { ...executorSet([{ ex: unavailableExecutor(copyDir, found.reason), components: ids, repoWide: true }], profile), declaredFailure: found };
    }
    single = tag;
    imageSource = "repo";
  }
  delete audit.environment.userEntryMissing;
  delete audit.environment.toolchains;
  const plan = imagePlan(profile, copyDir, single);
  const assessed = profile.components.filter((c) => c.assessed);
  const wanted = plan.filter((g, i) => g.components.length > 0 || (i === 0 && repoWide));
  const allIds = assessed.map((c) => c.id);
  let notStarted: string | null = null;
  if (runtime && wanted.length) {
    const limits = probeLimits(runtime);
    const started: (ExecutorGroup | { why: string; components: string[]; repoWide: boolean })[] = [];
    const runs: ImageRun[] = [];
    for (const g of wanted) {
      const isRepo = g === plan[0];
      const forWhom = wanted.length > 1 ? ` ${isRepo ? "the repo" : g.components.join(", ")}` : "";
      const r = startContainer(audit, runtime, g.image, imageSource, copyDir, limits, assessed.filter((c) => g.components.includes(c.id)), forWhom, log, lifetimeSec);
      const digest = digestOf(g.image);
      const ids = [...(isRepo ? ["*"] : []), ...g.components];
      if ("error" in r) {
        const why = `the audit's ${runtime.bin} container (${g.image}) didn't start: ${r.error}`;
        started.push({ why, components: g.components, repoWide: isRepo });
        runs.push({ image: g.image, ...(digest ? { digest } : {}), components: ids, started: false, notRun: why });
      } else {
        started.push({ ex: r, components: g.components, repoWide: isRepo });
        runs.push({ image: g.image, ...(digest ? { digest } : {}), components: ids, started: true });
      }
    }
    const first = started.find((g): g is ExecutorGroup => "ex" in g);
    if (first) {
      // Some image started: one that didn't leaves its components unproven here, or runs them in
      // host mode when the user allowed it.
      const groups = started.map((g): ExecutorGroup => {
        if ("ex" in g) return g;
        if (hostAllowed(allowHost)) return { ex: hostModeExecutor(audit, copyDir, vm), components: g.components, repoWide: g.repoWide };
        return { ex: unavailableExecutor(copyDir, `${g.why}, and ${HOST_NOT_ALLOWED}`), components: g.components, repoWide: g.repoWide };
      });
      audit.environment.containerRuntime = runtime.bin;
      audit.environment.image = wanted[0].image;
      audit.environment.limits = limits;
      const digest = digestOf(wanted[0].image);
      if (digest) audit.environment.imageDigest = digest;
      else delete audit.environment.imageDigest;
      if (runs.length > 1) audit.environment.images = runs;
      else delete audit.environment.images;
      delete audit.environment.notRun;
      return executorSet(groups, profile);
    }
    notStarted = (started[0] as { why: string }).why;
  }
  delete audit.environment.limits;
  delete audit.environment.imageDigest;
  delete audit.environment.images;
  const image = wanted[0]?.image ?? plan[0].image;
  const unseen = !runtime && !vm ? vmNotDetectedNote() : null;
  if (unseen) log(unseen);
  if (hostAllowed(allowHost)) {
    audit.environment.containerRuntime = null;
    audit.environment.image = null;
    delete audit.environment.notRun;
    const ex = hostModeExecutor(audit, copyDir, vm);
    if (!vm) log(`${notStarted ? "No container" : "No container runtime"}: host mode is allowed, so the repo's commands run in a fresh copy on this machine. They can read this user's local files, and Level 1 can't be proved here.`);
    else log(`${notStarted ? "No container" : "No container runtime"}: host mode is allowed on ${vm.label} (detected by ${vm.signals.join(" and ")}), so the repo's commands run in a fresh copy on it${ex.strength === "clean_replay" ? ", which proves Level 1 under this rubric" : "; this audit's rubric proves Level 1 only in a container"}.`);
    return executorSet([{ ex, components: allIds, repoWide: true }], profile);
  }
  // A runtime that couldn't start the container stays recorded, so the report names the container
  // and its error rather than a missing runtime.
  audit.environment.containerRuntime = notStarted && runtime ? runtime.bin : null;
  audit.environment.image = notStarted ? image : null;
  const reason = `${notStarted ?? noRuntimeReason(runtimePref)}, and ${HOST_NOT_ALLOWED}`;
  audit.environment.notRun = reason;
  log(`${notStarted ? "No container" : "No container runtime"}: nothing runs outside a container without the user's yes, so Level 1 is unproven on this machine (${reason}).`);
  return executorSet([{ ex: unavailableExecutor(copyDir, reason), components: allIds, repoWide: true }], profile);
}

// Runs each executor's share of the contract: the repo-wide commands where they run, and each
// component's commands in its own image. Every result says which executor ran it.
export async function runContracts(exs: Executors, contract: ContractCommand[], opts: Parameters<typeof runContract>[2]): Promise<PhaseResult[]> {
  const out: PhaseResult[] = [];
  for (const g of exs.groups) {
    const components = new Set(g.components.filter((c) => opts.components.has(c)));
    const mine = contract.filter((c) => (c.component === "*" ? g.repoWide : components.has(c.component)));
    if (mine.length === 0) continue;
    const results = await runContract(g.ex, mine, { ...opts, components });
    out.push(...results.map((r) => ({ ...r, executor: g.ex })));
  }
  return out;
}

export async function replay(audit: Audit, repo: string, tree: string, rubric: Rubric, opts: ReplayOptions): Promise<void> {
  if (audit.tier === "read-only") fail("The read-only tier doesn't run repo code. Re-init with --tier local-exec.");
  if (!audit.profile) fail("Run `readiness scan` before `readiness replay`.");
  if (!audit.profile.components.some((c) => c.assessed)) {
    opts.log("Nothing to replay: no component could be assessed. The report says why and gives no level.");
    return;
  }
  const profile = audit.profile;
  const components = new Set(profile.components.filter((c) => c.assessed && (!opts.component || c.id === opts.component)).map((c) => c.id));
  if (opts.component && components.size === 0) fail(`No assessed component named ${opts.component}`);
  for (const gone of reapOrphans(opts.runtime)) opts.log(`Removed ${gone}, left by an audit that was stopped before it could clean up.`);
  refreshTree(repo, audit.repo.commit, tree);
  // Everything from the copy on is undone in the finally, and on a signal or crash by teardown.ts.
  if (opts.image) audit.environment.imageOverride = opts.image;
  const before = new Map<string, string>();
  for (const f of lockfilesToCompare(profile, tree, audit.contract)) before.set(f, sha256(readText(join(tree, f))));
  const bytes = treeBytes(repo, audit.repo.commit);
  assertFreeSpace(tmpdir(), bytes === null ? null : 2 * bytes, "the replay's copy of the tree and the dependencies it installs there");
  const { exs, scratch, copyDir } = await openWithMountRetry(audit, tree, opts.log, (dir, hint) =>
    checkExecutors(audit, makeExecutors(audit, dir, opts.runtime, opts.log, opts.image ?? audit.environment.imageOverride, opts.allowHost, audit.contract.some((c) => c.component === "*"), opts.vm, opts.budgetTotalMinutes), profile, opts.log, hint),
  );
  try {
    recordHostConsent(audit, repo);
    await replayIn(audit, repo, tree, rubric, opts, exs, copyDir, before, components);
    // Recorded after the install rows the replay wrote as blocked, so it is the install's result.
    const found = exs.declaredFailure;
    if (found) addEvidence(audit, { checkId: "bootstrap.cold_replay", condition: "clean.install", component: "*", kind: "install", contractId: audit.contract.find((c) => c.kind === "install" && c.component === "*")?.id, strength: "clean_replay", where: "container", result: found.result, summary: found.summary, ...(found.blocked ? { blocked: found.blocked } : { attribution: { verdict: "repo" as const, basis: "known_cause" as const, detail: found.summary } }) });
  } finally {
    exs.close();
    scratch.dispose();
  }
}

// Where the work tree goes when the runtime can't see the temp folder: Colima's default mounts, snap
// Docker and a remote DOCKER_HOST share the home folder, or nothing, but not /tmp.
export function cacheBase(): string {
  return join(homedir(), ".cache", "agent-readiness");
}

export function mountUnseen(audit: Audit): boolean {
  const pe = audit.environment.proofEnv;
  return pe?.kind === "container" && pe.canary.checks.some((c) => c.id === "mount_visible" && !c.ok);
}

export function mountHint(folders: string[]): string {
  return `the container runtime couldn't see the work tree under ${folders.join(" or ")}, as it mounts only folders it shares with this machine; set TMPDIR to a folder it shares and run the audit again`;
}

// Opens the executors on a copy of the tree, and when the container's self-check finds the copy
// empty, once more on a copy under cacheBase(). The scratch folder in use is returned for disposal.
export async function openWithMountRetry(
  audit: Audit,
  tree: string,
  log: (s: string) => void,
  open: (copyDir: string, hint?: string) => Promise<Executors>,
  bases: string[] = [tmpdir(), cacheBase()],
): Promise<{ exs: Executors; scratch: TempDir; copyDir: string }> {
  let scratch = tempDir("readiness-replay-", bases[0]);
  try {
    let copyDir = join(scratch.path, "work");
    copyWorkTree(tree, copyDir);
    let exs = await open(copyDir);
    if (!mountUnseen(audit) || bases.length < 2) return { exs, scratch, copyDir };
    log(`The container couldn't see the audit's copy of the repo under ${bases[0]}; trying again under ${bases[1]}.`);
    exs.close();
    scratch.dispose();
    mkdirSync(bases[1], { recursive: true });
    scratch = tempDir("readiness-replay-", bases[1]);
    copyDir = join(scratch.path, "work");
    copyWorkTree(tree, copyDir);
    delete audit.environment.notRun;
    exs = await open(copyDir, mountHint(bases));
    return { exs, scratch, copyDir };
  } catch (e) {
    scratch.dispose();
    throw e;
  }
}

// Containers and temp folders of audits on this machine whose process is gone, whatever their age.
// With container runtimes turned off, the runtime isn't asked.
export function reapOrphans(runtimePref = "auto"): string[] {
  return [...(runtimePref === "none" ? [] : removeOrphanedContainers()), ...removeOrphanedTempDirs(), ...removeOrphanedTempDirs(cacheBase())];
}

async function replayIn(audit: Audit, repo: string, tree: string, rubric: Rubric, opts: ReplayOptions, exs: Executors, copyDir: string, before: Map<string, string>, components: Set<string>): Promise<void> {
  const profile = audit.profile!;
  const ex = exs.repo;
  const progress = new Progress(opts.log);
  for (const g of exs.groups) progress.watch(g.ex);
  const registryValues = registryValuesOf(audit);
  const budget = newBudget(opts.budgetComponentMinutes, opts.budgetTotalMinutes, budgetFloors(profile));
  const firstRow = audit.evidence.length;
  const results = await runContracts(exs, audit.contract, {
    components,
    reruns: rubric.attribution?.reruns ?? [],
    budget,
    registryValues,
    tree,
    profile,
    workspacePackages: workspacePackages(copyDir, profile),
    onResult: (r) => opts.log(`  ${r.cmd.kind.padEnd(9)} ${r.cmd.component.padEnd(12)} ${r.blocked ? "blocked" : r.status}${r.outcome ? ` in ${fmtDuration(r.outcome.durationMs)}` : ""}${r.blocked ? ` (${r.blocked})` : r.diagnosis ? ` (${r.diagnosis.detail})` : r.note ? ` (${r.note})` : ""}`),
  });
  recordNetwork(audit, exs);
  for (const r of results) {
    const rex = r.executor ?? ex;
    if (r.blocked && r.diagnosis?.cause === "missing_tool" && rex.where !== "container") {
      const tool = r.diagnosis.detail.replace(/ is not installed$/, "");
      const declared = declaredImageInstalls(copyDir, profile, tool);
      if (declared) r.blocked += `, though the repo's declared image (${declared}) installs it`;
    }
    if (r.blocked && r.diagnosis?.cause === "missing_tool" && rex.where === "container") {
      const tool = r.diagnosis.detail.replace(/ is not installed$/, "");
      const failed = audit.environment.tools?.find((t) => !t.added && (t.spec.split(/[@=]/)[0] === tool || t.spec === tool.replace(/^\.NET SDK /, "dotnet-sdk@")));
      if (failed) r.blocked += `: the audit couldn't add ${failed.spec} to it on this machine`;
    }
    const ev = evidenceFromPhase(audit, rex, r, registryValues);
    if (r.diagnosis?.cause === "credential" && !audit.safety.some((s) => s.kind === "credential_needed" && s.detail.includes(r.diagnosis!.detail))) {
      audit.safety.push({ id: `saf-${String(audit.safety.length + 1).padStart(3, "0")}`, kind: "credential_needed", file: ev.id, detail: `tests ${r.diagnosis.detail}`, blocking: true });
    }
  }
  const allInstalls = results.filter((r) => r.cmd.kind === "install");
  // When this machine blocked the shared install, the components' own frozen installs stand in for it.
  const installs = allInstalls.some((r) => r.cmd.fallbackFor) ? allInstalls.filter((r) => r.cmd.fallbackFor || !r.blocked) : allInstalls;
  const installed = installs.length > 0 && installs.every((r) => r.status === "pass");
  if (installed) lockfileEvidence(audit, ex, profile, tree, copyDir, before, installs.map((r) => r.cmd));
  else if (installs.some((r) => r.blocked) && installs.every((r) => r.status === "pass" || r.blocked)) {
    const blocked = installs.find((r) => r.blocked)!.blocked!;
    addEvidence(audit, { checkId: "bootstrap.cold_replay", condition: "lockfile", component: "*", strength: ex.strength, where: ex.where, result: "not_run", summary: "the frozen install couldn't run on this machine", blocked, image: ex.image ?? undefined });
  }
  if (rubric.canary?.typecheck) {
    for (const comp of components) {
      const c = profile.components.find((x) => x.id === comp)!;
      try {
        await typecheckCanary(audit, repo, tree, exs.forComponent(comp), c, results, budget, opts.log);
      } catch (e) {
        const why = (e as Error).message.split("\n")[0].slice(0, 200);
        opts.log(`  type-check canary in ${comp}: couldn't be planted (${why}); the other results are kept`);
        addEvidence(audit, { checkId: "verify.canonical_interface", condition: "commands", component: comp, strength: exs.forComponent(comp).strength, where: exs.forComponent(comp).where, result: "not_run", summary: `planting the type error failed: ${why}`, canary: { kind: "typecheck", file: null } });
      }
    }
  }
  if (opts.mutants) {
    for (const comp of components) {
      const ex = exs.forComponent(comp);
      const mine = new Set(commandsFor(audit.contract, comp, "test").map((c) => c.id));
      // A rerun with the network on stands in for the run it repeated.
      const testRuns = [...new Map(results.filter((r) => mine.has(r.cmd.id)).map((r) => [r.cmd.id, r])).values()];
      const testRes = testRuns.find((r) => r.cmd.component === comp) ?? testRuns[0];
      if (!testRes || testRuns.some((r) => r.status !== "pass")) {
        addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: testRes ? "tests must pass before faults can be planted" : "no test command found" });
        continue;
      }
      if (testRuns.some((r) => r.blocked)) {
        addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: "faults weren't planted: the network couldn't be switched off for the test phase", blocked: NETWORK_ON });
        continue;
      }
      // Tests that passed only with the network on get it for the planted faults as well.
      const needsNetwork = testRuns.some((r) => r.networkOn);
      if (needsNetwork && !ex.online?.()) {
        addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: `faults weren't planted: ${NEEDS_NETWORK}`, blocked: NEEDS_NETWORK });
        continue;
      }
      const plant = async (): Promise<void> => {
        const limit = capped(budget, comp, testRes.cmd.timeoutSec);
        const second = overBudget(budget, comp) || budgetLeftSec(budget, comp) < 1 ? null : await ex.exec(testRes.cmd.command, testRes.cmd.cwd, limit.sec, testRes.cmd.env ? { env: testRes.cmd.env } : undefined);
        if (second) charge(budget, comp, second.durationMs);
        if (!second || (second.timedOut && limit.byBudget)) {
          addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: "faults weren't planted: the time budget ran out first", blocked: BUDGET_OUT });
          return;
        }
        // The unmutated tests timing out means every run with a planted fault would too: the fault
        // check is unproven here, said once, rather than a timeout per fault.
        if (second.timedOut) {
          const why = diagnose(redact(second.output, registryValues), true, "test").detail;
          const stalled = `the unmutated test run timed out (${why}), so each planted fault would time out too`;
          addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: `faults weren't planted: ${stalled}`, blocked: stalled });
          return;
        }
        if (second.exitCode !== 0 || (countTests(profile, comp, second.output)?.failed ?? 0) > 0) {
          addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: "tests passed once and failed on a second run, so faults weren't planted (possible flaky tests)" });
          return;
        }
        const lang = profile.components.find((c) => c.id === comp)!.language;
        if (!rubric.mutation.languages.includes(lang)) {
          addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: `faults can't be planted in ${lang} yet` });
          return;
        }
        try {
          await plantFaults(audit, repo, tree, ex, rubric, testRes.cmd, budget, opts.log, Math.max(second.durationMs, testRes.outcome?.durationMs ?? 0));
        } catch (e) {
          const why = (e as Error).message.split("\n")[0].slice(0, 200);
          opts.log(`  faults in ${comp}: couldn't be planted (${why}); the other results are kept`);
          addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: `planting faults failed: ${why}` });
        }
      };
      try {
        await plant();
      } finally {
        if (needsNetwork) ex.offline();
      }
    }
  } else {
    for (const comp of components) {
      const cex = exs.forComponent(comp);
      addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: cex.strength, where: cex.where, result: "not_run", summary: NO_MUTANTS, skipped: "--no-mutants" });
    }
  }
  if (opts.instructions) {
    const blocked = installs.find((r) => r.blocked)?.blocked;
    await replayInstructions(audit, (cwd, command) => instructionExecutor(exs, profile, copyDir, cwd, command), copyDir, budget, registryValues, installed ? null : { blocked });
  }
  const totalOut = Date.now() - budget.startedAt > budget.totalMs;
  const cut = [...new Set(audit.evidence.slice(firstRow).filter((e) => e.blocked === BUDGET_OUT).map((e) => e.component ?? "*"))];
  for (const line of budgetSummary(budget, opts.budgetComponentMinutes, { components: totalOut ? [] : cut, total: totalOut })) opts.log(line);
}

export { CUT_OFF };
