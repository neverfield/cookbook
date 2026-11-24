import { ghGraphql, ghPagedLines } from "./gh.ts";
import type { Rubric } from "./rubric.ts";
import type { Component, OutcomeStats, OutcomesSnapshot, PrRecord, RateValue, RevertsSnapshot } from "./types.ts";
import { addDays, fail, fmtShortDate, median, readJson, today } from "./util.ts";

export interface Filter {
  branchPrefixes: string[];
  labels: string[];
  authors: string[];
  coAuthorTrailers: string[];
}

export function isAgentPr(pr: PrRecord, f: Filter): boolean {
  if (f.branchPrefixes.some((p) => pr.headRefName.startsWith(p))) return true;
  if (f.labels.some((l) => pr.labels.includes(l))) return true;
  if (f.authors.some((a) => pr.author === a)) return true;
  if (f.coAuthorTrailers.some((t) => (pr.coAuthors ?? []).some((c) => coAuthorMatches(c, t)))) return true;
  return false;
}

// Whole words, so "Cursor" matches "Cursor Agent" and a one-letter filter doesn't match every name.
export function coAuthorMatches(name: string, trailer: string): boolean {
  const t = trailer.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return t.length > 0 && new RegExp(`(^|[^\\w])${t}([^\\w]|$)`, "i").test(name);
}

export function emptyStats(): OutcomeStats {
  return { opened: 0, merged: 0, firstTimeCiPass: 0, firstTimeCiKnown: 0, changesRequested: 0, medianDaysToMerge: null, addingPaths: {}, mergedByActivity: {} };
}

// A revert that landed before the merge reverted something else, such as an earlier PR's commit.
export function revertedWithin(pr: PrRecord, days: number): boolean {
  if (!pr.mergedAt || !pr.revertedAt) return false;
  const after = Date.parse(pr.revertedAt) - Date.parse(pr.mergedAt);
  return after >= 0 && after <= days * 86400000;
}

