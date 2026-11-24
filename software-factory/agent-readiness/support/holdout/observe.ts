import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Observation, ObservedComponent } from "./score.ts";

// Turns one sealed (or unsealed) audit into the Observation score.ts scores. This adapter follows
// the report's format as it changes; score.ts, which decides what counts as right, is frozen. A change
// here is a change to the instrument, so the instrument-freeze check keeps it out of a pull request
// that also changes the scripts.

type Json = Record<string, any>;

export interface AuditFiles {
  report: Json | null;
  audit: Json | null;
  markdown: string;
  html: string;
}

export function auditFiles(repo: string): AuditFiles {
  const read = (p: string) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), "utf8") : null);
  const reportText = read(".agent-readiness/latest/report.json");
  const report = reportText ? (JSON.parse(reportText) as Json) : null;
  const auditText = report ? read(`${report.audit.storedAt}/audit.json`) : null;
  return { report, audit: auditText ? (JSON.parse(auditText) as Json) : null, markdown: read(".agent-readiness/latest/report.md") ?? "", html: read(".agent-readiness/latest/report.html") ?? "" };
}

const tick = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The latest evidence row for each contract command, as the conditions read it.
function latestByCommand(audit: Json): Map<string, Json> {
  const out = new Map<string, Json>();
  for (const e of audit.evidence ?? []) if (e.contractId) out.set(e.contractId, e);
  return out;
}

// One fact rendered with two values, across report.json, report.md and report.html. Each entry
// names the fact and both values.
export function factConflicts(f: AuditFiles): string[] {
  const { report, audit, markdown, html } = f;
  if (!report || !audit) return [];
  const out: string[] = [];
  // A command that a limit of this machine blocked reads as blocked everywhere, never as a failure.
  for (const e of latestByCommand(audit).values()) {
    if (!e.blocked || !e.command) continue;
    const failed = new RegExp(`\`${tick(e.command)}\` \\(fail\\)`);
    for (const [where, text] of [["report.md", markdown], ["report.json", JSON.stringify(report.explanations ?? [])]] as const) {
      if (failed.test(text)) out.push(`${e.contractId}: blocked in the evidence, "fail" in ${where}`);
    }
  }
  // The level the heading names is the level the ladder marks, in both views.
  const heading = String(report.executive?.heading ?? "");
  const named = /^Level (\d)\b/.exec(heading)?.[1] ?? null;
  const mdMarked = /Level ladder: .*\*\*\[(\d) /.exec(markdown)?.[1] ?? null;
  const htmlLadder = /<p class="ladder-text[^"]*">Level ladder: (.*?)<\/p>/.exec(html)?.[1] ?? "";
  const htmlMarked = /<b>(\d) /.exec(htmlLadder)?.[1] ?? null;
  if (markdown && named !== mdMarked) out.push(`level: the heading names ${named ?? "none"}, the markdown ladder marks ${mdMarked ?? "none"}`);
  if (html && htmlLadder && named !== htmlMarked) out.push(`level: the heading names ${named ?? "none"}, the HTML ladder marks ${htmlMarked ?? "none"}`);
  if (named !== null && report.maturity?.unproven === false && Number(named) !== report.maturity.level) out.push(`level: the heading names ${named}, report.json says ${report.maturity.level}`);
  // The heading's count of blocked checks is the count the components table shows.
  const blockedSaid = /and (\d+) (?:was|were) blocked here/.exec(heading);
  if (blockedSaid && !/per component/.test(heading)) {
    const blocked = (report.components?.included ?? []).flatMap((c: Json) => (c.capReasons ?? []).filter((k: Json) => k.state === "blocked")).length;
    if (Number(blockedSaid[1]) !== blocked) out.push(`blocked checks: the heading says ${blockedSaid[1]}, the components hold ${blocked}`);
  }
  // Instruction counts: an item listed as skipped isn't also counted as not run.
  const items = (audit.instructions ?? []) as Json[];
  const skipped = items.filter((i) => i.category === "skipped").length;
  const notRun = items.filter((i) => i.result === "not_run" && i.category !== "skipped").length;
  const notRunWithSkipped = items.filter((i) => i.result === "not_run").length;
  if (skipped > 0 && notRunWithSkipped !== notRun && new RegExp(`\\b${notRunWithSkipped} not run\\b`).test(markdown)) out.push(`instructions: ${notRunWithSkipped} "not run" counts ${skipped} skipped items the table lists as skipped`);
  return out;
}

function environmentOf(audit: Json | null): Observation["environment"] {
  const kind = audit?.environment?.proofEnv?.kind;
  if (kind === "container" || kind === "disposable_vm" || kind === "host") return kind;
  if (audit?.environment?.hostMode) return "host";
  return audit?.environment?.containerRuntime ? "container" : "none";
}

