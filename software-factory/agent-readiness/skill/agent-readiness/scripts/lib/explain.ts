import type { ModelInput } from "./model.ts";
import { INSTRUCTION_RULES, SAFETY_RULES } from "./static.ts";
import type { Audit, CondId, CondState, Evidence, Explanation, InstructionItem, ReportJson, ReportWaivers, SafetyFinding } from "./types.ts";
import { usedWaivers } from "./waivers.ts";

const STATE_WORD: Record<CondState, string> = { met: "met", not_met: "not met", unknown: "not proven", blocked: "blocked on this machine" };

const STATE_RULE: Record<CondState, string> = {
  met: "Met means it ran at the strength the check requires and passed.",
  not_met: "Not met means it ran and failed, or the repo lacks what it needs.",
  unknown: "Not proven means it didn't run, or ran below the strength the check requires.",
  blocked: "Blocked means a limit of this machine kept it from running; that never counts against the repo.",
};

const STATIC_PLACE = "read from the audited commit's files, nothing ran";

const OFFLINE_RULE = "Tests run with the container's network switched off, so a test that needs the internet fails.";

const CANARY_RULE = "A type-check that passes counts only once it fails on a known type error the audit adds, in a throwaway copy, to the most recently changed TypeScript or Python file the tests import, and passes again once the line is removed; a component whose tests import neither counts on the exit code alone.";

function list(items: string[], max = 4): string {
  const shown = items.slice(0, max);
  const more = items.length > max ? `, and ${items.length - max} more` : "";
  if (shown.length <= 1) return shown.join("") + more;
  return `${shown.slice(0, -1).join(", ")}${more ? "" : " and"} ${shown[shown.length - 1]}${more}`;
}

function placeOf(audit: Audit, e: Evidence): string {
  // A command recorded as not run ran nowhere, whatever executor it was meant for: a container that
  // didn't start, or no runtime at all, still records where it would have run.
  if (e.result === "not_run") return "not run";
  const rt = audit.environment.containerRuntime;
  if (e.where === "container") return `in a clean ${rt ? `${rt} ` : ""}container${e.image ? ` (${e.image})` : ""}`;
  if (e.where === "fresh_copy") return "in a fresh copy on the host, with no container";
  if (e.where === "disposable_vm") return "in a fresh copy on a disposable VM, with no container";
  if (e.where === "host") return "on the host, in the repo itself";
  return STATIC_PLACE;
}

function places(audit: Audit, evs: Evidence[]): string {
  const all = [...new Set(evs.map((e) => placeOf(audit, e)))];
  return all.length ? list(all) : "not run";
}

function ranOf(evs: Evidence[]): string {
  const all = [...new Set(evs.map((e) => (e.command ? `\`${e.command}\` (${e.result === "not_run" ? "not run" : e.result})` : e.summary)))];
  return all.length ? list(all) : "nothing ran for it";
}

function levelNeeding(input: ModelInput, c: CondId): string {
  const { rubric } = input;
  if (rubric.level1.includes(c)) return "Level 1 needs it";
  if (rubric.level2.includes(c)) return "Level 2 needs it";
  return "Reported with Level 1; no level waits on it alone";
}

function conditionRule(input: ModelInput, c: CondId, state: CondState): string {
  const cond = input.rubric.conditions[c];
  const check = input.rubric.checks.find((k) => k.id === cond.check);
  return `${levelNeeding(input, c)}: ${cond.label}${check ? ` (${check.title})` : ""}. ${STATE_RULE[state]}`;
}

function evidenceFor(audit: Audit, ids: string[]): Evidence[] {
  const set = new Set(ids);
  return audit.evidence.filter((e) => set.has(e.id));
}

// The images a mixed-language replay used, each with what ran in it: "node:22-bookworm (the repo,
// web); golang:1.23-bookworm (api)". Null when one image ran everything.
export function imagesUsed(env: Audit["environment"]): string | null {
  const runs = env.images ?? [];
  if (runs.length < 2) return null;
  return runs.map((r) => `${r.image} (${r.components.map((c) => (c === "*" ? "the repo" : c)).join(", ")}${r.started ? "" : ", didn't start"})`).join("; ");
}

