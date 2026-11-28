import { join, normalize } from "node:path";
import { inComponent } from "./languages/coverage.ts";
import { quotedLines, sitesForLine } from "./languages/fault-sites.ts";
import { languageOf } from "./languages/index.ts";
import { isTestFile } from "./languages/test-paths.ts";
import type { Component, FaultEstimate, Language } from "./types.ts";
import { lastChanged, listFiles, readText, sha256 } from "./util.ts";

export { isTestFile };
export { cosmetic, quotedLines, sitesForLine } from "./languages/fault-sites.ts";
export { parseJsonc, resolveJs } from "./languages/imports.ts";

export interface Site {
  file: string;
  line: number;
  operator: string;
  before: string;
  after: string;
}

// A language file's fault hooks; none for a language faults aren't planted in.
function hooksFor(lang: Language) {
  return languageOf(lang)?.mutation ?? null;
}

export function testFiles(tree: string, comp: Component): string[] {
  const hooks = hooksFor(comp.language);
  return hooks ? inComponent(listFiles(tree), comp.path).filter((f) => hooks.isTest(f)) : [];
}

// The source files the component's tests cover, by its language file: for JavaScript and Python,
// the files they import, directly, through path aliases, or through barrel files that re-export them.
export function targetFiles(tree: string, comp: Component): string[] {
  const hooks = hooksFor(comp.language);
  if (!hooks) return [];
  return [...new Set(hooks.covered(tree, comp, testFiles(tree, comp), inComponent(listFiles(tree), comp.path)))].filter((f) => hooks.isSource(f) && !hooks.isTest(f)).sort();
}

// For each file, the test files that reach it, so a fault's run can be narrowed to them; null for
// a file the run can't be narrowed for. The whole index is null for a language that doesn't say.
export function testsReaching(tree: string, comp: Component): ((file: string) => string[] | null) | null {
  const hooks = hooksFor(comp.language);
  return hooks?.reaching ? hooks.reaching(tree, comp, testFiles(tree, comp)) : null;
}

// pytest and `node --test` options that take the next word as their value.
const RUNNER_VALUE_FLAGS = new Set(["-k", "-m", "-c", "-p", "-n", "-o", "-W", "-r", "--rootdir", "--config-file", "--deselect", "--ignore", "--ignore-glob", "--junitxml", "--cov", "--cov-report", "--import-mode", "--maxfail", "--tb", "--dist", "--test-reporter", "--test-reporter-destination", "--test-name-pattern", "--test-concurrency", "--import", "--require", "-r"]);

