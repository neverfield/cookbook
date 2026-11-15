import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Site } from "../mutate.ts";
import type { Component } from "../types.ts";
import { exists, readText } from "../util.ts";
import { inComponent, namedAfter } from "./coverage.ts";
import type { DraftCommand, Ecosystem, LanguageDef } from "./language.ts";

// Owned by the PHP and Ruby group.

const bundler: Ecosystem = {
  id: "bundler",
  label: "Bundler",
  lockfiles: ["Gemfile.lock"],
  rule: "`bundle install` in frozen mode (`BUNDLE_FROZEN=true`) from a committed `Gemfile.lock`",
  install: (tree, path) =>
    exists(join(tree, path, "Gemfile.lock"))
      ? { command: "BUNDLE_FROZEN=true bundle install", reason: "frozen install from Gemfile.lock", frozen: true }
      : { command: "bundle install", reason: "no Gemfile.lock, so the install can't be frozen", frozen: false },
  unpinned: (tree, path) => (exists(join(tree, path, "Gemfile.lock")) ? null : "no Gemfile.lock is committed"),
};

// The official Ruby images on Debian bookworm, which have the compilers native gems need. Read with
// `docker buildx imagetools inspect` on Nov 15, 2026.
const RUBY_IMAGES: Record<string, string> = {
  "ruby:3.2-bookworm": "sha256:bf13a46a498fb4055d0e52495c351a2648c8bc8d41b473ee3f734041a74c7f56",
  "ruby:3.3-bookworm": "sha256:ae098d019fd2995e6cb82e16a87529348ba26a7c83ad6189937decc2846b0730",
  "ruby:3.4-bookworm": "sha256:d7c312a48736dd291d7ce043c847f04dfde9bdf7334491ca6a545a4a184395be",
  "ruby:4.0-bookworm": "sha256:862aacfe5415f2dcb399677d9139963ef4cd989140096cf723a91256ae8a9de3",
};
const RUBY_MINORS = ["3.2", "3.3", "3.4", "4.0"];
const DEFAULT_RUBY = "3.4";

const read = (tree: string, dir: string, name: string) => (exists(join(tree, dir, name)) ? readText(join(tree, dir, name)) : "");