function environmentLine(input: ModelInput): string {
  const { audit } = input;
  if (audit.tier === "read-only") return "nowhere: the read-only tier runs no repo command";
  if (audit.environment.notRun) return `nowhere: ${audit.environment.notRun}`;
  const images = imagesUsed(audit.environment);
  if (audit.environment.containerRuntime && images) return `in clean ${audit.environment.containerRuntime} containers, one per toolchain: ${images}`;
  if (audit.environment.containerRuntime) return `in a clean ${audit.environment.containerRuntime} container (${audit.environment.image ?? "the audit's image"})`;
  const pe = audit.environment.proofEnv;
  if (pe?.kind === "disposable_vm" && audit.evidence.some((e) => e.where === "disposable_vm")) return `in a fresh copy on a disposable VM, detected by ${(pe.detectedBy ?? []).join(" and ")}, with the network ${pe.network === "cut" ? "cut for the tests" : "on for the tests, because the VM couldn't cut it"}`;
  if (audit.evidence.some((e) => e.where === "fresh_copy")) return "in a fresh copy on the host, because this machine has no container runtime";
  return "nowhere: no repo command ran";
}

function componentLevel(input: ModelInput, report: ReportJson): Explanation[] {
  const { audit, rubric } = input;
  const out: Explanation[] = [];
  const rules = `${report.details.levelRules.level1}. ${report.details.levelRules.level2}. A component's level is the highest whose conditions are all met; Level 3 and 4 also need agent PR outcomes against targets.`;
  for (const c of report.components.included) {
    const contract = audit.contract.filter((k) => k.component === c.id || k.component === "*");
    const evs = contract.map((k) => [...audit.evidence].reverse().find((e) => e.contractId === k.id)).filter((e): e is Evidence => Boolean(e));
    const ran = contract.length ? list(contract.map((k) => `\`${k.command}\` (${evs.find((e) => e.contractId === k.id)?.result.replace("not_run", "not run") ?? "not run"})`), 6) : "no command: the scan found none to run";
    const result = c.level === null ? "not assessed" : c.unproven ? "Level 1 unproven on this machine" : `Level ${c.level}${c.couldBe !== null ? `, could be ${c.couldBe}` : ""}`;
    const held = c.capReasons.map((k) => `${k.label}: ${STATE_WORD[k.state]} (${k.reason})`);
    const happened = c.level === null ? "no level: the audit has no real check results to give one from" : held.length ? `Held ${c.unproven ? "unproven" : `at Level ${c.level}`} by ${list(held, 6)}` : c.level >= 4 ? "every condition up to Level 4 is met" : `every Level ${c.level} condition is met`;
    out.push({ kind: "level", subject: c.id, result, ran, where: evs.length ? places(audit, evs) : environmentLine(input), happened, rule: c.unproven ? `${rules} Unproven is its own result: no Level 1 check failed, and the ones left were blocked on this machine.` : rules });
  }
  for (const c of report.components.excluded) {
    const satellite = c.reason.startsWith("not a component");
    out.push({
      kind: "not_assessed",
      subject: c.id,
      result: "not assessed",
      ran: "nothing: the audit runs commands only for assessed components",
      where: "not run",
      happened: c.reason,
      rule: satellite ? "Folders that usually hold tests, samples or tooling are listed, not assessed, while the repo has other components." : `Only components on a supported toolchain are assessed, up to the ${rubric.components.maxAssessed} most active by share of recent changes; the support list says which toolchains are supported.`,
    });
  }
  return out;
}

