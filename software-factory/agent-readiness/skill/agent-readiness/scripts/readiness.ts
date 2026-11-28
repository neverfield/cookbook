import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inventory, orgSkillBuilders } from "./lib/assets.ts";
import { addContractCommand, checkComponent, discoverContract } from "./lib/contract.ts";
import { compareAudits, weakeningFlags } from "./lib/diff.ts";
import { addEvidence, recordObservation } from "./lib/evidence.ts";
import { levelResult } from "./lib/format.ts";
import { ghAvailable, ghJson } from "./lib/gh.ts";
import { HOOKS_FILE, guardInstalled, installGuard, probeGuard, uninstallGuard } from "./lib/guard.ts";
import { auditIds, loadSealedAudit, pushHistory, readHistory, readRoadmap, writeRoadmap } from "./lib/history.ts";
import { MAX_PRS, computeOutcomes, fetchPrs, loadPrsFile } from "./lib/outcomes.ts";
import { PREVIEW } from "./lib/preview.ts";
import { buildProfile } from "./lib/profile.ts";
import { redact } from "./lib/redact.ts";
import { MEMORY_ENV, memoryOverride } from "./lib/container.ts";
import { ALLOW_HOST_ENV, HOST_NOT_ALLOWED, assertPlatformSupported, evidenceFromPhase, hostAllowed, hostExecutor, newBudget, reapOrphans, recordHostConsent, registryValuesOf, replay, runContract } from "./lib/replay.ts";
import { latestRubricVersion, loadRubric } from "./lib/rubric.ts";
import { SCAN_BOUND_MINUTES, capCutFolders, sampledScope } from "./lib/scope.ts";
import { validateAgainst } from "./lib/schema.ts";
import { componentStates, gatingInstruction } from "./lib/score.ts";
import type { Rubric } from "./lib/rubric.ts";
import { VERDICT_WORD, blockedBy, judge, verdictWord } from "./lib/verdict.ts";
import { buildSealedReport, recheck, seal, verifySeal } from "./lib/seal.ts";
import { LEASE_HOURS, endSession, lease, recordGrant, startSession } from "./lib/session.ts";
import { cleanupLeftovers } from "./lib/cleanup.ts";
import { composeServices, renderEnvFiles, renderVerifySkill, serviceKey, writeFiles } from "./lib/skill.ts";
import { staticSignals } from "./lib/signals.ts";
import { instructionItems, safetyScan } from "./lib/static.ts";
import type { NarrationChoices } from "./lib/model.ts";
import { WORKS_LEAD, slotErrors } from "./lib/model.ts";
import type { Audit, CommandKind, CondId, Level, Narration, Result, Roadmap, ScanBound, ScenarioId, ScenarioSpec, Strength, Tier } from "./lib/types.ts";
import { addDays, exists, fail, git, nowIso, randomHex, readJson, readText, sha256, today, writeJson } from "./lib/util.ts";
import { WAIVER_FILE, applyWaivers, loadWaivers } from "./lib/waivers.ts";
import { CONFIG_FILE, applyCommandConfig, isConfigCommand, loadCommandConfig } from "./lib/config.ts";
import { commitReader, currentDraftId, initAudit, loadDraft, paths, refreshTree, releaseManifest, resolveRepo, saveDraft, scratchTree, writeRecordsIgnore } from "./lib/workspace.ts";

const BOOLEAN = new Set(["images", "force", "remediate", "inherit-env", "allow-host", "no-mutants", "no-instructions", "no-outcomes", "json", "push", "allow-eval", "allow-unkeyed", "dockerfile", "instructions", "strict", "help"]);

const MIN_NODE: [number, number] = [22, 14];

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (inline !== undefined) flags[key] = inline;
      else if (BOOLEAN.has(key)) flags[key] = true;
      else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) fail(`--${key} needs a value`);
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function str(a: Args, key: string, fallback?: string): string {
  const v = a.flags[key];
  if (typeof v === "string") return v;
  if (fallback !== undefined) return fallback;
  return fail(`Missing --${key}`);
}

function opt(a: Args, key: string): string | undefined {
  const v = a.flags[key];
  return typeof v === "string" ? v : undefined;
}

function csv(v: string | undefined): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

const SCENARIOS: ScenarioId[] = ["first_pr", "bug_fixes", "features", "repo_wide"];
const TIERS: Tier[] = ["read-only", "local-exec", "external-systems"];

const log = (s: string) => process.stdout.write(s + "\n");

function repoOf(a: Args): string {
  return resolveRepo(opt(a, "repo") ?? process.cwd());
}

function requireTier(audit: Audit, needed: Tier, what: string): void {
  if (TIERS.indexOf(audit.tier) < TIERS.indexOf(needed)) fail(`${what} needs the ${needed} tier; this audit is ${audit.tier}.`);
}

// Scenarios are optional: every audit reports one standard level per component and a repo rollup.
function scenarioIds(a: Args): ScenarioId[] {
  const ids = csv(opt(a, "scenario"));
  const goal = opt(a, "goal");
  if (goal) {
    log(`--goal is now --scenario: added the ${goal} scenario for every component. Levels are standard without it.`);
    ids.push(goal);
  }
  for (const id of ids) if (!SCENARIOS.includes(id as ScenarioId)) fail(`--scenario takes ${SCENARIOS.join(", ")}; got ${id}.`);
  return [...new Set(ids)] as ScenarioId[];
}

// Signs that agents already open PRs here: agent branch names in merges, or agent co-author trailers.
function agentHistory(repo: string): string | null {
  const r = git(["log", `--since=${addDays(today(), -90)}`, "--format=%s%n%b", "-n", "500"], repo);
  const text = r.stdout;
  const branches = text.match(/\b(cursor|codex|claude|copilot|devin)\/[\w./-]+/gi) ?? [];
  const trailers = text.match(/^Co-authored-by: .*(Cursor|Codex|Claude|Copilot|Devin)/gim) ?? [];
  if (branches.length + trailers.length === 0) return null;
  return [branches.length ? `${branches.length} agent branch ${branches.length === 1 ? "merge" : "merges"}` : "", trailers.length ? `${trailers.length} agent co-author ${trailers.length === 1 ? "trailer" : "trailers"}` : ""].filter(Boolean).join(" and ");
}

function cmdInit(a: Args): void {
  const scenarios: ScenarioSpec[] = scenarioIds(a).map((id) => ({ id, components: ["*"] }));
  const tier = str(a, "tier", "local-exec") as Tier;
  if (!TIERS.includes(tier)) fail(`--tier must be one of ${TIERS.join(", ")}`);
  const registryEnv = csv(opt(a, "registry-env"));
  for (const k of registryEnv) if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) fail(`--registry-env takes variable names, not values: ${k}`);
  for (const k of registryEnv) if (k.startsWith("SA_")) fail(`--registry-env can't pass ${k}: the audit's own settings, such as the seal key, never reach the repo's code.`);
  const { audit, local, abandoned } = initAudit({ repo: repoOf(a), scenarios, tier, registryEnv, inheritEnv: Boolean(a.flags["inherit-env"]), force: Boolean(a.flags.force) });
  if (abandoned) log(`Abandoned ${abandoned}: its draft and audit tree are removed.`);
  for (const gone of reapOrphans(process.env.SA_READINESS_RUNTIME || "auto")) log(`Removed ${gone}, left by an audit that was stopped before it could clean up.`);
  log(`Opened ${audit.id} (${tier}) at ${audit.repo.commit.slice(0, 7)}${scenarios.length ? `, with the ${scenarios.map((s) => s.id).join(" and ")} ${scenarios.length > 1 ? "scenarios" : "scenario"} for every component` : ""}${audit.repo.dirtyTree ? "; uncommitted changes are not audited" : ""}.`);
  log(`Audit tree: ${local.tree}`);
  if (audit.repo.shallow) log("This clone is shallow, so change shares and the active-component rule come only from the commits it has. Run `git fetch --unshallow` (or `--shallow-since`) before the audit for shares over the full window.");
  if (audit.repo.submodulesMissing?.length) log(`Submodules not checked out on this machine, so the audit tree lacks them: ${audit.repo.submodulesMissing.join(", ")}. Run \`git submodule update --init --recursive\` first if the build or tests need them.`);
  if (audit.repo.lfsPointers) log(`${audit.repo.lfsPointers} Git LFS ${audit.repo.lfsPointers === 1 ? "file stays a pointer" : "files stay pointers"} in the audit tree. Run \`git lfs pull\` first if the build or tests read them.`);
  if (audit.seed.pinned) log("Planted-fault seed is pinned by SA_READINESS_EVAL_SEED: this is an eval run, not a production audit.");
}