export function stats(prs: PrRecord[], rubric: Rubric, pathPatterns: string[]): OutcomeStats {
  const s = emptyStats();
  const days: number[] = [];
  const revertDays = rubric.outcomes.revertDays;
  if (revertDays !== undefined) {
    s.reverted = 0;
    s.revertKnown = 0;
  }
  for (const pr of prs) {
    s.opened++;
    if (pr.mergedAt) {
      s.merged++;
      days.push((Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 86400000);
      for (const [activity, labels] of Object.entries(rubric.outcomes.activityLabels)) {
        if (pr.labels.some((l) => labels.includes(l.toLowerCase()))) s.mergedByActivity[activity] = (s.mergedByActivity[activity] ?? 0) + 1;
      }
      if (revertDays !== undefined && pr.revertedAt !== undefined) {
        s.revertKnown!++;
        if (revertedWithin(pr, revertDays)) s.reverted!++;
      }
    }
    if (pr.firstCheck) {
      s.firstTimeCiKnown++;
      if (pr.firstCheck === "success") s.firstTimeCiPass++;
    }
    if (pr.changesRequested) s.changesRequested++;
    for (const p of pathPatterns) if (pr.files.some((f) => f === p || f.endsWith("/" + p))) s.addingPaths[p] = (s.addingPaths[p] ?? 0) + 1;
  }
  const m = median(days);
  s.medianDaysToMerge = m === null ? null : Math.round(m * 10) / 10;
  return s;
}

export function componentsTouched(pr: PrRecord, comps: Component[]): string[] {
  const out = new Set<string>();
  for (const f of pr.files) {
    let best: Component | null = null;
    for (const c of comps) {
      if ((c.path === "." || f.startsWith(c.path + "/")) && (!best || c.path.length > best.path.length)) best = c;
    }
    if (best) out.add(best.id);
  }
  return [...out];
}

// Reverts are reported, never scored. Without a revert field on any PR record nothing was looked
// for, so the rates are left out rather than shown as zero.
function revertsOf(rubric: Rubric, inWindow: PrRecord[], agent: PrRecord[], to: string, source: "gh" | "file", unavailable?: string, limited?: string): RevertsSnapshot | undefined {
  const days = rubric.outcomes.revertDays;
  if (days === undefined) return undefined;
  const looked = inWindow.some((p) => p.revertedAt !== undefined);
  const why = unavailable ?? (looked ? undefined : source === "file" ? "the recorded PR file has no revertedAt fields" : "reverts weren't looked for");
  const merged = agent.filter((p) => p.mergedAt);
  return {
    days,
    agent: why ? [] : merged.filter((p) => revertedWithin(p, days)).map((p) => ({ number: p.number, by: p.revertedBy ?? "a revert" })),
    mergedRecently: merged.filter((p) => p.mergedAt!.slice(0, 10) > addDays(to, -days)).length,
    ...(why ? { unavailable: why } : {}),
    ...(limited && !why ? { limited } : {}),
  };
}

function withoutReverts(s: OutcomeStats): OutcomeStats {
  const { reverted: _r, revertKnown: _k, ...rest } = s;
  return rest;
}

export function computeOutcomes(prs: PrRecord[], comps: Component[], rubric: Rubric, filter: Filter, windowDays: number, source: "gh" | "file", pathPatterns: string[] = [], truncated = false, revertNotes: { unavailable?: string; limited?: string } = {}): OutcomesSnapshot {
  const to = today();
  const from = addDays(to, -windowDays);
  const inWindow = prs.filter((p) => p.createdAt.slice(0, 10) >= from && p.createdAt.slice(0, 10) <= to);
  const agent = inWindow.filter((p) => isAgentPr(p, filter));
  const control = inWindow.filter((p) => !isAgentPr(p, filter));
  const byComponent: Record<string, OutcomeStats> = {};
  let multi = 0;
  let incomplete = 0;
  for (const c of comps) byComponent[c.id] = emptyStats();
  const grouped = new Map<string, PrRecord[]>();
  for (const pr of agent) {
    if (pr.filesIncomplete) {
      incomplete++;
      continue;
    }
    const touched = componentsTouched(pr, comps);
    if (touched.length > 1) multi++;
    for (const id of touched) grouped.set(id, [...(grouped.get(id) ?? []), pr]);
  }
  const reverts = revertsOf(rubric, inWindow, agent, to, source, revertNotes.unavailable, revertNotes.limited);
  const measured = (s: OutcomeStats) => (reverts?.unavailable ? withoutReverts(s) : s);
  for (const [id, list] of grouped) byComponent[id] = measured(stats(list, rubric, pathPatterns));
  return {
    source,
    window: { from, to, days: windowDays },
    filter,
    agent: measured(stats(agent, rubric, pathPatterns)),
    control: measured(stats(control, rubric, pathPatterns)),
    byComponent,
    matchedAgentPrs: agent.map((p) => p.number),
    multiComponentPrs: multi,
    ...(truncated ? { truncated } : {}),
    ...(incomplete ? { filesIncomplete: incomplete } : {}),
    ...(reverts ? { reverts } : {}),
  };
}

export function rate(count: number, n: number, rubric: Rubric, window: string): RateValue {
  return { count, n, rate: n >= rubric.outcomes.minRateN ? Math.round((count / n) * 1000) / 1000 : null, window };
}

export function windowLabel(o: OutcomesSnapshot): string {
  return `${fmtShortDate(o.window.from)} to ${fmtShortDate(o.window.to)}, ${o.window.to.slice(0, 4)}`;
}

export function describeRate(r: RateValue): string {
  if (r.rate === null) return `${r.count} of ${r.n} (too few for a rate)`;
  return `${Math.round(r.rate * 100)}% (${r.count} of ${r.n})`;
}

interface Page<T> {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

interface GqlPr {
  number: number;
  title?: string;
  mergeCommit?: { oid: string } | null;
  headRefName: string;
  createdAt: string;
  mergedAt: string | null;
  state: string;
  author: { __typename: string; login: string } | null;
  labels: { nodes: { name: string }[] };
  changesRequested: { totalCount: number };
  files: Page<{ path: string }>;
  commits: Page<{ commit: { oid: string; message: string } }>;
}

// GitHub's search returns at most 1,000 results, whatever the page size.
export const MAX_PRS = 1000;
// GitHub lists at most 3,000 files and 250 commits for one pull request.
const MAX_PR_FILES = 3000;
const MAX_PR_COMMITS = 250;
// Small pages with no nested connection past one level keep each query far under GitHub's
// 500,000-node limit (25 x 100 files + 25 x 100 commits + 25 x 50 labels).
const PAGE_SIZE = 25;

const PR_FIELDS = `number title headRefName createdAt mergedAt state mergeCommit { oid }
  author { __typename login }
  labels(first: 50) { nodes { name } }
  changesRequested: reviews(first: 1, states: CHANGES_REQUESTED) { totalCount }
  files(first: 100) { totalCount pageInfo { hasNextPage endCursor } nodes { path } }
  commits(first: 100) { totalCount pageInfo { hasNextPage endCursor } nodes { commit { oid message } } }`;

const SEARCH = `query($q: String!, $n: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $n, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;

const MORE_FILES = `query($owner: String!, $name: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $pr) { files(first: 100, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { path } } } }
}`;

const MORE_COMMITS = `query($owner: String!, $name: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $pr) { commits(first: 100, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { commit { oid message } } } } }
}`;

type PrMore = { repository: { pullRequest: Record<string, Page<unknown>> } };

function rest<T>(page: Page<T>, slug: string, pr: number, field: "files" | "commits", cap: number): T[] {
  const [owner, name] = slug.split("/");
  const nodes = [...page.nodes];
  let info = page.pageInfo;
  while (info.hasNextPage && nodes.length < cap) {
    const more = ghGraphql<PrMore>(field === "files" ? MORE_FILES : MORE_COMMITS, { owner, name, pr, after: info.endCursor }).repository.pullRequest[field] as Page<T>;
    nodes.push(...more.nodes);
    info = more.pageInfo;
  }
  return nodes;
}

const REVERT_PRS = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number title body mergedAt } }
  }
}`;