function conditions(input: ModelInput): Explanation[] {
  const { audit, rubric } = input;
  const out: Explanation[] = [];
  const conds: CondId[] = [...rubric.level1, ...rubric.level2.filter((c) => !rubric.level1.includes(c)), "toolchain", "lockfile"];
  const repoDone = new Set<CondId>();
  for (const comp of input.components.filter((x) => x.assessed)) {
    const s = input.states.get(comp.id);
    if (!s) continue;
    for (const c of conds) {
      const d = s[c];
      if (!d) continue;
      const repo = rubric.conditions[c].scope === "repo";
      if (repo && repoDone.has(c)) continue;
      if (repo) repoDone.add(c);
      const evs = evidenceFor(audit, d.evidence);
      const offline = (c === "clean.test" || c === "faults") && evs.some((e) => e.where === "container" && e.result !== "not_run") ? ` ${OFFLINE_RULE}` : "";
      const canary = c === "commands" && rubric.canary?.typecheck ? ` ${CANARY_RULE}` : "";
      out.push({ kind: "condition", subject: repo ? `repo: ${rubric.conditions[c].label}` : `${comp.id}: ${rubric.conditions[c].label}`, result: STATE_WORD[d.state], ran: ranOf(evs), where: evs.length ? places(audit, evs) : repo ? STATIC_PLACE : "not run", happened: d.reason, rule: conditionRule(input, c, d.state) + offline + canary });
    }
  }
  return out;
}

function instructionRule(i: InstructionItem): string {
  const id = i.rule ?? (i.kind === "path" ? "path-exists" : i.category === "install" ? "install-static" : i.category === "risky" ? "risky" : i.category === "long_running" ? "long-running" : i.category === "needs_access" ? (/sudo/.test(i.reason ?? "") ? "sudo" : "machine-path") : "replay");
  return INSTRUCTION_RULES[id] ?? INSTRUCTION_RULES.replay;
}

function instructions(audit: Audit): Explanation[] {
  return audit.instructions.map((i) => {
    const ev = audit.evidence.find((e) => e.id === i.evidenceId);
    const ranCmd = i.kind === "path" ? `checked that \`${i.text}\` exists` : `\`${i.text}\`${i.cwd && i.cwd !== "." ? ` in ${i.cwd}` : ""}`;
    const where = ev ? placeOf(audit, ev) : i.staticResult === "fail" || i.kind === "path" || i.result === "pass" ? STATIC_PLACE : "not run";
    const result = i.waived ? "waived" : i.result === "pass" ? "checks out" : i.result === "fail" ? "wrong" : i.category === "skipped" ? "skipped" : "not run";
    const happened = i.waived ? `${i.waived.was}; waived by ${i.waived.waiver} (${i.waived.by}): ${i.waived.reason}` : i.reason ?? (i.result === "pass" ? (i.kind === "path" ? "it exists" : "it exited 0") : i.staticReason ?? "no result");
    return { kind: "instruction" as const, subject: `${i.source}:${i.line}`, result, ran: ranCmd, where, happened, rule: instructionRule(i) };
  });
}

const SAFETY_FALLBACK: Record<SafetyFinding["kind"], string> = { secret: "secret", lifecycle_hook: "lifecycle-hook", network_piped: "network-piped", destructive: "destructive", deploy_publish: "deploy-publish", credential_needed: "credential-needed", elevated: "elevated", host_mode: "host-mode" };

function safety(audit: Audit): Explanation[] {
  return audit.safety.map((s) => ({
    kind: "safety" as const,
    subject: s.file === "." ? "this audit" : `${s.file}${s.line ? `:${s.line}` : ""}`,
    result: s.waived ? "waived" : s.blocking ? "blocks Level 2" : "listed for review",
    ran: s.kind === "host_mode" ? "the repo's commands, in host mode" : "the secret and script scan",
    where: s.kind === "host_mode" ? "on the host, with --allow-host" : STATIC_PLACE,
    happened: s.waived ? `${s.waived.was}; waived by ${s.waived.waiver} (${s.waived.by}): ${s.waived.reason}` : s.detail,
    rule: SAFETY_RULES[s.rule ?? SAFETY_FALLBACK[s.kind]] ?? SAFETY_RULES.secret,
  }));
}

