import { join } from "node:path";
import type { Site } from "../mutate.ts";
import type { Component } from "../types.ts";
import { exists, git, listFiles, readJson, readText } from "../util.ts";
import { inComponent, namedAfter } from "./coverage.ts";
import type { DraftCommand, Ecosystem, LanguageDef } from "./language.ts";

// Owned by the PHP and Ruby group.

interface ComposerJson {
  name?: string;
  type?: string;
  version?: string;
  require?: Record<string, string>;
  "require-dev"?: Record<string, string>;
  scripts?: Record<string, unknown>;
  extra?: { "branch-alias"?: Record<string, unknown> };
}

function composerJson(tree: string, path: string): ComposerJson | null {
  const f = join(tree, path, "composer.json");
  if (!exists(f)) return null;
  try {
    return readJson<ComposerJson>(f);
  } catch {
    return null;
  }
}

// Packages beyond PHP itself and its extensions, which composer.lock pins.
function requiresPackages(tree: string, path: string): boolean {
  if (!exists(join(tree, path, "composer.json"))) return false;
  const c = composerJson(tree, path);
  if (!c) return true;
  return Object.keys({ ...c.require, ...c["require-dev"] }).some((k) => k !== "php" && !k.startsWith("ext-") && !k.startsWith("lib-"));
}

