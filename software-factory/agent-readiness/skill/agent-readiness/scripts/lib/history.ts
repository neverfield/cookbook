import { cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.ts";
import { scanText } from "./secrets.ts";
import { tempDir } from "./teardown.ts";
import type { Audit, HistoryLine, MaskedValue, ReportJson, Roadmap } from "./types.ts";
import { ensureDir, exists, fail, git, nowIso, readJson, readText, writeJson, writeText } from "./util.ts";
import type { Paths } from "./workspace.ts";

export const HISTORY_BRANCH = "agent-readiness/history";

// JSON is scanned string by string: serialized, a stored output's lines are joined by `\n` escapes
// and its quotes escaped, so a line-anchored or quoted secret would pass unseen. HTML is unescaped
// for the same reason.
function secretsIn(name: string, value: unknown): string[] {
  if (typeof value === "string") return scanText(value).map((h) => `${h.type} (${name}, line ${h.line})`);
  if (Array.isArray(value)) return value.flatMap((v, i) => secretsIn(`${name}[${i}]`, v));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [...secretsIn(`${name} key`, k), ...secretsIn(`${name}.${k}`, v)]);
  return [];
}

function unescapeHtml(html: string): string {
  return html.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function guardSecrets(label: string, found: string[]): void {
  if (found.length > 0) fail(`Refusing to write ${label}: it contains ${found.join(", ")}. Nothing was written.`);
}

// A value the user passed by name (--registry-env) is theirs and was never the repo's to print, so
// finding one stops the write: it means redaction failed somewhere. Its name is all the message says.
export interface NamedValue {
  name: string;
  value: string;
}

// Where a masked value came from: the repo file and line of the nearest record that names one (an
// instruction, a contract command, a safety finding), else the record's path in the audit.
function locationOf(node: Record<string, unknown>): string | null {
  const file = typeof node.source === "string" ? node.source : typeof node.file === "string" ? node.file : null;
  if (!file || file === "agent") return null;
  return typeof node.line === "number" && !/:\d+$/.test(file) ? `${file}:${node.line}` : file;
}

// Secret-shaped strings the repo's own text carries into the records, such as a token in an
// example command in AGENTS.md, are replaced with [redacted:<type>] rather than refusing the whole
// write. Returns the masked copy and what was masked where. A registry value refuses.
export function maskSecrets<T>(label: string, value: T, named: NamedValue[] = []): { value: T; masked: MaskedValue[] } {
  const masked: MaskedValue[] = [];
  const values = named.filter((n) => n.value.length >= 4);
  const walk = (v: unknown, path: string, where: string | null): unknown => {
    if (typeof v === "string") {
      const hit = values.find((n) => v.includes(n.value));
      if (hit) fail(`Refusing to write ${label}: it contains the value of ${hit.name}, which --registry-env passed to the setup steps (${path}). Nothing was written. Report this with \`readiness feedback\`: the value should have been redacted.`);
      const hits = scanText(v);
      if (!hits.length) return v;
      let out = redact(v);
      // Whatever redact() doesn't reshape, the whole string goes.
      if (scanText(out).length) out = `[redacted:${hits[0].type}]`;
      for (const h of hits) masked.push({ type: h.type, where: where ?? path });
      return out;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, where));
    if (v && typeof v === "object") {
      const node = v as Record<string, unknown>;
      const here = locationOf(node) ?? where;
      return Object.fromEntries(Object.entries(node).map(([k, x]) => [walk(k, `${path} key`, here) as string, walk(x, `${path}.${k}`, here)]));
    }
    return v;
  };
  return { value: walk(value, label, null) as T, masked };
}

export function storeAudit(p: Paths, audit: Audit, report: ReportJson, md: string, html: string): string {
  const dir = join(p.history, "audits", audit.id);
  const auditText = JSON.stringify(audit, null, 2) + "\n";
  const reportText = JSON.stringify(report, null, 2) + "\n";
  guardSecrets(`audit ${audit.id}`, [...secretsIn("audit.json", audit), ...secretsIn("report.json", report), ...secretsIn("report.md", md), ...secretsIn("report.html", unescapeHtml(html))]);
  writeText(join(dir, "audit.json"), auditText);
  writeText(join(dir, "report.json"), reportText);
  writeText(join(dir, "report.md"), md);
  writeText(join(dir, "report.html"), html);
  return dir;
}