const HISTORY = `query($owner: String!, $name: String!, $since: GitTimestamp!, $after: String) {
  repository(owner: $owner, name: $name) { defaultBranchRef { target { ... on Commit {
    history(since: $since, first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { oid message committedDate } }
  } } } }
}`;

const MAX_REVERT_PRS = 500;
const MAX_HISTORY = 3000;

export interface RevertTarget {
  number: number;
  title: string;
  mergedAt: string | null;
  mergeSha: string | null;
}

export interface RevertPr {
  number: number;
  title: string;
  body: string;
  mergedAt: string | null;
}

export interface BranchCommit {
  oid: string;
  message: string;
  committedDate: string;
}

// The first revert of each merged PR: a merged revert PR whose body says "Reverts owner/repo#123"
// (GitHub's revert button writes it) or whose title is Revert "<the PR's title>", or a commit on the
// default branch that says "This reverts commit <the PR's merge commit>". A revert only counts once
// the PR it reverts had merged.
export function matchReverts(slug: string, targets: RevertTarget[], revertPrs: RevertPr[], commits: BranchCommit[]): Map<number, { at: string; by: string }> {
  const out = new Map<number, { at: string; by: string }>();
  const byNumber = new Map(targets.map((t) => [t.number, t]));
  const note = (t: RevertTarget | undefined, at: string, by: string) => {
    if (!t?.mergedAt || Date.parse(at) < Date.parse(t.mergedAt)) return;
    const had = out.get(t.number);
    if (!had || Date.parse(at) < Date.parse(had.at)) out.set(t.number, { at, by });
  };
  for (const r of revertPrs) {
    if (!r.mergedAt) continue;
    const ref = (r.body ?? "").match(/\bReverts\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/i);
    if (ref && (!ref[1] || ref[1].toLowerCase() === slug.toLowerCase())) {
      note(byNumber.get(Number(ref[2])), r.mergedAt, `#${r.number}`);
      continue;
    }
    const title = (r.title ?? "").match(/^Revert\s+"(.+)"\s*$/)?.[1];
    if (!title) continue;
    const same = targets.filter((t) => t.number !== r.number && t.title === title && t.mergedAt && t.mergedAt <= r.mergedAt!).sort((a, b) => b.mergedAt!.localeCompare(a.mergedAt!));
    note(same[0], r.mergedAt, `#${r.number}`);
  }
  for (const c of commits) {
    for (const m of (c.message ?? "").matchAll(/This reverts commit ([0-9a-f]{7,40})/gi)) {
      const sha = m[1].toLowerCase();
      note(targets.find((t) => t.mergeSha && t.mergeSha.toLowerCase().startsWith(sha)), c.committedDate, `commit ${c.oid.slice(0, 7)}`);
    }
  }
  return out;
}