const SAFE_VERSION = /^v?\d[\w.+-]*$/;
const RELEASE_TAG = /^v?\d+(\.\d+)*$/;
const CI_FILES = [".gitlab-ci.yml", ".travis.yml"];
const CI_ROOT_VERSION = /\bCOMPOSER_ROOT_VERSION\s*[:=]\s*["']?(v?\d[\w.+-]*)["']?/;

// The repo the audit tree was cloned from: the tree is a one-commit clone with no tags or branches,
// and its FETCH_HEAD names the checkout it was fetched from.
function sourceRepo(tree: string): string | null {
  const fetchHead = join(tree, ".git", "FETCH_HEAD");
  const from = exists(fetchHead) ? readText(fetchHead).match(/ of (.+)$/m)?.[1]?.trim() : undefined;
  return from && exists(from) ? from : null;
}

// The highest release tag the audited commit contains, from the tree itself or the repo it came from.
function latestTag(tree: string): string | null {
  // Never a repo above the tree, which git would otherwise find.
  if (!exists(join(tree, ".git"))) return null;
  const head = git(["rev-parse", "HEAD"], tree);
  if (!head.ok) return null;
  for (const repo of [tree, sourceRepo(tree)]) {
    if (!repo) continue;
    const tags = git(["tag", "--merged", head.stdout.trim()], repo);
    const releases = tags.ok ? tags.stdout.split("\n").map((t) => t.trim()).filter((t) => RELEASE_TAG.test(t)).map((t) => t.replace(/^v/, "")) : [];
    const tag = releases.sort((a, b) => cmp(nums(b), nums(a)))[0];
    if (tag) return tag;
  }
  return null;
}

// The version Composer should give the root package. The audit checks out a detached commit, where
// Composer calls the root `dev-<sha>`, so a dev dependency that requires the root back (guzzle's
// guzzlehttp/test-server needs guzzle ^8.1) can't be met, though it can on the repo's branch. In
// order: the version the repo's CI sets, its branch alias, then its latest release tag. Nothing for
// a package that sets its own version, or for an application, which no package requires.
export function composerRootVersion(tree: string, path: string): { version: string; from: string } | null {
  const c = composerJson(tree, path);
  if (!c?.name || c.version || c.type === "project") return null;
  if (path === ".") {
    const ci = [...listFiles(join(tree, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`), ...CI_FILES.filter((f) => exists(join(tree, f)))];
    for (const f of ci) {
      const v = readText(join(tree, f)).match(CI_ROOT_VERSION)?.[1];
      if (v) return { version: v, from: `the COMPOSER_ROOT_VERSION ${f} sets` };
    }
  }
  const aliases = Object.values(c.extra?.["branch-alias"] ?? {}).filter((v): v is string => typeof v === "string" && SAFE_VERSION.test(v));
  const aliasKey = (v: string) => nums(v.replace(/^v/, "").replace(/(\.x)?-dev$/, ""));
  const alias = aliases.sort((a, b) => cmp(aliasKey(b), aliasKey(a)))[0];
  if (alias) return { version: alias, from: "composer.json's branch-alias" };
  const tag = path === "." ? latestTag(tree) : null;
  return tag ? { version: tag, from: "the latest release tag" } : null;
}

const composer: Ecosystem = {
  id: "composer",
  label: "Composer",
  lockfiles: ["composer.lock"],
  rule: "`composer install` from a committed `composer.lock`",
  install: (tree, path, { ignoreScripts }) => {
    const flags = `--no-interaction --no-progress${ignoreScripts ? " --no-scripts" : ""}`;
    const root = composerRootVersion(tree, path);
    const command = `${root ? `COMPOSER_ROOT_VERSION=${root.version} ` : ""}composer install ${flags}`;
    const as = root ? `, with the root package as ${root.version} (${root.from}), since the audit's detached checkout has no branch` : "";
    return exists(join(tree, path, "composer.lock"))
      ? { command, reason: `install from composer.lock${as}`, frozen: true }
      : { command, reason: `no composer.lock, so the install can't be frozen${as}`, frozen: false };
  },
  unpinned: (tree, path) => (requiresPackages(tree, path) && !exists(join(tree, path, "composer.lock")) ? "no composer.lock is committed" : null),
};

// The official Composer images, each with the PHP it ships, newest first. Composer's images carry
// only the PHP that was current when they were built, so a PHP minor is reached through the Composer
// release built on it. Read with `docker buildx imagetools inspect` and `php -v` on Nov 15, 2026.
const PHP_IMAGES: { tag: string; php: string; digest: string }[] = [
  { tag: "composer:2.11", php: "8.5.12", digest: "sha256:ca11f643d7791ebdd90a34fc20caf11380d434007ae539a9ea75cd9212e13dca" },
  { tag: "composer:2.8", php: "8.4.14", digest: "sha256:5248900ab8b5f7f880c2d62180e40960cd87f60149ec9a1abfd62ac72a02577c" },
  { tag: "composer:2.7", php: "8.3.12", digest: "sha256:cb3483dc851665462a66c59982577dfbbde0ae2059e8b5550c2f49f44b8c333e" },
];

const nums = (v: string) => v.split(".").map(Number);

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// Whether a Composer version constraint (`^8.2`, `>=8.1 <8.5`, `~8.3.0`, `8.4.*`, `^7.4 || ^8.0`)
// allows a version. A term it can't read allows everything, so an odd constraint never picks a
// worse image than the default.
export function allows(constraint: string, version: string): boolean {
  const v = nums(version);
  return constraint.split(/\s*\|\|?\s*/).some((alt) => {
    const hyphen = alt.match(/^\s*(\d[\d.]*)\s+-\s+(\d[\d.]*)\s*$/);
    if (hyphen) return cmp(v, nums(hyphen[1])) >= 0 && cmp(v.slice(0, nums(hyphen[2]).length), nums(hyphen[2])) <= 0;
    return alt
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .every((term) => {
        const m = term.replace(/@\w+$/, "").match(/^(\^|~|>=|<=|>|<|!=|==|=)?v?(\d+(?:\.(?:\d+|\*|x))*)(?:-[\w.]+)?$/i);
        if (!m) return true;
        const [, op = "", raw] = m;
        const wild = raw.split(".").findIndex((p) => p === "*" || p.toLowerCase() === "x");
        const t = nums(raw.split(".").slice(0, wild < 0 ? undefined : wild).join(".") || "0");
        const below = (upper: number[]) => cmp(v, upper) < 0;
        if (wild >= 0) return cmp(v.slice(0, t.length), t) === 0;
        switch (op) {
          case "^":
            return cmp(v, t) >= 0 && below(t[0] > 0 || t.length === 1 ? [t[0] + 1] : [0, t[1] + 1]);
          case "~":
            return cmp(v, t) >= 0 && below(t.length > 2 ? [t[0], t[1] + 1] : [t[0] + 1]);
          case ">=":
            return cmp(v, t) >= 0;
          case ">":
            return cmp(v, t) > 0;
          case "<=":
            return cmp(v, t) <= 0;
          case "<":
            return cmp(v, t) < 0;
          case "!=":
            return cmp(v.slice(0, t.length), t) !== 0;
          default:
            return cmp(v.slice(0, t.length), t) === 0;
        }
      });
  });
}

const phpConstraint = (tree: string, dir: string) => composerJson(tree, dir)?.require?.php?.trim() || null;

// The newest image whose PHP the component's `require.php` allows; the newest when none does, so
// Composer's own platform check says what's wrong.
export function phpImage(tree: string, dir: string): string {
  const want = phpConstraint(tree, dir);
  return (want ? PHP_IMAGES.find((i) => allows(want, i.php)) : undefined)?.tag ?? PHP_IMAGES[0].tag;
}

// Composer packages a component installs directly.
function packages(tree: string, dir: string): Set<string> {
  const c = composerJson(tree, dir);
  return new Set(Object.keys({ ...c?.require, ...c?.["require-dev"] }));
}

const anyFile = (tree: string, dir: string, names: string[]) => names.some((n) => exists(join(tree, dir, n)));

function phpCommands(tree: string, comp: Component): DraftCommand[] {
  const dir = comp.path;
  const pkgs = packages(tree, dir);
  const scripts = composerJson(tree, dir)?.scripts ?? {};
  const out: DraftCommand[] = [];
  if (scripts.test !== undefined) out.push({ kind: "test", command: "composer run-script --timeout=0 test", source: "composer.json scripts.test", reason: "the repo's test script" });
  else if (pkgs.has("pestphp/pest")) out.push({ kind: "test", command: "vendor/bin/pest", source: "composer.json require-dev", reason: "Pest, which the component installs" });
  else if (pkgs.has("phpunit/phpunit")) out.push({ kind: "test", command: "vendor/bin/phpunit", source: "composer.json require-dev", reason: "PHPUnit, which the component installs" });
  if (pkgs.has("laravel/pint")) out.push({ kind: "lint", command: "vendor/bin/pint --test", source: "composer.json require-dev", reason: "Pint, check-only" });
  else if (pkgs.has("friendsofphp/php-cs-fixer")) out.push({ kind: "lint", command: "vendor/bin/php-cs-fixer fix --dry-run --diff", source: "composer.json require-dev", reason: "PHP CS Fixer, dry run" });
  else if (pkgs.has("squizlabs/php_codesniffer") && anyFile(tree, dir, ["phpcs.xml", "phpcs.xml.dist", ".phpcs.xml", ".phpcs.xml.dist"])) out.push({ kind: "lint", command: "vendor/bin/phpcs", source: "phpcs.xml", reason: "PHP_CodeSniffer with the repo's rules" });
  const phpstan = ["phpstan.neon", "phpstan.neon.dist", "phpstan.dist.neon"].find((n) => exists(join(tree, dir, n)));
  const psalm = ["psalm.xml", "psalm.xml.dist"].find((n) => exists(join(tree, dir, n)));
  if ((pkgs.has("phpstan/phpstan") || pkgs.has("larastan/larastan")) && phpstan) out.push({ kind: "typecheck", command: "vendor/bin/phpstan analyse --no-progress --memory-limit=1G", source: phpstan, reason: "PHPStan with the repo's config" });
  else if (pkgs.has("vimeo/psalm") && psalm) out.push({ kind: "typecheck", command: "vendor/bin/psalm --no-progress", source: psalm, reason: "Psalm with the repo's config" });
  return out;
}

// PHPUnit's `OK (12 tests, 30 assertions)` or `Tests: 12, Assertions: 30, Failures: 2, Errors: 1.`,
// and Pest's `Tests:  1 failed, 10 passed (30 assertions)`. Several runs in one script are summed.
export function phpTestCounts(output: string): { passed: number; failed: number; total: number } | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  let passed = 0;
  let failed = 0;
  let total = 0;
  let seen = false;
  for (const m of text.matchAll(/^OK \((\d+) tests?, \d+ assertions?\)/gm)) {
    seen = true;
    passed += Number(m[1]);
    total += Number(m[1]);
  }
  for (const m of text.matchAll(/^Tests: (\d+), Assertions: \d+([^\n]*)/gm)) {
    seen = true;
    const n = (k: string) => Number(m[2].match(new RegExp(`${k}: (\\d+)`))?.[1] ?? 0);
    const bad = n("Failures") + n("Errors");
    const skipped = n("Skipped") + n("Incomplete");
    passed += Number(m[1]) - bad - skipped;
    failed += bad;
    total += Number(m[1]);
  }
  for (const m of text.matchAll(/^\s*Tests:\s+([^\n]*\d+ (?:passed|failed)[^\n]*)/gm)) {
    seen = true;
    const n = (k: string) => Number(m[1].match(new RegExp(`(\\d+) ${k}`))?.[1] ?? 0);
    passed += n("passed");
    failed += n("failed");
    total += n("passed") + n("failed") + n("skipped") + n("incomplete") + n("todos?") + n("risky");
  }
  return seen ? { passed, failed, total } : null;
}

const PHP_TEST = /(^|\/)tests?\/(.*\/)?[^/]*Test\.php$|(^|\/)[^/]*Test\.php$/;
const NOT_SOURCE = /(^|\/)(vendor|node_modules|tests?|config|database|bootstrap|storage|resources|routes|var|public)\//;

const isTest = (f: string) => PHP_TEST.test(f);
const isSource = (f: string) => f.endsWith(".php") && !f.endsWith(".blade.php") && !isTest(f) && !NOT_SOURCE.test(f);

// Where a line's code ends: at a `//` or `#` comment outside a string (`#[` opens an attribute).
function codeEnd(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if ((ch === "/" && line[i + 1] === "/") || (ch === "#" && line[i + 1] !== "[")) return i;
  }
  return line.length;
}

function outsideString(line: string, re: RegExp, end: number): RegExpExecArray | null {
  const g = new RegExp(re.source, "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(line)) && m.index < end) {
    let quote: string | null = null;
    for (let i = 0; i < m.index; i++) {
      if (quote) {
        if (line[i] === "\\") i++;
        else if (line[i] === quote) quote = null;
      } else if (line[i] === "'" || line[i] === '"') quote = line[i];
    }
    if (!quote) return m;
  }
  return null;
}

const SKIP_LINE = /^(\/\/|#|\/\*|\*|use\s|namespace\s|declare\s*\(|(require|include)(_once)?\b|<\?(php|=)?|\?>|case\s|default\b)/;
const BOUNDARY: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">" };
const TIMING = /(sleep|usleep|timeout|delay|ttl|expires?|retry|backoff|interval)/i;

// Fault sites on one line of PHP: the C-like operators, with `;` in place of a dropped `throw` or
// bare `return`, since PHP has no `void 0`.
export function phpSites(line: string): Omit<Site, "file" | "line">[] {
  const trimmed = line.trim();
  if (!trimmed || SKIP_LINE.test(trimmed)) return [];
  const end = codeEnd(line);
  const out: Omit<Site, "file" | "line">[] = [];
  const swap = (at: number, len: number, by: string) => line.slice(0, at) + by + line.slice(at + len);
  const b = outsideString(line, / (<=|>=|<|>) /, end);
  if (b) out.push({ operator: "boundary_flip", before: line, after: swap(b.index, b[0].length, ` ${BOUNDARY[b[1]]} `) });
  const c = outsideString(line, /\b(if|elseif|while)\s*\(/, end);
  if (c) {
    const start = c.index + c[0].length;
    let depth = 1;
    let i = start;
    for (; i < end && depth > 0; i++) {
      if (line[i] === "(") depth++;
      else if (line[i] === ")") depth--;
    }
    if (depth === 0) out.push({ operator: "negate_condition", before: line, after: line.slice(0, start) + `!(${line.slice(start, i - 1)})` + line.slice(i - 1) });
  }
  const s = outsideString(line, / ([+-]) 1(?![\d.])/, end);
  if (s) out.push({ operator: "shift_by_one", before: line, after: swap(s.index, s[0].length, ` ${s[1] === "+" ? "-" : "+"} 1`) });
  const r = outsideString(line, /\breturn (true|false)\b/, end);
  if (r) out.push({ operator: "swap_return", before: line, after: swap(r.index, r[0].length, `return ${r[1] === "true" ? "false" : "true"}`) });
  const code = line.slice(0, end).trim();
  if (/^throw\b.*;$/.test(code) || code === "return;") out.push({ operator: "drop_throw_or_return", before: line, after: `${line.match(/^\s*/)?.[0] ?? ""};` });
  const k = outsideString(line, /(?<![\w.$\\])(\d+)(?![\w.])/, end);
  if (k && !TIMING.test(line.slice(0, end))) {
    const n = Number(k[1]);
    if (Number.isSafeInteger(n)) out.push({ operator: "change_constant", before: line, after: swap(k.index, k[1].length, String(n + 1)) });
  }
  return out.filter((x) => x.after !== x.before);
}

// 0-based lines that hold text rather than code: inline HTML outside `<?php ... ?>`, block
// comments, and strings, heredocs and nowdocs that span lines.
export function phpQuoted(text: string): Set<number> {
  const out = new Set<number>();
  const lines = text.split("\n");
  let html = true;
  let state: { kind: "comment" | "string" | "heredoc"; close: string; from: number } | null = null;
  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    if (state?.kind === "heredoc") {
      out.add(l);
      if (new RegExp(`^\\s*${state.close}\\b`).test(line)) state = null;
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      if (state) {
        if (state.kind === "string" && line[i] === "\\") i++;
        else if (line.startsWith(state.close, i)) {
          i += state.close.length - 1;
          for (let r = state.from; r <= l && l > state.from; r++) out.add(r);
          state = null;
        }
        continue;
      }
      if (html) {
        out.add(l);
        const open = line.indexOf("<?", i);
        if (open < 0) break;
        html = false;
        i = open + (line.startsWith("<?php", open) ? 4 : line.startsWith("<?=", open) ? 2 : 1);
        continue;
      }
      const ch = line[i];
      if (line.startsWith("?>", i)) {
        html = true;
        i++;
      } else if ((ch === "/" && line[i + 1] === "/") || (ch === "#" && line[i + 1] !== "[")) {
        const close = line.indexOf("?>", i);
        if (close < 0) break;
        i = close - 1;
      } else if (line.startsWith("/*", i)) {
        state = { kind: "comment", close: "*/", from: l };
        i++;
      } else if (line.startsWith("<<<", i)) {
        const id = line.slice(i + 3).match(/^\s*["']?([A-Za-z_]\w*)["']?\s*$/)?.[1];
        if (id) {
          state = { kind: "heredoc", close: id, from: l };
          break;
        }
      } else if (ch === "'" || ch === '"') {
        let j = i + 1;
        for (; j < line.length && line[j] !== ch; j++) if (line[j] === "\\") j++;
        if (j < line.length) i = j;
        else {
          state = { kind: "string", close: ch, from: l };
          break;
        }
      }
    }
  }
  if (state) for (let r = state.from; r < lines.length; r++) out.add(r);
  return out;
}

// Every PHP file of the component outside vendor/, linted one at a time, since `php -l` reads one.
const LINT_ALL = "find . -name '*.php' -not -path './vendor/*' -not -path './node_modules/*' -not -path './var/*' -not -path './storage/*' -print0 | xargs -0 -n1 php -l >/dev/null";

export const php: LanguageDef = {
  id: "php",
  label: "PHP",
  codes: ["php"],
  stacks: [
    {
      id: "php",
      label: "PHP",
      kind: "stack",
      tier: "supported",
      files: /\.php$|(^|\/)composer\.(json|lock)$/,
      reason: "runs in the official Composer image whose PHP (8.5, 8.4 or 8.3) composer.json's require.php allows; extensions beyond that image's must be added by the repo's .cursor/environment.json",
      proof: ["fixtures/php-composer", "symfony/demo@f42980c"],
    },
  ],
  detect: {
    manifests: [{ match: /^composer\.json$/, stack: "php", rank: 60 }],
    sources: [{ ext: /\.php$/, stack: "php", rank: 70 }],
    rootApp: { names: ["composer.json"], stack: "php", toolchain: "PHP", suffix: "php", rank: 10 },
    lockfiles: ["composer.lock"],
    projectName: (_tree, manifest, text) => (manifest === "composer.json" ? text.match(/"name"\s*:\s*"(?:[^"/]+\/)?([^"]+)"/)?.[1] : undefined),
  },
  ecosystems: [composer],
  checks: {
    weakening: { isTest: isTest, markers: null },
    lockfiles: { diff: ["composer.lock"], secretScanSkips: [], foreign: null },
    manifestScripts: null,
    tool: /^(composer|php|phpunit|vendor\/bin\/\S+)$/,
  },
  replay: {
    classify: () => ({ language: "php", packageManager: "composer" }),
    image: phpImage,
    images: Object.fromEntries(PHP_IMAGES.map((i) => [i.tag, i.digest])),
    doctor: "php --version && composer --version",
    pins: (tree, dir) => {
      const file = dir === "." ? "composer.json" : `${dir}/composer.json`;
      return phpConstraint(tree, dir) ? { found: [file], missing: [] } : { found: [], missing: ["the PHP version (require.php in composer.json)"] };
    },
    commands: phpCommands,
    testCounts: phpTestCounts,
    mutation: {
      isTest,
      isSource,
      covered: (_tree, comp, tests, files) => namedAfter(tests, inComponent(files, comp.path), isSource),
      sites: phpSites,
      quoted: phpQuoted,
      compileProbe: (comp) => ({ command: LINT_ALL, cwd: comp.path }),
      compileError: (output) => /(PHP )?Parse error:|Errors parsing /.test(output),
    },
  },
};