export function writeLatest(p: Paths, report: ReportJson, md: string, html: string): void {
  writeJson(join(p.latest, "report.json"), report);
  writeText(join(p.latest, "report.md"), md);
  writeText(join(p.latest, "report.html"), html);
}

export function readRoadmap(p: Paths): Roadmap | null {
  return exists(p.roadmap) ? readJson<Roadmap>(p.roadmap) : null;
}

export function writeRoadmap(p: Paths, roadmap: Roadmap): void {
  writeJson(p.roadmap, roadmap);
}

// A fresh clone has only the remote-tracking branch, and reading neither would start the history
// over and let the next push overwrite it.
export function showFromBranch(repo: string, path: string): string | null {
  for (const ref of [HISTORY_BRANCH, `origin/${HISTORY_BRANCH}`]) {
    const r = git(["show", `${ref}:${path}`], repo);
    if (r.ok) return r.stdout;
  }
  return null;
}

export function appendHistory(p: Paths, line: HistoryLine, named: NamedValue[] = []): void {
  const f = join(p.history, "history.jsonl");
  const text = JSON.stringify(maskSecrets("history.jsonl", line, named).value) + "\n";
  ensureDir(p.history);
  const prev = mergeHistory(branchHistory(p.repo) ?? "", exists(f) ? readText(f) : "");
  writeText(f, prev + text);
}

export function readHistory(p: Paths): HistoryLine[] {
  const f = join(p.history, "history.jsonl");
  return parseHistory(mergeHistory(branchHistory(p.repo) ?? "", exists(f) ? readText(f) : ""));
}

// Lines from every copy, each id once, in date order and otherwise in the order first written.
export function mergeHistory(...texts: string[]): string {
  const seen = new Set<string>();
  const out: { line: string; date: string }[] = [];
  for (const line of texts.flatMap((t) => t.split("\n")).filter((l) => l.trim())) {
    const h = JSON.parse(line) as HistoryLine;
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push({ line, date: h.date ?? "" });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out.length ? out.map((x) => x.line).join("\n") + "\n" : "";
}

// The history branch as this clone knows it: the local branch and the remote one, merged, so a
// stale local branch doesn't hide CI's newer lines.
function branchHistory(repo: string): string | null {
  const texts = [HISTORY_BRANCH, `origin/${HISTORY_BRANCH}`].map((ref) => git(["show", `${ref}:history.jsonl`], repo)).filter((r) => r.ok).map((r) => r.stdout);
  return texts.length ? mergeHistory(...texts) : null;
}

// A sealed file from the local history folder, or from the history branch when the audit came from there.
export function readSealedFile(p: Paths, dir: string, name: string): string | null {
  if (exists(join(dir, name))) return readText(join(dir, name));
  const m = dir.match(/^[^:]+:(audits\/.+)$/);
  return m ? showFromBranch(p.repo, `${m[1]}/${name}`) : null;
}

function parseHistory(text: string): HistoryLine[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as HistoryLine);
}

export function auditIds(p: Paths): string[] {
  const dir = join(p.history, "audits");
  return exists(dir) ? readdirSync(dir).sort() : [];
}

export function loadSealedAudit(p: Paths, ref: string): { audit: Audit; dir: string } {
  let id = ref;
  if (ref === "latest" || ref === "previous") {
    const audits = readHistory(p).filter((h) => h.kind === "audit");
    const pick = ref === "latest" ? audits[audits.length - 1] : audits[audits.length - 2];
    if (!pick) fail(`No ${ref} sealed audit in ${p.history}`);
    id = pick.id;
  }
  const dir = join(p.history, "audits", id);
  if (exists(join(dir, "audit.json"))) return { audit: readJson<Audit>(join(dir, "audit.json")), dir };
  const fromBranch = showFromBranch(p.repo, `audits/${id}/audit.json`);
  if (fromBranch) return { audit: JSON.parse(fromBranch) as Audit, dir: `${HISTORY_BRANCH}:audits/${id}` };
  return fail(`No sealed audit ${id}`);
}