function findReverts(slug: string, since: string, targets: RevertTarget[]): { found: Map<number, { at: string; by: string }>; limited?: string } {
  const [owner, name] = slug.split("/");
  const revertPrs: RevertPr[] = [];
  let after: string | null = null;
  let prsCut = false;
  for (;;) {
    const page: { search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RevertPr[] } } = ghGraphql(REVERT_PRS, { q: `repo:${slug} is:pr is:merged merged:>=${since} Revert in:title,body`, after });
    revertPrs.push(...page.search.nodes.filter((n) => typeof n?.number === "number"));
    if (!page.search.pageInfo.hasNextPage) break;
    if (revertPrs.length >= MAX_REVERT_PRS) {
      prsCut = true;
      break;
    }
    after = page.search.pageInfo.endCursor;
  }
  const commits: BranchCommit[] = [];
  after = null;
  let historyCut = false;
  type HistoryPage = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: BranchCommit[] };
  type History = { repository: { defaultBranchRef: { target: { history?: HistoryPage } } | null } };
  for (;;) {
    const history: HistoryPage | undefined = ghGraphql<History>(HISTORY, { owner, name, since: `${since}T00:00:00Z`, after }).repository.defaultBranchRef?.target.history;
    if (!history) break;
    commits.push(...history.nodes);
    if (!history.pageInfo.hasNextPage) break;
    if (commits.length >= MAX_HISTORY) {
      historyCut = true;
      break;
    }
    after = history.pageInfo.endCursor;
  }
  const limits = [prsCut ? `only the newest ${MAX_REVERT_PRS} revert PRs were read` : "", historyCut ? `only the newest ${MAX_HISTORY.toLocaleString("en-US")} commits on the default branch were read` : ""].filter(Boolean);
  return { found: matchReverts(slug, targets, revertPrs, commits), ...(limits.length ? { limited: `The revert search was cut short: ${limits.join(", and ")}` } : {}) };
}