function repoLevel(input: ModelInput, report: ReportJson): Explanation {
  const m = report.maturity;
  const active = [...input.active];
  const result = report.maturity.outcome === "not_assessed" ? "not assessed" : m.unproven ? "Level 1 unproven on this machine" : `Level ${m.level}${m.couldBe !== null ? `, could be ${m.couldBe}` : ""}`;
  const held = m.capReasons.map((k) => `${k.component === "*" ? "repo" : k.component}: ${k.label}, ${STATE_WORD[k.state]} (${k.reason})`);
  const share = report.executive.unassessed?.share ?? 0;
  const coverage = share > 0.5 ? ` It covers only ${Math.round((1 - share) * 1000) / 10}% of recent changes: ${report.executive.unassessed!.text}.` : "";
  const happened = report.maturity.outcome === "not_assessed" ? report.executive.headline : `${m.setBy.length ? `Set by ${list(m.setBy)}` : "No component sets it"}${held.length ? `, held by ${list(held, 6)}` : ""}.${coverage}`;
  return {
    kind: "level",
    subject: "repo",
    result,
    ran: active.length ? `the level rules over the active ${active.length === 1 ? "component" : "components"}, ${list(active, 6)}` : "the level rules, with no active component",
    where: environmentLine(input),
    happened,
    rule: `${m.rule}${m.unproven ? " Unproven is a result of its own, not Level 0: no Level 1 check failed, and the ones left were blocked on this machine." : m.outcome === "blocked" ? " A check that decides the next level was blocked on this machine, so the next level is unproven here." : ""}`,
  };
}

// Every result in the report with what ran, where it ran, what happened and the rule behind it.
export function explanationsOf(input: ModelInput, report: ReportJson): Explanation[] {
  return [repoLevel(input, report), ...componentLevel(input, report), ...conditions(input), ...instructions(input.audit), ...safety(input.audit)];
}

export function waiversOf(audit: Audit): ReportWaivers | null {
  const w = audit.waivers;
  if (!w) return null;
  const used = usedWaivers(audit);
  const count = (id: string) => audit.instructions.filter((i) => i.waived?.waiver === id).length + audit.safety.filter((s) => s.waived?.waiver === id).length;
  return {
    file: w.file,
    digest: w.digest,
    ignored: w.ignored,
    applied: w.entries.filter((e) => used.has(e.id)).map((e) => ({ id: e.id, check: e.check, match: e.match, reason: e.reason, by: e.by, findings: count(e.id) })),
    unused: w.entries.filter((e) => !used.has(e.id)).map((e) => ({ id: e.id, match: e.match })),
    rejected: w.rejected,
  };
}

// A result with no reason, or a reason that reads "undefined", fails the seal.
export function explanationGaps(report: ReportJson, audit: Audit): string[] {
  const errors: string[] = [];
  const ex = report.explanations ?? [];
  const has = (kind: Explanation["kind"], subject: string) => ex.some((e) => e.kind === kind && e.subject === subject);
  if (!has("level", "repo")) errors.push("the report doesn't explain the repo level");
  for (const c of report.components.included) if (!has("level", c.id)) errors.push(`the report doesn't explain ${c.id}'s level`);
  for (const c of report.components.excluded) if (!has("not_assessed", c.id)) errors.push(`the report doesn't explain why ${c.id} isn't assessed`);
  if (ex.filter((e) => e.kind === "instruction").length !== audit.instructions.length) errors.push("the report doesn't explain every instruction item");
  if (ex.filter((e) => e.kind === "safety").length !== audit.safety.length) errors.push("the report doesn't explain every safety finding");
  for (const e of ex) {
    for (const field of ["result", "ran", "where", "happened", "rule"] as const) {
      const v = e[field];
      if (!v || !v.trim() || /\bundefined\b|\[object |\bNaN\b/.test(v)) errors.push(`the explanation of ${e.subject} has no ${field === "happened" ? "account of what happened" : field}${v ? ` (${v})` : ""}`);
    }
  }
  return errors;
}