export function storeRecheck(p: Paths, id: string, record: unknown, named: NamedValue[] = []): string {
  const f = join(p.history, "rechecks", `${id}.json`);
  const text = JSON.stringify(maskSecrets(`rechecks/${id}.json`, record, named).value, null, 2) + "\n";
  writeText(f, text);
  return f;
}

// The history branch is the audit's own: the repo's hooks (a pre-commit framework's .git/hooks, a
// post-checkout hook) and the user's commit signing never run on it, as a worktree without the
// repo's config would fail them or a signing prompt would hang.
const hg = (args: string[], cwd: string) => git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], cwd);

export function pushHistory(p: Paths, opts: { push: boolean; remote: string }): string {
  if (!exists(p.history)) fail(`Nothing to push: ${p.history} doesn't exist`);
  const scratch = tempDir("readiness-history-");
  const wt = join(scratch.path, "wt");
  const hasLocal = hg(["rev-parse", "--verify", HISTORY_BRANCH], p.repo).ok;
  const hasRemote = hg(["rev-parse", "--verify", `${opts.remote}/${HISTORY_BRANCH}`], p.repo).ok;
  const remoteRef = `${opts.remote}/${HISTORY_BRANCH}`;
  const localSha = hasLocal ? hg(["rev-parse", HISTORY_BRANCH], p.repo).stdout.trim() : "";
  const show = (ref: string) => {
    const r = hg(["show", `${ref}:history.jsonl`], p.repo);
    return r.ok ? r.stdout : "";
  };
  const branchText = hasLocal ? show(HISTORY_BRANCH) : "";
  const remoteText = hasRemote ? show(remoteRef) : "";
  try {
    // Commit on the remote's tip, so a push after CI's rechecks fast-forwards instead of failing,
    // and lay the local branch's files over it so nothing sealed locally is lost.
    if (hasRemote) {
      const r = hg(["worktree", "add", "-B", HISTORY_BRANCH, wt, remoteRef], p.repo);
      if (!r.ok) fail(r.stderr);
      if (localSha) hg(["checkout", localSha, "--", "."], wt);
    } else if (hasLocal) hg(["worktree", "add", wt, HISTORY_BRANCH], p.repo);
    else {
      const r = hg(["worktree", "add", "--detach", wt], p.repo);
      if (!r.ok) fail(r.stderr);
      hg(["checkout", "--orphan", HISTORY_BRANCH], wt);
      hg(["rm", "-rf", "--quiet", "."], wt);
    }
    const localText = exists(join(p.history, "history.jsonl")) ? readText(join(p.history, "history.jsonl")) : "";
    cpSync(p.history, wt, { recursive: true });
    writeText(join(wt, "history.jsonl"), mergeHistory(remoteText, branchText, localText));
    hg(["add", "-A"], wt);
    const status = hg(["status", "--porcelain"], wt).stdout.trim();
    let message = "history branch already up to date";
    if (status) {
      const c = hg(["-c", "user.name=agent-readiness", "-c", "user.email=agent-readiness@example.com", "commit", "-q", "--no-verify", "-m", `Agent readiness history ${nowIso().slice(0, 10)}`], wt);
      if (!c.ok) fail(`Could not commit history: ${c.stderr}`);
      message = `committed history to ${HISTORY_BRANCH}`;
    }
    if (opts.push) {
      const pr = hg(["push", "--no-verify", opts.remote, HISTORY_BRANCH], wt);
      if (!pr.ok) fail(`Could not push ${HISTORY_BRANCH}: ${pr.stderr}`);
      message += ` and pushed to ${opts.remote}`;
    }
    return message;
  } finally {
    hg(["worktree", "remove", "--force", wt], p.repo);
    scratch.dispose();
  }
}
