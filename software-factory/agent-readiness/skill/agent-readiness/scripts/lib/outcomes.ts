import { ghGraphql, ghPagedLines } from "./gh.ts";
import type { Rubric } from "./rubric.ts";
import type { Component, OutcomeStats, OutcomesSnapshot, PrRecord, RateValue } from "./types.ts";
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

export function stats(prs: PrRecord[], rubric: Rubric, pathPatterns: string[]): OutcomeStats {
  const s = emptyStats();
  const days: number[] = [];
  for (const pr of prs) {
    s.opened++;
    if (pr.mergedAt) {
      s.merged++;
      days.push((Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 86400000);
      for (const [activity, labels] of Object.entries(rubric.outcomes.activityLabels)) {
        if (pr.labels.some((l) => labels.includes(l.toLowerCase()))) s.mergedByActivity[activity] = (s.mergedByActivity[activity] ?? 0) + 1;
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

export function computeOutcomes(prs: PrRecord[], comps: Component[], rubric: Rubric, filter: Filter, windowDays: number, source: "gh" | "file", pathPatterns: string[] = [], truncated = false): OutcomesSnapshot {
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
  for (const [id, list] of grouped) byComponent[id] = stats(list, rubric, pathPatterns);
  return {
    source,
    window: { from, to, days: windowDays },
    filter,
    agent: stats(agent, rubric, pathPatterns),
    control: stats(control, rubric, pathPatterns),
    byComponent,
    matchedAgentPrs: agent.map((p) => p.number),
    multiComponentPrs: multi,
    ...(truncated ? { truncated } : {}),
    ...(incomplete ? { filesIncomplete: incomplete } : {}),
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

const PR_FIELDS = `number headRefName createdAt mergedAt state
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

export async function fetchPrs(repoSlug: string, windowDays: number, maxPrs = MAX_PRS): Promise<{ prs: PrRecord[]; truncated: boolean }> {
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
  return { prs: records.map((r) => r.pr), truncated: total > list.length };
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