// The files that pin Ruby's version, the component's own before the repo root's.
function rubyPin(tree: string, dir: string): { file: string; version: string } | null {
  for (const d of [...new Set([dir, "."])]) {
    const at = (f: string) => (d === "." ? f : `${d}/${f}`);
    const rv = read(tree, d, ".ruby-version").trim().replace(/^ruby-/, "");
    if (/^\d+\.\d+/.test(rv)) return { file: at(".ruby-version"), version: rv };
    const tv = read(tree, d, ".tool-versions").match(/^ruby\s+(\d+\.\d+\S*)/m)?.[1];
    if (tv) return { file: at(".tool-versions"), version: tv };
    const gf = read(tree, d, "Gemfile").match(/^\s*ruby\s*\(?\s*["'][~>=<\s]*(\d+\.\d+[\d.]*)["']/m)?.[1];
    if (gf) return { file: at("Gemfile"), version: gf };
  }
  return null;
}

// The pinned version's image; else the one Gemfile.lock was resolved on; else the default. A minor
// the table lacks gets the nearest newer one, or the newest.
export function rubyImage(tree: string, dir: string): string {
  const version = rubyPin(tree, dir)?.version ?? read(tree, dir, "Gemfile.lock").match(/^RUBY VERSION\s+ruby (\d+\.\d+)/m)?.[1] ?? DEFAULT_RUBY;
  const [maj, min] = version.split(".").map(Number);
  const pick = RUBY_MINORS.find((m) => {
    const [a, b] = m.split(".").map(Number);
    return a > maj || (a === maj && b >= min);
  });
  return `ruby:${pick ?? RUBY_MINORS[RUBY_MINORS.length - 1]}-bookworm`;
}

// Gems the component's bundle holds: Gemfile.lock's specs, or the Gemfile's and gemspec's names.
function gems(tree: string, dir: string): Set<string> {
  const lock = read(tree, dir, "Gemfile.lock");
  if (lock) return new Set([...lock.matchAll(/^ {4}([\w.-]+) \(/gm)].map((m) => m[1]));
  const gemspecs = exists(join(tree, dir)) ? readdirSync(join(tree, dir)).filter((f) => f.endsWith(".gemspec")) : [];
  const text = [read(tree, dir, "Gemfile"), ...gemspecs.map((f) => read(tree, dir, f))].join("\n");
  return new Set([...text.matchAll(/^\s*(?:gem|\w+\.add_(?:development_)?dependency)\s*\(?\s*["']([\w.-]+)["']/gm)].map((m) => m[1]));
}

const TEST_TASK = /Rake::TestTask|task\s*\(?\s*[:"']test\b|default:\s*:test|default\s*=>\s*:test/;

function rubyCommands(tree: string, comp: Component): DraftCommand[] {
  const dir = comp.path;
  const g = gems(tree, dir);
  const has = (f: string) => exists(join(tree, dir, f));
  const out: DraftCommand[] = [];
  if (g.has("rspec-core") && has("spec")) out.push({ kind: "test", command: "bundle exec rspec", source: "Gemfile.lock rspec-core", reason: "RSpec, which the bundle holds" });
  else if (g.has("railties") && has("bin/rails") && has("config/application.rb")) out.push({ kind: "test", command: "bin/rails test", source: "bin/rails", reason: "the Rails app's test runner" });
  else if (g.has("rake") && TEST_TASK.test(read(tree, dir, "Rakefile"))) out.push({ kind: "test", command: "bundle exec rake test", source: "Rakefile", reason: "the Rakefile's test task" });
  else if ((g.has("minitest") || g.has("test-unit")) && has("test")) {
    out.push({ kind: "test", command: `bundle exec ruby -Ilib -Itest -e 'Dir.glob("test/**/{*_test,test_*}.rb").sort.each { |f| require File.expand_path(f) }'`, source: "readiness", reason: "every test file under test/, with the bundle's test framework" });
  }
  if (g.has("standard") && !g.has("rubocop-rails-omakase")) out.push({ kind: "lint", command: "bundle exec standardrb", source: "Gemfile.lock standard", reason: "Standard Ruby, check-only" });
  else if (g.has("rubocop") && has(".rubocop.yml")) out.push({ kind: "lint", command: "bundle exec rubocop", source: ".rubocop.yml", reason: "RuboCop with the repo's config, without autocorrect" });
  if (g.has("sorbet-static") && has("sorbet/config")) out.push({ kind: "typecheck", command: "bundle exec srb tc", source: "sorbet/config", reason: "Sorbet with the repo's config" });
  else if (g.has("steep") && has("Steepfile")) out.push({ kind: "typecheck", command: "bundle exec steep check", source: "Steepfile", reason: "Steep with the repo's Steepfile" });
  return out;
}

// Minitest's `239 runs, 615 assertions, 0 failures, 0 errors, 0 skips`, RSpec's `12 examples,
// 1 failure, 2 pending` and test-unit's `5 tests, 9 assertions, 0 failures, 0 errors, 0 pendings`.
// Several runs (a Rakefile with more than one test task) are summed.
export function rubyTestCounts(output: string): { passed: number; failed: number; total: number } | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  let passed = 0;
  let failed = 0;
  let total = 0;
  let seen = false;
  for (const m of text.matchAll(/^(\d+) (?:runs|tests), \d+ assertions, (\d+) failures, (\d+) errors, (\d+) (?:skips|pendings)/gm)) {
    seen = true;
    const [n, f, e, s] = [m[1], m[2], m[3], m[4]].map(Number);
    passed += n - f - e - s;
    failed += f + e;
    total += n;
  }
  for (const m of text.matchAll(/^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/gm)) {
    seen = true;
    const [n, f, p] = [m[1], m[2], m[3] ?? "0"].map(Number);
    passed += n - f - p;
    failed += f;
    total += n;
  }
  return seen ? { passed, failed, total } : null;
}

const RUBY_TEST = /(^|\/)(test|spec)\/(.*\/)?([^/]*_(test|spec)|test_[^/]*)\.rb$/;
const NOT_SOURCE = /(^|\/)(vendor|node_modules|test|spec|db|config|bin|tmp|log)\//;

const isTest = (f: string) => RUBY_TEST.test(f);
const isSource = (f: string) => f.endsWith(".rb") && !isTest(f) && !NOT_SOURCE.test(f);

// Where a line's code ends: at a `#` comment outside a string (`#{` inside one is interpolation).
function codeEnd(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "$" || ch === "?") i++;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "#") return i;
  }
  return line.length;
}

function firstCode(line: string, re: RegExp, end: number): RegExpExecArray | null {
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

const SKIP_LINE = /^(#|=begin|=end|__END__|require(_relative)?\b|load\s|autoload\b|gem\s|source\s|class\s|module\s)/;
const BOUNDARY: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">" };
const TIMING = /(sleep|timeout|delay|ttl|expires?_in|expires?|retry|retries|backoff|interval)/i;
// A condition that continues on the next line, or a one-line `if a then b end`.
const OPEN_CONDITION = /(&&|\|\||\band|\bor|\bnot|[,(\[{=+\-*\/\\])$|\bthen\b/;

// Fault sites on one line of Ruby. Conditions have no parentheses (`if x`, `unless x`, and the
// modifier `return 0 if x`), a method's last expression is its return value, and `nil` stands in
// for a dropped `raise` or bare `return`. `while` and `until` are left alone: negating a loop
// condition mostly makes a loop that never ends, which only burns the time budget.
export function rubySites(line: string): Omit<Site, "file" | "line">[] {
  const trimmed = line.trim();
  if (!trimmed || SKIP_LINE.test(trimmed)) return [];
  const end = codeEnd(line);
  const code = line.slice(0, end).trimEnd();
  const out: Omit<Site, "file" | "line">[] = [];
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const swap = (at: number, len: number, by: string) => line.slice(0, at) + by + line.slice(at + len);
  const b = firstCode(line, / (<=|>=|<|>) /, end);
  if (b) out.push({ operator: "boundary_flip", before: line, after: swap(b.index, b[0].length, ` ${BOUNDARY[b[1]]} `) });
  const c = firstCode(line, /(?<![\w.:@$])(if|elsif|unless) (?!then\b)/, end);
  if (c) {
    const start = c.index + c[0].length;
    const cond = code.slice(start).trim();
    if (cond && !OPEN_CONDITION.test(cond) && !/\bdo\b|\{\s*\|/.test(cond)) out.push({ operator: "negate_condition", before: line, after: line.slice(0, start) + `!(${cond})` + line.slice(start + code.slice(start).length) });
  }
  const s = firstCode(line, / ([+-]) 1(?![\d._])/, end);
  if (s) out.push({ operator: "shift_by_one", before: line, after: swap(s.index, s[0].length, ` ${s[1] === "+" ? "-" : "+"} 1`) });
  const r = firstCode(line, /\breturn (true|false)\b/, end);
  const flip = (v: string) => (v === "true" ? "false" : "true");
  if (r) out.push({ operator: "swap_return", before: line, after: swap(r.index, r[0].length, `return ${flip(r[1])}`) });
  else if (code.trim() === "true" || code.trim() === "false") out.push({ operator: "swap_return", before: line, after: `${indent}${flip(code.trim())}` });
  if ((/^raise\b/.test(code.trim()) && !/[,(\\]$/.test(code)) || code.trim() === "return") out.push({ operator: "drop_throw_or_return", before: line, after: `${indent}nil` });
  const k = firstCode(line, /(?<![\w.$@:?])(\d+)(?![\w.])/, end);
  if (k && !TIMING.test(code)) {
    const n = Number(k[1]);
    if (Number.isSafeInteger(n)) out.push({ operator: "change_constant", before: line, after: swap(k.index, k[1].length, String(n + 1)) });
  }
  return out.filter((x) => x.after !== x.before);
}

const PERCENT_CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

// 0-based lines that hold text rather than code: `=begin` blocks, heredoc bodies, strings and
// %-literals that span lines, and everything after `__END__`.
export function rubyQuoted(text: string): Set<number> {
  const out = new Set<number>();
  const lines = text.split("\n");
  let open: { close: string; nest?: string; depth: number; from: number } | null = null;
  const heredocs: { id: string; squiggly: boolean }[] = [];
  const span = (from: number, to: number) => {
    if (to > from) for (let r = from; r <= to; r++) out.add(r);
  };
  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    if (!open && /^__END__\s*$/.test(line)) {
      span(l, lines.length - 1);
      break;
    }
    if (!open && /^=begin\b/.test(line)) {
      for (; l < lines.length && !/^=end\b/.test(lines[l]); l++) out.add(l);
      out.add(l);
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (open) {
        if (ch === "\\") i++;
        else if (open.nest && ch === open.nest) open.depth++;
        else if (line.startsWith(open.close, i) && open.depth-- === 0) {
          span(open.from, l);
          open = null;
        }
        continue;
      }
      if (ch === "#") break;
      if (ch === "$" || ch === "?") {
        i++;
        continue;
      }
      const here = line.slice(i).match(/^<<([~-]?)(["'`]?)([A-Za-z_]\w*)\2/);
      if (here && (i === 0 || /[\s(,=]/.test(line[i - 1]))) {
        heredocs.push({ id: here[3], squiggly: here[1] !== "" });
        i += here[0].length - 1;
        continue;
      }
      const pct = line.slice(i).match(/^%[qQwWiIr]?([([{<|!\/])/);
      if (pct && (i === 0 || /[\s(,=\[]/.test(line[i - 1]))) {
        const d = pct[1];
        open = { close: PERCENT_CLOSE[d] ?? d, nest: PERCENT_CLOSE[d] ? d : undefined, depth: 0, from: l };
        i += pct[0].length - 1;
        continue;
      }
      if (ch === "'" || ch === '"') open = { close: ch, depth: 0, from: l };
    }
    while (heredocs.length) {
      const h = heredocs.shift()!;
      for (l++; l < lines.length; l++) {
        out.add(l);
        if ((h.squiggly ? lines[l].trim() : lines[l]) === h.id) break;
      }
    }
  }
  if (open) span(open.from, lines.length - 1);
  return out;
}

const SYNTAX_ALL = `ruby -e 'Dir.glob("**/*.rb").reject { |f| f.start_with?("vendor/", "node_modules/", "tmp/") }.each { |f| RubyVM::InstructionSequence.compile_file(f) }'`;

export const ruby: LanguageDef = {
  id: "ruby",
  label: "Ruby",
  codes: ["ruby"],
  stacks: [
    {
      id: "ruby",
      label: "Ruby",
      kind: "stack",
      tier: "supported",
      files: /\.(rb|rake|erb|gemspec)$|(^|\/)(Gemfile|Rakefile)(\.lock)?$/,
      reason: "runs in the official Ruby image (3.2 to 4.0) the repo's .ruby-version, .tool-versions or Gemfile names; Bundler switches to the version Gemfile.lock was bundled with",
      proof: ["fixtures/ruby-bundler", "Shopify/packwerk@31e5342"],
    },
  ],
  detect: {
    manifests: [{ match: /^Gemfile$/, stack: "ruby", rank: 50 }],
    sources: [{ ext: /\.rb$/, stack: "ruby", rank: 60 }],
    rootApp: { names: ["Gemfile"], stack: "ruby", toolchain: "Ruby", suffix: "ruby", rank: 20 },
    lockfiles: ["Gemfile.lock"],
  },
  ecosystems: [bundler],
  replay: {
    classify: () => ({ language: "ruby", packageManager: "bundler" }),
    image: rubyImage,
    images: RUBY_IMAGES,
    doctor: "ruby --version && bundle --version",
    pins: (tree, dir) => {
      const pin = rubyPin(tree, dir);
      return pin ? { found: [pin.file], missing: [] } : { found: [], missing: ["the Ruby version (.ruby-version, or a ruby line in the Gemfile)"] };
    },
    commands: rubyCommands,
    testCounts: rubyTestCounts,
    mutation: {
      isTest,
      isSource,
      covered: (_tree, comp, tests, files) => namedAfter(tests, inComponent(files, comp.path), isSource),
      sites: rubySites,
      quoted: rubyQuoted,
      compileProbe: (comp) => ({ command: SYNTAX_ALL, cwd: comp.path }),
      compileError: (output) => /SyntaxError|syntax errors? found|syntax error,/.test(output),
    },
  },
};