function cmdScan(a: Args): void {
  const repo = repoOf(a);
  const { audit, local, paths: p } = loadDraft(repo);
  const rubric = loadRubric(audit.rubric);
  const boundMinutes = Number(str(a, "budget-scan", String(SCAN_BOUND_MINUTES)));
  if (!(boundMinutes > 0)) fail("--budget-scan takes the scan's time bound in minutes, more than 0.");
  const bound: ScanBound = { until: Date.now() + boundMinutes * 60000, scope: { boundMinutes, files: 0, fileCap: null, secrets: { scanned: 0, total: 0 }, assetHistory: { read: 0, total: 0 } } };
  refreshTree(repo, audit.repo.commit, local.tree);
  const profile = buildProfile(repo, local.tree, rubric, audit.repo.commit);
  profile.scope = bound.scope;
  if (profile.sharesUnread) log(`Change shares couldn't be read (${profile.sharesUnread}), so every component's share reads 0% and the coverage line says so.`);
  audit.profile = profile;
  audit.safety = safetyScan(local.tree, profile, bound, rubric.safety?.blockingSecretClasses);
  audit.instructions = instructionItems(local.tree, profile);
  for (const item of audit.instructions.filter((i) => i.staticResult === "fail")) {
    const ev = addEvidence(audit, { checkId: "context.instructions_verified", condition: "instructions", strength: "static", where: "static", result: "fail", summary: `${item.source}:${item.line} \`${item.text}\`: ${item.staticReason}` });
    item.evidenceId = ev.id;
  }
  const workingWaivers = join(repo, WAIVER_FILE);
  audit.waivers = loadWaivers(local.tree, rubric, today(), existsSync(workingWaivers) ? readFileSync(workingWaivers, "utf8") : null) ?? undefined;
  applyWaivers(audit);
  if (audit.waivers?.ignored) log(`Waivers: ${audit.waivers.ignored}.`);
  for (const r of audit.waivers?.rejected ?? []) log(`Waiver ${r.id} refused: ${r.reason}.`);
  const blocking = audit.safety.filter((s) => s.blocking);
  const { scanned, total } = bound.scope.secrets;
  // A secret scan the bound cut short can't show the repo is clean, only that it found none so far.
  const cutShort = !blocking.length && scanned < total ? `the secret scan read ${scanned} of ${total} files before the scan's ${boundMinutes}-minute bound (--budget-scan)` : undefined;
  addEvidence(audit, { checkId: "safety.execution_boundary", condition: "safety", strength: "static", where: "static", result: blocking.length ? "fail" : cutShort ? "not_run" : "pass", summary: blocking.length ? blocking.map((b) => `${b.file}${b.line ? ":" + b.line : ""} ${b.detail}`).join("; ") : cutShort ? `no blocking findings in the files read; ${cutShort}` : `no blocking findings; ${audit.safety.length} ${audit.safety.length === 1 ? "item" : "items"} listed for review`, ...(cutShort ? { blocked: cutShort } : {}) });
  if (profile.components.some((c) => c.assessed)) addEvidence(audit, { checkId: "bootstrap.cold_replay", condition: "toolchain", component: "*", strength: "static", where: "static", result: profile.toolchain.pinned ? "pass" : "fail", summary: profile.toolchain.pinned ? `toolchain pinned in ${profile.toolchain.files.join(", ")}` : `missing ${profile.toolchain.missing.join(" and ")}` });
  audit.assets = inventory(repo, local.tree, audit.instructions, bound);
  const sampled = sampledScope(audit);
  if (sampled) log(`Sampled: ${sampled}.`);
  if (bound.scope.fileCap) {
    const unreached = capCutFolders(audit);
    log(`Warning: the scan stops at ${bound.scope.fileCap.toLocaleString("en-US")} files, and this commit tracks more. ${unreached.length ? `It didn't list everything in ${unreached.slice(0, 8).join(", ")}${unreached.length > 8 ? ` and ${unreached.length - 8} more` : ""}, so components there may be missing from this audit; each is listed as not assessed.` : "Components in the files past the cap are missing from this audit."}`);
  }
  const assessedIds = new Set(profile.components.filter((c) => c.assessed).map((c) => c.id));
  const agentCmds = audit.contract.filter((c) => c.source !== "readiness" && !c.source.includes("scripts.") && !c.source.startsWith(".cursor/environment.json") && !isConfigCommand(c));
  for (const c of agentCmds.filter((x) => x.component !== "*" && !assessedIds.has(x.component))) log(`Dropped ${c.id} (${c.command}): ${c.component} isn't an assessed component after this scan.`);
  audit.contract = [...discoverContract(profile, local.tree, rubric, audit.safety), ...agentCmds.filter((x) => x.component === "*" || assessedIds.has(x.component))];
  const workingConfig = join(repo, CONFIG_FILE);
  const config = loadCommandConfig(local.tree, profile, existsSync(workingConfig) ? readFileSync(workingConfig, "utf8") : null);
  if (config) {
    for (const line of applyCommandConfig(audit.contract, config, profile)) log(`${line}.`);
    if (config.ignored) log(`Command config: ${config.ignored}.`);
    for (const r of config.rejected) log(`Command config ${r.at} refused: ${r.reason}`);
    audit.commandConfig = { digest: config.digest, entries: config.entries.map(({ line: _line, ...e }) => e), rejected: config.rejected, ignored: config.ignored };
  } else delete audit.commandConfig;
  audit.signals = staticSignals(local.tree, profile, audit.contract);
  saveDraft(p, audit);
  log(`Scanned ${audit.repo.name}: ${profile.repoType}, package manager ${profile.packageManager ?? "none"}.`);
  for (const c of profile.components) log(`  ${c.id.padEnd(14)} ${String(Math.round(c.changeShare * 100)).padStart(3)}% of changes  ${c.assessed ? "assessed" : `not assessed: ${c.notAssessedReason}`}`);
  const agentWork = agentHistory(repo);
  if (agentWork && audit.tier !== "external-systems") log(`Agent work in the history (${agentWork}). Offer --tier external-systems so the report can measure agent PRs against other PRs; it reads pull requests through gh.`);
  log(`Contract: ${audit.contract.length} commands. Instructions: ${audit.instructions.length} items, ${instructionCounts(audit, rubric)}. Safety: ${blocking.length} blocking, ${audit.safety.length - blocking.length} listed.`);
  if (a.flags.strict) {
    // Only an item that holds a level fails the check; a wrong README line or path is listed in the report.
    const wrong = audit.instructions.filter((i) => i.result === "fail" && gatingInstruction(rubric, i));
    for (const i of wrong) log(`  wrong instruction ${i.source}:${i.line} \`${i.text}\`: ${i.reason}`);
    for (const s of blocking) log(`  blocking safety finding ${s.file}${s.line ? ":" + s.line : ""}: ${s.detail}`);
    if (wrong.length || blocking.length) fail("Static checks failed.", 1);
  }
}

function cmdContract(a: Args): void {
  const repo = repoOf(a);
  const { audit, local, paths: p } = loadDraft(repo);
  const sub = a.positional[1] ?? "list";
  if (sub === "add") {
    const cmd = addContractCommand(audit.contract, {
      kind: str(a, "kind") as CommandKind,
      component: str(a, "component"),
      cwd: str(a, "cwd", "."),
      command: str(a, "cmd"),
      source: str(a, "source", "agent"),
      reason: str(a, "reason"),
    }, audit.profile, commitReader(repo, audit.repo.commit));
    saveDraft(p, audit);
    log(`Added ${cmd.id}: ${cmd.command}`);
    return;
  }
  for (const c of audit.contract) log(`${c.id.padEnd(24)} ${c.kind.padEnd(9)} ${c.cwd.padEnd(18)} ${c.command}   (${c.source})`);
}

function cmdScenario(a: Args): void {
  const repo = repoOf(a);
  const { audit, paths: p } = loadDraft(repo);
  const sub = a.positional[1] ?? "list";
  audit.scenarios ??= [];
  if (sub === "add" || sub === "remove") {
    const id = a.positional[2] as ScenarioId;
    if (!SCENARIOS.includes(id)) fail(`Usage: readiness scenario ${sub} <${SCENARIOS.join("|")}>${sub === "add" ? " [--components a,b]" : ""}`);
    audit.scenarios = audit.scenarios.filter((s) => s.id !== id);
    if (sub === "add") {
      const components = csv(opt(a, "components"));
      if (components.length && !audit.profile) fail("Run `readiness scan` first: a scenario names components the scan found.");
      const assessed = audit.profile!.components.filter((x) => x.assessed).map((x) => x.id);
      for (const c of components) {
        const found = audit.profile!.components.find((x) => x.id === c);
        const choices = assessed.length ? `Use one of: ${assessed.join(", ")}.` : "No component was assessed.";
        if (!found) fail(`No component named ${c}. ${choices}`);
        if (!found.assessed) fail(`${c} isn't assessed (${found.notAssessedReason ?? "not supported"}), so it has no level for a scenario to break down. ${choices}`);
      }
      audit.scenarios.push({ id, components: components.length ? components : ["*"] });
      log(`Added the ${id} scenario for ${components.length ? components.join(", ") : "every assessed component"}. It's reported under ${components.length === 1 ? "that component" : "those components"}, next to the standard level.`);
    } else log(`Removed the ${id} scenario.`);
    saveDraft(p, audit);
    return;
  }
  if (audit.scenarios.length === 0) log("No scenarios: the report gives one standard level per component and a repo rollup.");
  for (const s of audit.scenarios) log(`${s.id}: ${s.components.includes("*") ? "every assessed component" : s.components.join(", ")}`);
}

async function cmdRun(a: Args): Promise<void> {
  const repo = repoOf(a);
  const { audit, local, paths: p } = loadDraft(repo);
  requireTier(audit, "local-exec", "run");
  if (!audit.profile) fail("Run `readiness scan` first.");
  const rubric = loadRubric(audit.rubric);
  // Asked before the copy is made, so a refused run leaves no copy of the repo behind.
  if (!hostAllowed()) fail(`This runs the repo's commands on this machine, outside a container, which needs the user's yes first: ${HOST_NOT_ALLOWED}. Ask the user, then rerun with --allow-host.`);
  const registryValues = registryValuesOf(audit);
  const component = opt(a, "component");
  if (component) checkComponent(audit.profile, component);
  if (opt(a, "cmd")) {
    const cmd = addContractCommand(audit.contract, { kind: str(a, "kind") as CommandKind, component: str(a, "component"), cwd: str(a, "cwd", "."), command: str(a, "cmd"), source: str(a, "source", "agent"), reason: str(a, "reason") }, audit.profile, commitReader(repo, audit.repo.commit));
    log(`Added ${cmd.id} to the contract.`);
  }
  const id = opt(a, "id");
  const selected = audit.contract.filter((c) => (id ? c.id === id : true) && (!component || c.component === component || c.component === "*") && c.kind !== "start");
  const comps = new Set(audit.profile.components.filter((c) => c.assessed && (!component || c.id === component)).map((c) => c.id));
  const scratch = scratchTree(repo, audit.repo.commit);
  let ex: ReturnType<typeof hostExecutor> | null = null;
  try {
    ex = hostExecutor(scratch.dir, audit.environment.registryEnv, audit.environment.inheritEnv, "host");
    const results = await runContract(ex, selected, { components: comps, budget: newBudget(rubric.budgets.componentMinutes, rubric.budgets.totalMinutes), registryValues });
    for (const r of results) {
      const ev = evidenceFromPhase(audit, ex, r, registryValues);
      log(`  ${r.cmd.kind.padEnd(9)} ${r.cmd.component.padEnd(12)} ${verdictWord(ev, rubric)}${r.diagnosis ? ` (${r.diagnosis.detail})` : ""}`);
    }
    recordHostConsent(audit, repo);
    if (a.flags.instructions) {
      for (const item of audit.instructions.filter((i) => i.category === "replay" && i.staticResult === "pass")) {
        const out = await ex.exec(item.text, ".", 300);
        const ok = out.exitCode === 0 && !out.timedOut;
        const redacted = redact(out.output, registryValues);
        const ev = addEvidence(audit, { checkId: "context.instructions_verified", condition: "instructions", strength: "executed", where: "host", result: ok ? "pass" : "fail", command: item.text, exitCode: out.exitCode, outputTail: redacted.slice(-1500), outputDigest: sha256(redacted), summary: `${item.source}:${item.line} \`${item.text}\` ${ok ? "replays" : "fails"}` });
        const prior = audit.evidence.find((e) => e.id === item.evidenceId);
        if (prior && (prior.where === "container" || prior.where === "fresh_copy")) {
          log(`  ${item.source}:${item.line} ${item.text}: ${ok ? "pass" : "fail"} on the host; the replay's ${item.result} stands`);
          continue;
        }
        // Like the replay's host fallback: this machine isn't a clean environment, so a failure here
        // leaves the instruction unproven rather than wrong.
        item.result = ok ? "pass" : "not_run";
        if (ok) delete item.blocked;
        else {
          item.reason = `not proven: it failed on this machine (exit ${out.exitCode ?? "none"}${out.timedOut ? ", timed out" : ""}), and only a clean container can show an instruction is wrong`;
          item.blocked = "it ran on this machine, not in a clean container";
        }
        item.evidenceId = ev.id;
        log(`  ${item.source}:${item.line} ${item.text}: ${ok ? "pass" : "not proven, failed on this machine"}`);
      }
    }
  } finally {
    ex?.close();
    scratch.dispose();
  }
  saveDraft(p, audit);
}

async function cmdReplay(a: Args): Promise<void> {
  const repo = repoOf(a);
  const { audit, local, paths: p } = loadDraft(repo);
  const rubric = loadRubric(audit.rubric);
  const before = audit.evidence.length;
  try {
    await replay(audit, repo, local.tree, rubric, {
      component: opt(a, "component"),
      mutants: !a.flags["no-mutants"],
      instructions: !a.flags["no-instructions"],
      runtime: str(a, "runtime", process.env.SA_READINESS_RUNTIME || "auto"),
      image: opt(a, "image") ?? (process.env.SA_READINESS_IMAGE || undefined),
      budgetComponentMinutes: Number(str(a, "budget-component", String(rubric.budgets.componentMinutes))),
      budgetTotalMinutes: Number(str(a, "budget-total", String(rubric.budgets.totalMinutes))),
      log,
    });
  } catch (e) {
    // Whatever ran before the error is real evidence; keep it so `status` and a rerun can use it.
    if (audit.evidence.length > before) {
      saveDraft(p, audit);
      log(`Kept ${audit.evidence.length - before} results from before the error.`);
    }
    throw e;
  }
  saveDraft(p, audit);
}

function cmdRecord(a: Args): void {
  const repo = repoOf(a);
  const { audit, paths: p } = loadDraft(repo);
  const ev = recordObservation(audit, loadRubric(audit.rubric), { checkId: str(a, "check"), component: opt(a, "component"), result: str(a, "result") as Result, strength: str(a, "strength", "static") as Strength, summary: str(a, "summary") });
  saveDraft(p, audit);
  log(`Recorded ${ev.id} (${ev.strength}).`);
}

function lockPatterns(audit: Audit): string[] {
  return ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"].filter((f) => !audit.profile?.lockfiles.includes(f));
}

async function cmdOutcomes(a: Args): Promise<void> {
  const repo = repoOf(a);
  const { audit, paths: p } = loadDraft(repo);
  if (!audit.profile) fail("Run `readiness scan` first.");
  const rubric = loadRubric(audit.rubric);
  const d = rubric.outcomes.defaultFilter;
  const filter = {
    branchPrefixes: opt(a, "branch-prefix") !== undefined ? csv(opt(a, "branch-prefix")) : d.branchPrefixes,
    labels: opt(a, "label") !== undefined ? csv(opt(a, "label")) : d.labels,
    authors: opt(a, "author") !== undefined ? csv(opt(a, "author")) : d.authors,
    coAuthorTrailers: opt(a, "co-author") !== undefined ? csv(opt(a, "co-author")) : d.coAuthorTrailers,
  };
  const days = Number(str(a, "window-days", String(rubric.outcomes.windowDays)));
  let prs;
  let source: "gh" | "file";
  let truncated = false;
  let reverts: { unavailable?: string; limited?: string } | undefined;
  const input = opt(a, "input");
  if (input) {
    prs = loadPrsFile(resolve(input));
    source = "file";
  } else {
    requireTier(audit, "external-systems", "Reading pull requests from GitHub");
    if (!ghAvailable()) fail("gh isn't authenticated. Run `gh auth login`, or pass --input with a recorded PR file.");
    const slug = opt(a, "repo-slug") ?? ghJson<{ nameWithOwner: string }>(["repo", "view", "--json", "nameWithOwner"], repo).nameWithOwner;
    ({ prs, truncated, reverts } = await fetchPrs(slug, days, MAX_PRS, { reverts: rubric.outcomes.revertDays !== undefined }));
    source = "gh";
  }
  audit.outcomes = computeOutcomes(prs, audit.profile.components, rubric, filter, days, source, lockPatterns(audit), truncated, reverts);
  saveDraft(p, audit);
  const o = audit.outcomes;
  log(`Outcomes ${o.window.from} to ${o.window.to}: ${o.agent.opened} agent PRs (${o.agent.merged} merged), ${o.control.opened} other PRs. Filter: ${JSON.stringify(filter)}.`);
  if (source === "file") log("Outcomes from a recorded PR file make this an eval audit: verify-seal won't accept it as a production result.");
  if (truncated) log(`GitHub's search returns at most ${MAX_PRS} PRs and the window holds more, so Level 3 isn't measured from it. Pass a shorter --window-days.`);
  if (o.filesIncomplete) log(`${o.filesIncomplete} agent ${o.filesIncomplete === 1 ? "PR changes" : "PRs change"} more files than GitHub lists, so ${o.filesIncomplete === 1 ? "it isn't" : "they aren't"} counted toward any component.`);
}

const SLOTS_HINT = "Narration picks ids from the report model, and the report writes the words from the audit's own records. Run `readiness status` for the choices, and say anything else in your reply.";

function cmdNarrate(a: Args): void {
  const repo = repoOf(a);
  const { audit, paths: p } = loadDraft(repo);
  if (!audit.profile) fail("Run `readiness scan` before narrating.");
  const text = ["headline", "gap", "title"].filter((f) => opt(a, f));
  if (text.length) fail(`narrate takes no text (--${text.join(", --")}). ${SLOTS_HINT}`, 2);
  const n: Narration = opt(a, "file") ? readJson<Narration>(resolve(str(a, "file"))) : { ...(audit.narration ?? {}) };
  if (opt(a, "lead")) n.lead = str(a, "lead");
  if (opt(a, "cause")) {
    const cause = str(a, "cause");
    const at = cause.indexOf("=");
    n.cause = { condition: (at < 0 ? cause : cause.slice(0, at)) as CondId, evidence: at < 0 ? "" : cause.slice(at + 1) };
  }
  if (opt(a, "works")) n.works = csv(opt(a, "works"));
  if (opt(a, "ask")) n.ask = str(a, "ask");
  const rubric = loadRubric(audit.rubric);
  const draft = JSON.parse(JSON.stringify({ ...audit, narration: n })) as Audit;
  const preview = buildSealedReport(draft, rubric, readHistory(p), readRoadmap(p), repo, "");
  const errors = slotErrors(n, preview.choices);
  if (!errors.length && n.works?.length && !preview.report.executive.headline.includes(WORKS_LEAD)) errors.push("works would take the headline past its word limit; choose fewer");
  if (errors.length) fail(`Narration refused:\n- ${errors.join("\n- ")}\n${SLOTS_HINT}`, 2);
  audit.narration = n;
  saveDraft(p, audit);
  log(`Narration saved. Part 1 now reads:\n  Headline: ${preview.report.executive.headline}\n  Ask: ${preview.report.executive.ask}`);
}

// One wording for a level wherever status prints it, matching part 4 of the report.
function levelText(row: { level: Level | null; couldBe: Level | null; unproven: boolean; status?: string; settleBy?: { text: string } | null } | undefined): string {
  if (!row) return "not assessed";
  return row.status === "undetermined" && row.settleBy ? `${levelResult(row)}; to settle it: ${row.settleBy.text}` : levelResult(row);
}

// Wrong items that gate, and those listed for the reader, as the scan's summary line counts them.
function instructionCounts(audit: Audit, rubric: Rubric): string {
  const wrong = audit.instructions.filter((i) => i.result === "fail");
  const gating = wrong.filter((i) => gatingInstruction(rubric, i)).length;
  return `${gating} wrong${wrong.length > gating ? `, ${wrong.length - gating} wrong outside the agent files, listed` : ""}`;
}

// A row's verdict as `status` prints it, with why it is blocked or where it ran.
function statusWord(e: Audit["evidence"][number], rubric: Rubric): string {
  const j = judge(e, rubric);
  return j.verdict === "blocked" ? `blocked (${blockedBy(e) ?? j.reason})` : `${VERDICT_WORD[j.verdict]} (${e.result === "not_run" ? "not run" : e.strength})`;
}

function cmdStatus(a: Args): void {
  const repo = repoOf(a);
  const { audit, paths: p } = loadDraft(repo);
  const rubric = loadRubric(audit.rubric);
  const comps = audit.profile?.components.filter((c) => c.assessed) ?? [];
  // The ids narration may use, from the report the seal would build right now.
  const preview = audit.profile ? buildSealedReport(JSON.parse(JSON.stringify(audit)) as Audit, rubric, readHistory(p), readRoadmap(p), repo, "") : null;
  const part1 = preview ? { heading: preview.report.executive.heading, headline: preview.report.executive.headline, ask: preview.report.executive.ask, gaps: preview.report.executive.gaps.map((g) => ({ itemId: g.itemId, text: g.text })), roadmapItems: preview.roadmap.items.map((i) => i.id) } : null;
  const levels = preview?.report.components.included ?? [];
  const summary = {
    id: audit.id,
    tier: audit.tier,
    commit: audit.repo.commit.slice(0, 7),
    environment: audit.environment,
    repoLevel: preview ? (preview.report.maturity.outcome === "not_assessed" ? "not assessed" : levelText(preview.report.maturity)) : null,
    scenarios: audit.scenarios ?? [],
    components: comps.map((c) => {
      const s = componentStates(audit, rubric, c.id);
      const row = levels.find((x) => x.id === c.id);
      return {
        id: c.id,
        changeShare: c.changeShare,
        conditions: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, `${v.state}: ${v.reason}`])),
        level: levelText(row),
        scenarios: Object.fromEntries((row?.scenarios ?? []).map((x) => [x.id, levelText(x)])),
      };
    }),
    contract: audit.contract.map((c) => `${c.id}: ${c.command}`),
    evidence: audit.evidence.map((e) => `${e.id} ${e.checkId} ${e.component ?? ""} ${statusWord(e, rubric)}: ${e.summary}`),
    instructionsWrong: audit.instructions.filter((i) => i.result === "fail").map((i) => `${i.source}:${i.line} ${i.text}: ${i.reason}`),
    safety: audit.safety.map((s) => `${s.blocking ? "BLOCKING" : "listed"} ${s.kind} ${s.file}${s.line ? ":" + s.line : ""}: ${s.detail}`),
    outcomes: audit.outcomes ? { window: audit.outcomes.window, agent: audit.outcomes.agent.opened, control: audit.outcomes.control.opened } : null,
    part1,
    narration: preview ? { chosen: audit.narration, choices: preview.choices } : null,
  };
  if (a.flags.json) log(JSON.stringify(summary, null, 2));
  else {
    log(`${summary.id} (${summary.tier}) at ${summary.commit}. Repo level: ${summary.repoLevel ?? "not computed"}`);
    for (const c of summary.components) log(`  ${c.id}: ${c.level}${Object.keys(c.scenarios).length ? `; scenarios ${Object.entries(c.scenarios).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}\n    ${Object.entries(c.conditions).map(([k, v]) => `${k} ${v}`).join("\n    ")}`);
    if (summary.instructionsWrong.length) log(`Wrong instructions:\n  ${summary.instructionsWrong.join("\n  ")}`);
    if (summary.safety.length) log(`Safety:\n  ${summary.safety.join("\n  ")}`);
    if (part1) {
      log(`Part 1 now: ${part1.heading}\n  Headline: ${part1.headline}\n  Ask: ${part1.ask}`);
      if (part1.gaps.length) log(`Part 1 gaps:\n  ${part1.gaps.map((g) => `${g.itemId}: ${g.text}`).join("\n  ")}`);
    }
    if (preview) log(narrationText(preview.choices));
  }
}

// The slots narrate accepts, each with what part 1 would say for it.
function narrationText(ch: NarrationChoices): string {
  const lines = ["Narration choices (readiness narrate --lead <id> --cause <condition>=<evidence> --works <id,id> --ask <id>):"];
  lines.push(`  lead: ${ch.lead.join(", ") || "none"}`);
  lines.push(ch.cause.length ? `  cause:\n${ch.cause.map((c) => `    ${c.condition}=${c.evidence} (${c.component}): ${c.summary.slice(0, 160)}`).join("\n")}` : "  cause: none");
  lines.push(ch.works.length ? `  works:\n${ch.works.map((w) => `    ${w.evidence}: ${w.says}`).join("\n")}` : "  works: none");
  lines.push(ch.ask.length ? `  ask:\n${ch.ask.map((x) => `    ${x.id}: ${x.says}`).join("\n")}` : "  ask: none");
  return lines.join("\n");
}

function cmdSeal(a: Args): void {
  const repo = repoOf(a);
  const { audit, local, paths: p } = loadDraft(repo);
  const r = seal(audit, local, p, log);
  log(`Report: ${join(p.latest, "report.md")}`);
  log(`Stored: ${r.dir}`);
  log(`Headline: ${r.report.executive.headline}`);
  if (PREVIEW) log(PREVIEW);
}

// When the audited commit's tree differs from HEAD's outside .agent-readiness/, the sealed report
// describes an older tree: a level read from it isn't HEAD's.
function staleAuditNote(repo: string, audit: Audit): string | null {
  const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
  if (!head || head === audit.repo.commit) return null;
  const same = git(["diff", "--quiet", "--no-ext-diff", "--no-textconv", audit.repo.commit, head, "--", ".", ":(exclude).agent-readiness"], repo).ok;
  if (same) return null;
  const n = Number(git(["rev-list", "--count", `${audit.repo.commit}..${head}`], repo).stdout.trim()) || 0;
  return `NOTE: ${audit.id} audited ${audit.repo.commit.slice(0, 7)}; HEAD (${head.slice(0, 7)}) is ${n ? `${n} commit${n === 1 ? "" : "s"} later and ` : ""}different code, so this report doesn't describe HEAD. Run a new audit, or \`readiness recheck\` to rerun its commands on HEAD in a clean container.`;
}

function cmdVerify(a: Args): void {
  const p = paths(repoOf(a));
  const { audit } = loadSealedAudit(p, a.positional[1] ?? "latest");
  const stale = staleAuditNote(p.repo, audit);
  if (stale) log(stale);
  const r = verifySeal(p, audit.id, { releaseRepo: opt(a, "release-repo"), releaseRef: opt(a, "release-ref"), tierExternal: opt(a, "tier") === "external-systems" || audit.tier === "external-systems", allowUnkeyed: Boolean(a.flags["allow-unkeyed"]) });
  for (const l of r.lines) log(l);
  if (!r.ok) fail("Seal verification failed.", 2);
  if (!r.production && !a.flags["allow-eval"]) fail(`This is an eval audit (${audit.seed.pinned ? "pinned seed" : "outcomes from a recorded PR file"}), not a production result. Pass --allow-eval to accept it.`, 3);
}

async function cmdRecheck(a: Args): Promise<void> {
  const p = paths(repoOf(a));
  const r = await recheck(p, { runtime: str(a, "runtime", process.env.SA_READINESS_RUNTIME || "auto"), image: opt(a, "image") ?? (process.env.SA_READINESS_IMAGE || undefined), log });
  log(`Recheck ${r.line.id}: ${r.line.result}${r.line.note ? ` (${r.line.note})` : ""}. ${r.line.noLevel ? "Repo level: not assessed on this machine." : `Repo level: ${r.line.repoLevel}; components: ${JSON.stringify(r.line.levels)}.`}`);
  if (r.line.result === "failed") process.exitCode = 1;
}

function cmdDiff(a: Args): void {
  const p = paths(repoOf(a));
  const from = loadSealedAudit(p, a.positional[1] ?? "previous").audit;
  const to = loadSealedAudit(p, a.positional[2] ?? "latest").audit;
  const history = readHistory(p);
  const d = compareAudits(p.repo, from, to, history.find((h) => h.id === from.id), history.find((h) => h.id === to.id));
  const stale = a.flags.json ? null : staleAuditNote(p.repo, to);
  if (stale) log(stale);
  if (a.flags.json) log(JSON.stringify(d, null, 2));
  else {
    log(`${d.from} -> ${d.to}${d.rubricChanged ? ` (rubric ${d.rubricChanged.from} -> ${d.rubricChanged.to})` : ""}`);
    for (const l of d.levels) log(`  ${l.component} ${l.activity}: ${l.from} -> ${l.to}`);
    const flags = weakeningFlags(d.weakening);
    log(flags.length ? `  Review: ${flags.join(", ")}` : "  No weakened-test flags.");
  }
  if (weakeningFlags(d.weakening).some((f) => f !== "CI changed")) process.exitCode = 1;
}

function cmdHistory(a: Args): void {
  const p = paths(repoOf(a));
  if (a.positional[1] === "push") {
    log(pushHistory(p, { push: Boolean(a.flags.push), remote: str(a, "remote", "origin") }));
    return;
  }
  const lines = readHistory(p);
  if (a.flags.json) log(JSON.stringify(lines, null, 2));
  else for (const h of lines) log(`${h.date} ${h.kind.padEnd(7)} ${h.result.padEnd(6)} ${h.id} repo ${h.noLevel ? "not assessed" : h.repoLevel}${h.note ? ` (${h.note})` : ""}`);
}

// Targets are scored by the audit they apply to: the open draft, else the last sealed audit. Only
// a repo with neither falls back to the rubric new audits use.
function auditRubric(p: ReturnType<typeof paths>): string | undefined {
  const draft = currentDraftId(p);
  if (draft) return loadDraft(p.repo, draft).audit.rubric;
  const last = readHistory(p).filter((h) => h.kind === "audit").at(-1);
  return last?.rubric;
}

function cmdRoadmap(a: Args): void {
  const p = paths(repoOf(a));
  const sub = a.positional[1] ?? "show";
  const rm: Roadmap = readRoadmap(p) ?? { schema: "agent-readiness/roadmap@1", owner: null, targets: null, items: [], updatedBy: "manual", updatedAt: nowIso() };
  if (sub === "owner") {
    const owner = a.positional[2];
    if (!owner) fail('Usage: readiness roadmap owner "<team or role>"');
    rm.owner = owner;
    writeRoadmap(p, rm);
    log(`Owner set to ${owner}.`);
    return;
  }
  if (sub === "targets") {
    const rubric = loadRubric(auditRubric(p));
    const minPrs = Number(str(a, "min-prs", String(rubric.level3.minAgentPRs)));
    if (minPrs < rubric.level3.absoluteMinAgentPRs) fail(`--min-prs can't go below ${rubric.level3.absoluteMinAgentPRs}.`);
    rm.targets = { mergeRate: Number(str(a, "merge-rate")), firstPass: Number(str(a, "first-pass")), maxChangesRequested: Number(str(a, "max-changes-requested")), minAgentPrs: minPrs };
    for (const [k, v] of Object.entries(rm.targets)) if (Number.isNaN(v) || (k !== "minAgentPrs" && (v < 0 || v > 1))) fail(`Target ${k} must be a number between 0 and 1.`);
    writeRoadmap(p, rm);
    log(`Level 3 targets recorded: ${JSON.stringify(rm.targets)}.`);
    return;
  }
  if (a.flags.json) log(JSON.stringify(rm, null, 2));
  else for (const i of rm.items) log(`${String(i.order).padStart(2)}. [${i.status}] ${i.title} (${i.unlocks})`);
}

function latestOrDraft(repo: string, ref?: string): Audit {
  if (ref && ref !== "latest") return loadSealedAudit(paths(repo), ref).audit;
  return loadSealedAudit(paths(repo), "latest").audit;
}

function cmdDraftSkill(a: Args): void {
  if (!a.flags.remediate) fail("draft-skill writes into the repo, so it only runs in remediate mode: pass --remediate.");
  const repo = repoOf(a);
  const audit = latestOrDraft(repo, opt(a, "audit"));
  const out = str(a, "out", ".cursor/skills/verify/SKILL.md");
  const p = paths(repo);
  const earlier = readHistory(p)
    .filter((h) => h.kind === "audit" && h.id !== audit.id)
    .slice(-3)
    .map((h) => loadSealedAudit(p, h.id).audit);
  const { text, commands } = renderVerifySkill(audit, loadRubric(audit.rubric), csv(opt(a, "include")), earlier);
  const written = writeFiles(repo, { [out]: text }, Boolean(a.flags.force));
  log(`Wrote ${written.join(", ")} from ${commands.length} commands that passed in ${audit.id}. Prove it with \`readiness recheck\` after committing.`);
}

function cmdDraftEnv(a: Args): void {
  if (!a.flags.remediate) fail("draft-env writes into the repo, so it only runs in remediate mode: pass --remediate.");
  const repo = repoOf(a);
  const audit = latestOrDraft(repo, opt(a, "audit"));
  const fromDiag = [...new Set(audit.evidence.filter((e) => e.diagnosis?.cause === "service" && e.diagnosis.service).map((e) => serviceKey(e.diagnosis!.service!)).filter((s): s is string => Boolean(s)))];
  const compose = composeServices(repo);
  const services = opt(a, "service") ? csv(opt(a, "service")) : [...new Set([...fromDiag, ...(compose?.services ?? [])])];
  const envExample = exists(join(repo, ".env.example"));
  const env = renderEnvFiles(audit, services, { dockerfile: Boolean(a.flags.dockerfile), envExample });
  const written = writeFiles(repo, env.files, Boolean(a.flags.force));
  log(`Wrote ${written.join(", ")}${services.length ? ` for ${services.join(", ")}` : ""}.`);
  if (compose?.services.length && !opt(a, "service")) log(`${compose.file} runs ${compose.services.join(", ")}; the start script starts ${compose.services.length === 1 ? "it" : "them"} without Docker.`);
  if (envExample) log("The install script copies .env.example to .env when there is no .env, so tests get its local defaults.");
  log("Commit these on a branch, then run a new audit to prove them. Committing .cursor/environment.json doesn't change a Cloud Agent environment by itself: a team admin has to point the environment at it.");
}

function cmdAssets(a: Args): void {
  const repo = repoOf(a);
  const org = opt(a, "org");
  if (org) {
    const tier = (opt(a, "tier") ?? "local-exec") as Tier;
    if (tier !== "external-systems") fail("--org reads GitHub, so it needs --tier external-systems.");
    const r = orgSkillBuilders(org, Number(str(a, "max-repos", "200")));
    if (a.flags.json) log(JSON.stringify(r, null, 2));
    else {
      log(`Skill builders in ${org} (${r.label}; ${r.reposScanned} repos, ${r.skillFiles} skills${r.capped ? ", capped" : ""}):`);
      for (const b of r.builders) log(`  ${b.name}: ${b.skillsWritten} skills written, ${b.recentCommits} commits in 90 days, in ${b.repos.length} repos`);
    }
    return;
  }
  const { audit } = loadDraft(repo);
  for (const x of audit.assets) log(`${x.kind.padEnd(12)} ${x.path.padEnd(48)} ${x.authors.map((y) => `${y.name} (${y.commits})`).join(", ")}  ${x.status}`);
}

function cmdFeedback(a: Args): void {
  const repo = repoOf(a);
  const p = paths(repo);
  const check = a.positional[1];
  if (!check) fail('Usage: readiness feedback <check-id> --note "..."');
  const audit = loadSealedAudit(p, opt(a, "audit") ?? "latest").audit;
  const rubric = loadRubric(audit.rubric);
  if (!rubric.checks.some((c) => c.id === check)) fail(`Unknown check ${check}`);
  const id = `fb-${today()}-${randomHex(3)}`;
  const bundle = {
    schema: "agent-readiness/feedback@1",
    id,
    createdAt: nowIso(),
    rubric: audit.rubric,
    skillVersion: audit.skill.version,
    scriptsDigest: audit.skill.scriptsDigest,
    audit: audit.id,
    check,
    component: opt(a, "component") ?? null,
    evidence: audit.evidence.filter((e) => e.checkId === check && (!opt(a, "component") || e.component === opt(a, "component"))).map((e) => ({ id: e.id, result: e.result, strength: e.strength, outputDigest: e.outputDigest ?? null })),
    note: redact(str(a, "note")),
  };
  const f = join(p.feedback, `${id}.json`);
  writeJson(f, bundle);
  log(`Wrote ${f}. It holds the rubric version, check, evidence digests and your note, and no source code. Send it to the account team.`);
}

function cmdGuard(a: Args): void {
  const repo = repoOf(a);
  const sub = a.positional[1] ?? "status";
  if (sub === "install") {
    const r = installGuard(repo);
    if (r.status === "tracked") log(`${HOOKS_FILE} is committed in this repo, so it was left alone. To refuse the repo's own commands on this machine during an audit, add this command as a beforeShellExecution and a beforeReadFile hook: node --experimental-strip-types --no-warnings .cursor/skills/agent-readiness/scripts/guard.ts`);
    else log(`${r.status === "installed" ? "Added" : "Already in place:"} the readiness guard in ${HOOKS_FILE}, kept out of git. While an audit's session is open, it refuses the repo's own install, build and test commands on this machine until the user's yes is recorded with \`readiness allow-host\`, and at any time once the draft is open, and reads of the audit's draft records and planted faults. Outside a session it lets everything run. New agent sessions on this machine load it; a cloud agent, which starts from the committed tree, never does. \`readiness guard uninstall\` takes it out.`);
    return;
  }
  if (sub === "uninstall") {
    const r = uninstallGuard(repo);
    if (r.status === "tracked") log(`${HOOKS_FILE} is committed in this repo, so the guard never changed it. Remove its hook entries there if you added them.`);
    else log(r.status === "removed" ? `Removed the readiness guard: ${HOOKS_FILE} and the exclude file are as they were before \`guard install\`.` : "The readiness guard isn't installed here.");
    return;
  }
  if (sub !== "status") fail("Use `readiness guard install`, `readiness guard uninstall` or `readiness guard status`.");
  const l = lease(repo);
  const installed = guardInstalled(repo);
  const probe = installed ? probeGuard(repo) : null;
  if (probe && !probe.answers) {
    log(`Guard listed in ${HOOKS_FILE}, but ${probe.detail}, so it enforces nothing. Cursor runs it with its own PATH, which needs Node ${MIN_NODE.join(".")} or later.`);
    return;
  }
  log(`Guard ${installed ? `installed in ${HOOKS_FILE}` : "not installed"}. ${l.valid ? `Enforcing: session ${l.session!.id} is open${l.session!.auditId ? ` with draft ${l.session!.auditId}` : ""}, until ${l.session!.expiresAt}.` : `Not enforcing: ${l.why}.`}`);
}

function cmdSession(a: Args): void {
  const repo = repoOf(a);
  const sub = a.positional[1] ?? "status";
  if (sub === "start") {
    writeRecordsIgnore(paths(repo));
    const { session, renewed } = startSession(repo);
    log(`${renewed ? "Renewed" : "Opened"} session ${session.id} until ${session.expiresAt} (${LEASE_HOURS} hours, renewed by every audit step). The seal, \`readiness session end\` or expiry ends it.`);
    return;
  }
  if (sub === "end") {
    log(endSession(repo) ? "Ended the session. The guard no longer enforces here; any draft stays until `readiness init --force` or a seal." : "No session was open.");
    return;
  }
  if (sub !== "status") fail("Use `readiness session start`, `readiness session end` or `readiness session status`.");
  const l = lease(repo);
  if (a.flags.json) log(JSON.stringify({ valid: l.valid, why: l.why, session: l.session }, null, 2));
  else log(l.valid ? `Session ${l.session!.id} open until ${l.session!.expiresAt}${l.session!.auditId ? `, draft ${l.session!.auditId}` : ", no draft yet"}${l.session!.grant ? "; the user's yes to host mode is recorded" : ""}.` : `No session: ${l.why}.`);
}

function cmdAllowHost(a: Args): void {
  const repo = repoOf(a);
  const note = opt(a, "note");
  if (!note) fail("Pass --note with the user's words, for example --note \"yes, run npm test here\". Record a yes only after the user gives it.");
  writeRecordsIgnore(paths(repo));
  const s = recordGrant(repo, note, nowIso());
  log(`Recorded the user's yes to running repo commands on this machine in session ${s.id}. The seal ends the session and clears it, so the next audit asks again.`);
}

function cmdCleanup(a: Args): void {
  const r = cleanupLeftovers(paths(repoOf(a)), { images: Boolean(a.flags.images) });
  log(r.length ? `Removed ${r.length} leftover${r.length === 1 ? "" : "s"}:\n  ${r.join("\n  ")}` : "Nothing left behind by earlier audits.");
}

function cmdVersion(a: Args): void {
  const m = releaseManifest();
  log(`agent-readiness skill ${m?.version ?? "unreleased"} (${m?.tag ?? "no release manifest"}), rubric ${latestRubricVersion()}`);
  if (PREVIEW) log(PREVIEW);
  const upstream = opt(a, "upstream");
  if (upstream) {
    if (str(a, "tier", "local-exec") !== "external-systems") fail("--upstream reads GitHub, so it needs --tier external-systems.");
    const tags = ghJson<{ name: string }[]>(["api", `repos/${upstream}/tags`, "--paginate"]).map((t) => t.name).filter((t) => t.startsWith("agent-readiness-v")).sort();
    const latest = tags[tags.length - 1];
    if (!latest) log(`No agent-readiness release tags in ${upstream}.`);
    else if (m && latest !== m.tag) log(`STALE: this copy is ${m.tag}; ${upstream} has ${latest}. Copy the newer skill.`);
    else log(`Up to date with ${upstream} (${latest}).`);
  }
}

function cmdValidate(a: Args): void {
  const file = a.positional[1];
  if (!file) fail("Usage: readiness validate <file> [--kind audit|report|roadmap]");
  const data = readJson<Record<string, unknown>>(resolve(file));
  const schema = String(data.schema ?? "");
  const kind = (opt(a, "kind") ?? (schema.includes("report") ? "report" : schema.includes("roadmap") ? "roadmap" : "audit")) as "audit" | "report" | "roadmap";
  const errors = validateAgainst(kind, data);
  if (errors.length) fail(`${file} is not a valid ${kind}:\n- ${errors.join("\n- ")}`);
  log(`${file} is a valid ${kind}.`);
}

async function cmdAudit(a: Args): Promise<void> {
  cmdInit(a);
  cmdScan(a);
  if (loadDraft(repoOf(a)).audit.tier === "read-only") log("Read-only tier: scanned only. No repo code ran, so the report gives no level; a local-exec audit can prove one.");
  else await cmdReplay(a);
  if (opt(a, "outcomes-input") || (opt(a, "tier") === "external-systems" && !a.flags["no-outcomes"])) {
    // GitHub failing after the replay shouldn't throw away the replay or leave the draft open.
    try {
      await cmdOutcomes({ positional: a.positional, flags: { ...a.flags, ...(opt(a, "outcomes-input") ? { input: str(a, "outcomes-input") } : {}) } });
    } catch (e) {
      log(`Agent PR outcomes weren't measured: ${(e as Error).message.split("\n")[0]}. Sealing without them, so the report gives no Level 3 or 4. Run the audit again once GitHub answers.`);
    }
  }
  if (opt(a, "narration")) cmdNarrate({ positional: a.positional, flags: { ...a.flags, file: str(a, "narration") } });
  cmdSeal(a);
}

const HELP = `readiness <command> [options]

Audit
  init --tier <read-only|local-exec|external-systems> [--scenario first_pr,bug_fixes,features,repo_wide] [--registry-env A,B] [--inherit-env] [--force]
  scan [--strict] [--budget-scan M]   profile, agent assets, static checks and the verification contract; --strict exits 1 on wrong instructions or blocking safety findings; past M minutes (default ${SCAN_BOUND_MINUTES}) the secret scan and asset history are sampled
  contract [list|add --kind K --component C --cmd "..." --reason "..." [--cwd D] [--source file:line]]
  scenario [list|add <id> [--components a,b]|remove <id>]   optional breakdowns reported under the components they name
  replay [--component C] [--no-mutants] [--runtime auto|docker|none] [--image ref] [--memory MB] [--budget-component M] [--budget-total M]
  run [--component C] [--id cmd-id] [--instructions] [--cmd "..." --kind K --component C --reason "..."]
  record --check ID --result pass|fail|not_run --summary "..." [--component C] [--strength static|asserted]
  outcomes [--input prs.json] [--window-days 30] [--branch-prefix a,b] [--label L] [--author A] [--co-author T]
  narrate [--file narration.json] [--lead C] [--cause condition=ev-id] [--works ev-id,ev-id] [--ask item-id|settle]   picks the ids part 1's templates use; status lists them
  status [--json]
  seal
  audit --tier T [--scenario S] [--registry-env A,B] [--inherit-env] [--runtime auto|docker|none] [--image ref] [--no-mutants] [--outcomes-input f] [--narration f] [--budget-scan M] [--budget-total M] [--memory MB] [--force]   init, scan, replay, outcomes and seal in one go; --force abandons an open draft

--allow-host (replay, recheck, run, audit) lets repo commands run on the host when no container can,
in a scrubbed copy that can still read local files. It is not a sandbox: use it only with the user's approval.
--inherit-env (init, audit) passes this shell's variables to those host commands, except account credentials
such as cloud, GitHub and SSH ones; a container never inherits them.

After an audit
  verify-seal [audit-id|latest] [--release-repo owner/repo --release-ref tag --tier external-systems] [--allow-eval] [--allow-unkeyed]   with SA_READINESS_SEAL_KEY set, only keyed seals pass unless --allow-unkeyed
  recheck [--runtime auto|docker|none] [--image ref] [--memory MB]
  diff [from] [to] [--json]
  history [--json] | history push [--push] [--remote origin]
  roadmap [show|owner "<team>"|targets --merge-rate R --first-pass R --max-changes-requested R [--min-prs N]]   --min-prs defaults to 20 and never goes below 10
  draft-skill --remediate [--out .cursor/skills/verify/SKILL.md] [--include cmd-id,...] [--force]
  draft-env --remediate [--service postgres,redis] [--dockerfile] [--force]
  assets [--org owner --tier external-systems]
  feedback <check-id> --note "..." [--component C]
  version [--upstream owner/repo --tier external-systems]
  validate <file> [--kind audit|report|roadmap]
  session [start|end|status]          open the audit's session at preflight, before init; the seal ends it
  allow-host --note "..."             record the user's yes to running repo commands on this machine, for this session
  guard [install|uninstall|status]    opt-in shell hook that, during a session, refuses the repo's own commands on this machine until the user says yes
  cleanup [--images]                  remove abandoned drafts, temp trees and containers earlier audits left; --images also the built environment images
`;

// When this invocation began. With `at`, its end, a reader can tell which records it wrote while a
// shell that moved it to the background ran other commands.
const STARTED_AT = nowIso();

function logInvocation(argv: string[], code: number): void {
  try {
    const repo = resolveRepo(process.cwd());
    const p = paths(repo);
    if (!exists(p.records)) return;
    appendFileSync(join(p.records, "cli.log"), JSON.stringify({ started: STARTED_AT, at: nowIso(), argv: argv.map((x) => redact(x)), code }) + "\n");
  } catch {
    return;
  }
}

function assertNodeVersion(version = process.versions.node): void {
  const [major, minor] = version.split(".").map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) fail(`The audit needs Node.js ${MIN_NODE.join(".")} or later for type stripping; this is ${version}. Install a newer Node (for example \`nvm install 22\`) and run it again.`);
}