function componentsOf(report: Json, audit: Json): ObservedComponent[] {
  const contract = (audit.contract ?? []) as Json[];
  const testOf = (id: string) => contract.find((k) => k.kind === "test" && k.component === id && !k.fallbackFor) ?? contract.find((k) => k.kind === "test" && k.component === "*" && !k.fallbackFor) ?? null;
  const noLevel = report.maturity?.outcome === "not_assessed";
  const included: ObservedComponent[] = (report.components?.included ?? []).map((c: Json) => {
    const t = testOf(c.id);
    const status: ObservedComponent["status"] = c.status ?? (noLevel || c.level === null ? "not_assessed" : c.unproven ? "unproven" : "proven");
    return { path: c.path, placement: c.placement ?? "component", level: c.unproven ? null : c.level, status, noTests: !t, testCommand: t ? (t.declared ?? t.command) : null };
  });
  const excluded: ObservedComponent[] = (report.components?.excluded ?? []).map((c: Json) => ({
    path: c.path,
    placement: c.placement ?? (String(c.reason).startsWith("not a component") ? "satellite" : "excluded"),
    level: null,
    status: "not_assessed",
    noTests: false,
    testCommand: null,
  }));
  return [...included, ...excluded];
}

function unownedOf(report: Json): number | null {
  if (typeof report.components?.unownedShare === "number") return report.components.unownedShare;
  const all = [...(report.components?.included ?? []), ...(report.components?.excluded ?? [])] as Json[];
  if (!all.length) return null;
  const owned = all.reduce((s, c) => s + (typeof c.changeShare === "number" ? c.changeShare : 0), 0);
  return Math.round(Math.max(0, Math.min(1, 1 - owned)) * 1000) / 1000;
}

// Advice that would break the repo: telling the reader to ignore source files the repo ships.
const SOURCE = /\.(py|js|mjs|cjs|ts|tsx|jsx|go|rs|rb|java|kt|php|cs|swift|scala)$/;
function harmfulAdvice(report: Json, audit: Json): number {
  const shipped = ((audit.safety ?? []) as Json[]).filter((s) => s.kind === "secret" && s.blocking && !s.waived && SOURCE.test(String(s.file)));
  return shipped.length && /\.gitignore/.test(JSON.stringify(report)) ? 1 : 0;
}

// What the audit left behind: changes to the repo outside .agent-readiness/ (and the given
// prefixes, such as the copied skill), and temp trees or containers. Run the audit with TMPDIR set to
// `tmp`, empty before it starts; `containers` is a name fragment unique to this audit's containers.
export function afterAudit(repo: string, opts: { tmp?: string; containers?: string; ignore?: string[] } = {}): Pick<Observation["after"], "treeChanged" | "leftovers"> {
  const ignore = [".agent-readiness/", ...(opts.ignore ?? [])];
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8" });
  const changed = status.status === 0 ? status.stdout.split("\n").filter(Boolean).map((l) => l.slice(3)).filter((p) => !ignore.some((i) => p.startsWith(i))) : null;
  const temp = opts.tmp && existsSync(opts.tmp) ? readdirSync(opts.tmp).filter((n) => n.startsWith("readiness")) : [];
  let containers: string[] = [];
  if (opts.containers) {
    const ps = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" });
    if (ps.status === 0) containers = ps.stdout.split("\n").filter((n) => n.includes(opts.containers!));
  }
  return { treeChanged: changed === null ? null : changed.length > 0, leftovers: temp.length + containers.length > 0 };
}

export interface ObserveOptions {
  exit: number;
  arm?: Observation["arm"];
  overBudget?: boolean;
  after?: Partial<Observation["after"]>;
  agent?: Observation["agent"];
}

export function observe(repo: string, opts: ObserveOptions): Observation {
  const f = auditFiles(repo);
  const { report, audit } = f;
  const sealed = audit?.state === "sealed";
  return {
    schema: "agent-readiness/holdout-observation@1",
    arm: opts.arm ?? "scripted",
    environment: environmentOf(audit),
    sealed,
    crashed: !sealed && opts.exit !== 0,
    overBudget: Boolean(opts.overBudget),
    components: report && audit ? componentsOf(report, audit) : [],
    unownedShare: report ? unownedOf(report) : null,
    blocking: ((audit?.safety ?? []) as Json[]).filter((s) => s.blocking && !s.waived).map((s) => ({ file: s.file, line: s.line ?? null })),
    harmfulAdvice: report && audit ? harmfulAdvice(report, audit) : 0,
    after: { testCommandRefused: opts.after?.testCommandRefused ?? null, treeChanged: opts.after?.treeChanged ?? null, leftovers: opts.after?.leftovers ?? null },
    factConflicts: factConflicts(f).length,
    agent: opts.agent ?? null,
    statesDifference: Boolean(report?.maturity?.environmentDifference),
  };
}