// The test command narrowed to the given test files, or null when it can't be done safely: only a
// direct pytest or `node --test` run that names no paths of its own, and test files inside the
// folder it runs in.
export function scopedCommand(command: string, cwd: string, tests: string[]): string | null {
  const words = command.trim().split(/\s+/);
  if (words.some((w) => /[|&;<>()$`"'\\*?]/.test(w))) return null;
  let at = -1;
  for (let i = 0; i < words.length && at < 0; i++) {
    if (/(^|\/)pytest$/.test(words[i])) at = i;
    else if (/(^|\/)python3?$/.test(words[i]) && words[i + 1] === "-m" && words[i + 2] === "pytest") at = i + 2;
  }
  if (at < 0 && /(^|\/)node$/.test(words[0] ?? "") && words.includes("--test")) at = 0;
  if (at < 0) return null;
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i];
    if (w === "--test" || w.startsWith("-")) {
      if (RUNNER_VALUE_FLAGS.has(w)) i++;
      continue;
    }
    return null;
  }
  const base = normalize(cwd).replace(/\/$/, "");
  const rel = tests.map((t) => (base === "." ? t : t.startsWith(base + "/") ? t.slice(base.length + 1) : null));
  if (rel.some((r) => r === null || !/^[\w./@+-]+$/.test(r))) return null;
  return `${command.trim()} ${rel.join(" ")}`;
}

// What the planted faults are chosen from: the files the tests import, and the tests. The same code
// gives the same faults, so a fault result changes only when the code does. Line endings don't count.
export function codeDigest(tree: string, files: string[]): string {
  return sha256([...new Set(files)].sort().map((f) => `${f}\n${sha256(readText(join(tree, f)).replace(/\r\n/g, "\n"))}`).join("\n"));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRandom(seed: string, salt: string): () => number {
  return mulberry32(parseInt(sha256(seed + ":" + salt).slice(0, 8), 16));
}

// A clamp guard such as `if (n < 0) return 0;` or `if n > 100: n = 100` behaves the same with its
// boundary flipped: at the bound, the branch gives the value the code would have kept anyway. Such a
// mutant is equivalent, so no test can catch it.
export function equivalentBoundary(lines: string[], i: number): boolean {
  const line = lines[i];
  const m = line.match(/\b(?:if|elif|while)\s*\(?\s*([\w.$]+)\s*(?:<=|>=|<|>)\s*(-?[\w.$]+)\s*(:|\)?\s*\{?)\s*(.*)$/);
  if (!m) return false;
  const [, left, bound, , rest] = m;
  let body = rest.replace(/[;}]\s*$/, "").trim();
  for (let j = i + 1; !body && j < lines.length && j <= i + 2; j++) body = lines[j].trim().replace(/^\{\s*/, "").replace(/;?\s*\}?\s*$/, "").trim();
  const ret = body.match(/^return\s+(-?[\w.$]+)$/);
  if (ret) return ret[1] === bound;
  const set = body.match(/^([\w.$]+)\s*=\s*(-?[\w.$]+)$/);
  return Boolean(set && set[1] === left && set[2] === bound);
}

const COMPARE: Record<string, (a: number, b: number) => boolean> = { "<": (a, b) => a < b, "<=": (a, b) => a <= b, ">": (a, b) => a > b, ">=": (a, b) => a >= b, "==": (a, b) => a === b, "===": (a, b) => a === b, "!=": (a, b) => a !== b, "!==": (a, b) => a !== b };
const FLIPPED: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

// A constant changed from C to C + 1 where it is a variable's whole value in one branch (the
// variable itself, a `|| C`, `?? C` or `or C` fallback, or an arm of a conditional), and every other
// mention of the variable in the file compares it with a number that C and C + 1 fall on the same
// side of. `const seen = counts.get(key) || 0` used only as `seen > 2` is one: no test can tell 0
// from 1 there. Any other use, a reassignment or a mention in a comment, keeps the fault.
export function equivalentConstant(lines: string[], i: number, before: string, after: string): boolean {
  const decl = before.match(/^\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=(?![=>])\s*(.*)$/);
  if (!decl) return false;
  const [, name, rhs] = decl;
  let at = 0;
  while (at < before.length && before[at] === after[at]) at++;
  const num = before.slice(at).match(/^\d+/);
  if (!num || at < before.length - rhs.length) return false;
  const c = Number(num[0]);
  const pre = before.slice(before.length - rhs.length, at).trimEnd();
  const post = before.slice(at + num[0].length).trim().replace(/;$/, "").trim();
  if (!(pre === "" || /(\|\||\?\?|\bor|\?|:|\belse)$/.test(pre)) || !(post === "" || /^(:|if\b|else\b)/.test(post))) return false;
  const esc = name.replace(/\$/g, "\\$");
  const mention = new RegExp(`(?<![\\w$.])${esc}(?![\\w$])`, "g");
  const cmp = new RegExp(`^(?:(?<![\\w$.])${esc}\\s*(===|!==|==|!=|<=|>=|<|>)\\s*(-?\\d+(?:\\.\\d+)?)(?![\\w.])|(-?\\d+(?:\\.\\d+)?)\\s*(===|!==|==|!=|<=|>=|<|>)\\s*${esc}(?![\\w$]))`);
  let uses = 0;
  for (let j = 0; j < lines.length; j++) {
    if (j === i) continue;
    for (const m of lines[j].matchAll(mention)) {
      const from = lines[j].slice(m.index!);
      const back = lines[j].slice(0, m.index!).match(/(-?\d+(?:\.\d+)?)\s*(===|!==|==|!=|<=|>=|<|>)\s*$/);
      const fwd = from.match(cmp);
      let op: string;
      let k: number;
      if (fwd?.[1]) [op, k] = [fwd[1], Number(fwd[2])];
      else if (back) [op, k] = [FLIPPED[back[2]] ?? back[2], Number(back[1])];
      else return false;
      if (COMPARE[op](c, k) !== COMPARE[op](c + 1, k)) return false;
      uses++;
    }
  }
  return uses > 0;
}

export function allSites(tree: string, files: string[], lang: Language): Site[] {
  const sites: Site[] = [];
  // A language without hooks of its own for sites or quoting gets the C-like rules.
  const hooks = hooksFor(lang);
  const quote = (text: string) => hooks?.quoted?.(text) ?? quotedLines(text, "ts");
  const onLine = (line: string) => hooks?.sites?.(line) ?? sitesForLine(line, "ts");
  for (const file of files) {
    const text = readText(join(tree, file));
    const quoted = quote(text);
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (quoted.has(i)) return;
      for (const s of onLine(line)) {
        if (s.operator === "boundary_flip" && equivalentBoundary(lines, i)) continue;
        if (s.operator === "change_constant" && equivalentConstant(lines, i, s.before, s.after)) continue;
        sites.push({ file, line: i + 1, ...s });
      }
    });
  }
  return sites;
}

// A fault's identity: its file, its line with whitespace normalised, and its operator. The line's
// number isn't part of it, so a fault keeps its identity when code above it moves.
export function faultId(site: Pick<Site, "file" | "before" | "operator">): string {
  return sha256(`${site.file}\n${site.before.trim().replace(/\s+/g, " ")}\n${site.operator}`).slice(0, 16);
}

export interface PickOptions {
  // "fault" (from 2026-12-beta): each fault is ranked by its own identity, so editing a test, or code
  // in another file, never redraws it. Without it, the whole pick is keyed on every file's digest.
  identity?: "fault";
  // Fault ids an earlier sealed audit planted, replanted first where the same fault still exists.
  prior?: string[];
  // Fault ids never to pick: ones an earlier sealed report named as missed that `prior` doesn't replant.
  exclude?: string[];
}

// The pick depends on the component's code and on `seed`. An empty seed leaves the code alone to
// decide, so the same code always gets the same faults; an eval or a grader passes its own seed to
// get faults the code's own pick didn't plant.
export function chooseSites(repo: string, tree: string, comp: Component, seed: string, count: number, commit = "HEAD", opts: PickOptions = {}): Site[] {
  const files = targetFiles(tree, comp);
  const sites = allSites(tree, files, comp.language);
  if (sites.length === 0) return [];
  const recency = lastChanged(repo, files, { commit });
  const sortedFiles = [...files].sort((a, b) => (recency.get(b) ?? "").localeCompare(recency.get(a) ?? "") || a.localeCompare(b));
  const recentTier = new Set(sortedFiles.slice(0, Math.max(1, Math.ceil(sortedFiles.length / 2))));
  let shuffled: Site[];
  if (opts.identity === "fault") {
    const rank = (s: Site) => sha256(`${seed}:${comp.id}:${faultId(s)}`);
    shuffled = sites.map((s) => ({ s, k: rank(s) })).sort((a, b) => a.k.localeCompare(b.k) || a.s.line - b.s.line).map((x) => x.s);
  } else {
    const code = codeDigest(tree, [...files, ...testFiles(tree, comp)]);
    const rand = seededRandom(seed ? `${code}:${seed}` : code, comp.id);
    shuffled = sites.map((s) => ({ s, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.s);
  }
  const excluded = new Set(opts.exclude ?? []);
  const tiered = [...shuffled.filter((s) => recentTier.has(s.file)), ...shuffled.filter((s) => !recentTier.has(s.file))].filter((s) => !excluded.has(faultId(s)));
  if (opts.prior?.length) {
    const order = new Map(opts.prior.map((id, i) => [id, i]));
    const again = tiered.filter((s) => order.has(faultId(s))).sort((a, b) => order.get(faultId(a))! - order.get(faultId(b))!);
    tiered.splice(0, tiered.length, ...again, ...tiered.filter((s) => !order.has(faultId(s))));
  }
  const picked: Site[] = [];
  const usedLines = new Set<string>();
  for (const s of tiered) {
    if (picked.length >= count) break;
    const key = `${s.file}:${s.line}`;
    if (usedLines.has(key)) continue;
    usedLines.add(key);
    picked.push(s);
  }
  for (const s of tiered) {
    if (picked.length >= count) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked;
}

// A type error every checker of the language reports at any strictness: a string assigned to a
// variable annotated as a number, appended at the end of a file the component's tests import.
// Languages without a line here get no canary, so their type-check counts on its exit code alone.
export const TYPE_CANARIES: { label: string; ext: RegExp; line: string }[] = [
  { label: "TypeScript", ext: /\.(tsx?|mts|cts)$/, line: 'const __readinessTypeCanary: number = "agent-readiness";' },
  { label: "Python", ext: /\.py$/, line: '__readiness_type_canary: int = "agent-readiness"' },
];

// The most recently changed file the tests import that a canary line can go in, so the error lands
// in code agents change. The same commit always gets the same file.
export function typeCanarySite(repo: string, tree: string, comp: Component, commit = "HEAD"): { file: string; line: string } | null {
  const lineFor = (f: string) => (/\.d\.[mc]?ts$/.test(f) ? undefined : TYPE_CANARIES.find((c) => c.ext.test(f))?.line);
  const files = targetFiles(tree, comp).filter((f) => lineFor(f));
  if (files.length === 0) return null;
  const recency = lastChanged(repo, files, { commit });
  const file = [...files].sort((a, b) => (recency.get(b) ?? "").localeCompare(recency.get(a) ?? "") || a.localeCompare(b))[0];
  return { file, line: lineFor(file)! };
}

// Keeps the file's own line endings, so a CRLF checkout on Windows gets a CRLF line.
export function withCanary(text: string, line: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return `${text}${text === "" || text.endsWith("\n") ? "" : eol}${line}${eol}`;
}

// A change that can't alter what a file does: a comment line at its end, after one blank line, written
// as a capitalised sentence so the linters a build or test script runs first accept it (xo's
// capitalized-comments, StyleCop's SA1513 and SA1515 with warnings as errors). Null for a file of
// another kind, and for a PHP file that ends by closing its PHP block, where a line after `?>` would
// be printed.
export const CONTROL_COMMENT = "Agent readiness control comment.";
export function withControlComment(file: string, text: string): string | null {
  if (/\.php$/.test(file) && text.trimEnd().endsWith("?>")) return null;
  const marker = /\.(py|rb)$/.test(file) ? "#" : /\.([cm]?[jt]sx?|go|rs|java|kts?|cs|php)$/.test(file) ? "//" : null;
  if (!marker) return null;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = text.replace(/(\r?\n)+$/, "");
  return `${body}${body ? eol + eol : ""}${marker} ${CONTROL_COMMENT}${eol}`;
}

export function applySite(text: string, site: Site): string {
  const lines = text.split("\n");
  if (lines[site.line - 1] !== site.before) throw new Error(`Line ${site.line} of ${site.file} changed since the site was chosen`);
  lines[site.line - 1] = site.after;
  return lines.join("\n");
}

// The share of planted faults with a clear result (caught or survived) the tests must catch. The
// 2026 rubrics need every one; a rubric that sets `mutation.killRate` replaces it.
export const DEFAULT_KILL_RATE = 1;

export function killRateOf(mutation: { minForPass?: number; killRate?: number }): number {
  const k = mutation.killRate;
  return typeof k === "number" && k > 0 && k <= 1 ? k : DEFAULT_KILL_RATE;
}

// The sequential estimate (from 2026-12-beta). Faults are planted in batches until the share caught is
// decided either way, or a cap is reached:
// strong: the one-sided `strongConfidence` Wilson lower bound is at least `strongLow`, and the share
//   caught at least `strongRate`;
// weak: the one-sided `weakConfidence` Wilson upper bound is below `weakHigh`;
// inconclusive otherwise, which leaves the faults condition undetermined, never not met.
export interface EstimateRule {
  batch: number;
  maxDecided: number;
  maxPlanted: number;
  strongConfidence: number;
  strongLow: number;
  strongRate: number;
  weakConfidence: number;
  weakHigh: number;
}

export function estimateRule(mutation: { estimate?: EstimateRule }): EstimateRule | null {
  return mutation.estimate ?? null;
}

// The standard normal quantile (Acklam's rational approximation, relative error below 1.2e-9).
export function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.928510446969, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// One side of the Wilson score interval for k successes in n, at a one-sided confidence.
export function wilsonBound(k: number, n: number, confidence: number, side: "low" | "high"): number {
  if (n === 0) return side === "low" ? 0 : 1;
  const z = normalQuantile(confidence);
  const p = k / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const bound = (side === "low" ? centre - half : centre + half) / (1 + (z * z) / n);
  return Math.min(1, Math.max(0, bound));
}

// `caught` and `decided` count only faults no sealed audit planted before. Faults planted again from
// the last audit are reported beside the estimate (`carried`, `carriedCaught`) and never move it: the
// sealed report names the lines of missed ones, so tests written against those lines alone would
// otherwise turn a weak suite strong.
export function faultEstimate(caught: number, decided: number, rule: EstimateRule, minForPass: number, planted = decided, carried = 0, carriedCaught = 0): FaultEstimate {
  const low = wilsonBound(caught, decided, rule.strongConfidence, "low");
  const high = wilsonBound(caught, decided, rule.weakConfidence, "high");
  const rate = decided ? caught / decided : 0;
  const verdict = decided < minForPass ? "inconclusive" : low >= rule.strongLow - 1e-12 && rate >= rule.strongRate - 1e-12 ? "strong" : high < rule.weakHigh ? "weak" : "inconclusive";
  return { planted, decided, caught, rate, low, high, verdict, carried, carriedCaught };
}

// Whether to plant another batch: the estimate is still open and neither cap is reached.
export function keepPlanting(est: FaultEstimate, rule: EstimateRule): boolean {
  return est.verdict === "inconclusive" && est.decided < rule.maxDecided && est.planted < rule.maxPlanted;
}

// The looks fall at whole batches of decided new faults, the points the rule's error rates were set at.
export function atLook(decided: number, rule: EstimateRule): boolean {
  return decided > 0 && decided % rule.batch === 0;
}

// How many of the last audit's missed faults may be planted again. They don't count toward the
// estimate, so they are extra runs; one batch shows whether those misses are now caught.
export function carriedCap(rule: EstimateRule): number {
  return rule.batch;
}

// The fault check's result from its counts: not_run when too few faults gave a clear result.
export function faultsVerdict(caught: number, counted: number, mutation: { minForPass: number; killRate?: number }): "pass" | "fail" | "not_run" {
  if (counted < mutation.minForPass) return "not_run";
  return caught >= Math.ceil(killRateOf(mutation) * counted - 1e-9) ? "pass" : "fail";
}