// `readiness status | head` closes the pipe early; that's the reader being done, not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw e;
});

async function main(): Promise<void> {
  assertNodeVersion();
  assertPlatformSupported();
  const a = parse(process.argv.slice(2));
  if (a.flags["allow-host"]) process.env[ALLOW_HOST_ENV] = "1";
  // The container's memory, for a build or test suite that the default share stops (replay, recheck, audit).
  const memory = opt(a, "memory");
  if (memory) {
    process.env[MEMORY_ENV] = memory;
    memoryOverride();
  }
  const cmd = a.positional[0];
  if (!cmd || a.flags.help || cmd === "help") {
    process.stdout.write(PREVIEW ? `${PREVIEW}\n\n${HELP}` : HELP);
    return;
  }
  const table: Record<string, (a: Args) => void | Promise<void>> = {
    init: cmdInit,
    scan: cmdScan,
    contract: cmdContract,
    scenario: cmdScenario,
    run: cmdRun,
    replay: cmdReplay,
    record: cmdRecord,
    outcomes: cmdOutcomes,
    narrate: cmdNarrate,
    status: cmdStatus,
    seal: cmdSeal,
    "verify-seal": cmdVerify,
    recheck: cmdRecheck,
    diff: cmdDiff,
    history: cmdHistory,
    roadmap: cmdRoadmap,
    "draft-skill": cmdDraftSkill,
    "draft-env": cmdDraftEnv,
    assets: cmdAssets,
    feedback: cmdFeedback,
    guard: cmdGuard,
    session: cmdSession,
    cleanup: cmdCleanup,
    "allow-host": cmdAllowHost,
    version: cmdVersion,
    validate: cmdValidate,
    audit: cmdAudit,
  };
  const fn = table[cmd];
  if (!fn) fail(`Unknown command ${cmd}. Run \`readiness help\`.`);
  await fn(a);
}

main()
  .catch((e: Error & { exitCode?: number }) => {
    process.stderr.write(`readiness: ${e.message}\n`);
    process.exitCode = e.exitCode ?? 1;
  })
  .finally(() => logInvocation(process.argv.slice(2), Number(process.exitCode ?? 0)));