export async function fetchPrs(repoSlug: string, windowDays: number, maxPrs = MAX_PRS, opts: { reverts?: boolean } = {}): Promise<{ prs: PrRecord[]; truncated: boolean; reverts?: { unavailable?: string; limited?: string } }> {
  const since = addDays(today(), -windowDays);
  const q = `repo:${repoSlug} is:pr created:>=${since} sort:created-desc`;
  const list: GqlPr[] = [];
  let after: string | null = null;
  let total = 0;
  for (;;) {
    const page: { search: { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlPr[] } } = ghGraphql(SEARCH, { q, n: Math.min(PAGE_SIZE, maxPrs - list.length), after });
    total = page.search.issueCount;
    list.push(...page.search.nodes.filter((n) => typeof n?.number === "number"));
    if (!page.search.pageInfo.hasNextPage || list.length >= maxPrs) break;
    after = page.search.pageInfo.endCursor;
  }
  const records = list.map((p) => toRecord(repoSlug, p));
  let next = 0;
  const worker = async () => {
    while (next < records.length) {
      const r = records[next++];
      if (r.firstSha) r.pr.firstCheck = await firstCheckOf(repoSlug, r.firstSha);
    }
  };
  await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));
  const prs = records.map((r) => r.pr);
  if (!opts.reverts) return { prs, truncated: total > list.length };
  try {
    const targets = list.map((p) => ({ number: p.number, title: p.title ?? "", mergedAt: p.mergedAt, mergeSha: p.mergeCommit?.oid ?? null }));
    const { found, limited } = findReverts(repoSlug, since, targets);
    for (const pr of prs) {
      const hit = found.get(pr.number);
      pr.revertedAt = hit?.at ?? null;
      if (hit) pr.revertedBy = hit.by;
    }
    return { prs, truncated: total > list.length, reverts: limited ? { limited } : {} };
  } catch (e) {
    return { prs, truncated: total > list.length, reverts: { unavailable: `the revert search failed (${(e as Error).message.split("\n")[0].slice(0, 160)})` } };
  }
}

// One check-runs call per PR, so a few run at once.
const CHECK_CONCURRENCY = 8;

// Unknown until every run finished, or when every run was skipped, which proves nothing.
async function firstCheckOf(repoSlug: string, sha: string): Promise<PrRecord["firstCheck"]> {
  try {
    const runs = (await ghPagedLines(`repos/${repoSlug}/commits/${sha}/check-runs?per_page=100`, ".check_runs[] | [.status, (.conclusion // \"\")] | join(\" \")")).map((l) => {
      const [status, conclusion] = l.split(" ");
      return { status, conclusion };
    });
    const ran = runs.filter((r) => r.conclusion !== "skipped" && r.conclusion !== "neutral");
    if (!runs.length || !runs.every((r) => r.status === "completed") || !ran.length) return null;
    return ran.every((r) => r.conclusion === "success") ? "success" : "failure";
  } catch {
    return null;
  }
}

function toRecord(repoSlug: string, p: GqlPr): { pr: PrRecord; firstSha: string | undefined } {
  const files = rest(p.files, repoSlug, p.number, "files", MAX_PR_FILES).map((f) => f.path);
  const commits = rest(p.commits, repoSlug, p.number, "commits", MAX_PR_COMMITS).map((c) => c.commit);
  const coAuthors = commits.flatMap((c) => [...(c.message ?? "").matchAll(/Co-authored-by:\s*([^\n<]+)/gi)].map((m) => m[1].trim()));
  const pr: PrRecord = {
    number: p.number,
    ...(p.title !== undefined ? { title: p.title } : {}),
    headRefName: p.headRefName,
    // As `gh pr list` names them, so author filters written for it still match.
    author: p.author ? (p.author.__typename === "Bot" ? `app/${p.author.login}` : p.author.login) : "",
    labels: p.labels.nodes.map((l) => l.name),
    createdAt: p.createdAt,
    mergedAt: p.mergedAt,
    state: p.state,
    files,
    firstCheck: null,
    changesRequested: p.changesRequested.totalCount > 0,
    coAuthors,
    ...(files.length < p.files.totalCount ? { filesIncomplete: true } : {}),
  };
  return { pr, firstSha: commits[0]?.oid };
}

export function loadPrsFile(path: string): PrRecord[] {
  const data = readJson<PrRecord[] | { prs: PrRecord[] }>(path);
  const prs = Array.isArray(data) ? data : data.prs;
  if (!Array.isArray(prs)) fail(`${path} must hold an array of PR records`);
  return prs;
}
