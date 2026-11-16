import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { discoverContract } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { ecosystemOf } from "../skill/agent-readiness/scripts/lib/languages/index.ts";
import { allows, composerRootVersion, php, phpImage, phpQuoted, phpSites, phpTestCounts } from "../skill/agent-readiness/scripts/lib/languages/php.ts";
import { ruby, rubyImage, rubyQuoted, rubySites, rubyTestCounts } from "../skill/agent-readiness/scripts/lib/languages/ruby.ts";
import { allSites, targetFiles, testFiles } from "../skill/agent-readiness/scripts/lib/mutate.ts";
import { buildProfile } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { loadRubric, latestRubricVersion } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import type { Component } from "../skill/agent-readiness/scripts/lib/types.ts";
import { exportTree } from "../skill/agent-readiness/scripts/lib/workspace.ts";

const rubric = loadRubric(latestRubricVersion());

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lang-php-ruby-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const comp = (path = "."): Component => ({ id: "c", path, language: "php", manifest: null, scripts: {}, changes: 0, changeShare: 0, assessed: true });
const commands = (lang: typeof php | typeof ruby, files: Record<string, string>) => lang.replay!.commands(repo(files), comp()).map((c) => `${c.kind}: ${c.command}`);
const ops = (sites: { operator: string; after: string }[]) => sites.map((s) => `${s.operator}: ${s.after.trim()}`);

describe("PHP", () => {
  test("Composer constraints: carets, tildes, ranges, wildcards and alternatives", () => {
    assert.equal(allows("^8.3", "8.5.12"), true);
    assert.equal(allows("^7.4", "8.5.12"), false);
    assert.equal(allows("^7.2.5 || ^8.0", "8.4.14"), true);
    assert.equal(allows("~8.3.0", "8.4.14"), false);
    assert.equal(allows("~8.3.0", "8.3.12"), true);
    assert.equal(allows(">=8.1 <8.5", "8.5.12"), false);
    assert.equal(allows(">=8.1,<8.5", "8.4.14"), true);
    assert.equal(allows("8.4.*", "8.4.14"), true);
    assert.equal(allows(">=8.5.12", "8.5.12"), true);
    assert.equal(allows("8.2 - 8.4", "8.4.14"), true);
  });

  test("the image is the newest Composer image whose PHP require.php allows", () => {
    const image = (php?: string) => phpImage(repo({ "composer.json": JSON.stringify(php ? { require: { php } } : {}) }), ".");
    assert.equal(image("^8.2"), "composer:2.11");
    assert.equal(image("~8.4.0"), "composer:2.8");
    assert.equal(image(">=8.1 <8.4"), "composer:2.7");
    assert.equal(image(), "composer:2.11", "no constraint: the newest");
    assert.equal(image("^7.4"), "composer:2.11", "nothing fits: the newest, so Composer's platform check explains");
  });

  test("require.php pins the toolchain", () => {
    assert.deepEqual(php.replay!.pins(repo({ "api/composer.json": '{"require":{"php":"^8.3"}}' }), "api"), { found: ["api/composer.json"], missing: [] });
    assert.deepEqual(php.replay!.pins(repo({ "composer.json": "{}" }), "."), { found: [], missing: ["the PHP version (require.php in composer.json)"] });
  });

  test("commands: the test script first, then Pest or PHPUnit; linters and analysers check-only, only with their config", () => {
    const dev = (pkgs: string[], extra: Record<string, unknown> = {}) => JSON.stringify({ "require-dev": Object.fromEntries(pkgs.map((p) => [p, "*"])), ...extra });
    assert.deepEqual(commands(php, { "composer.json": dev(["phpunit/phpunit", "friendsofphp/php-cs-fixer", "phpstan/phpstan"]), "phpstan.dist.neon": "" }), [
      "test: vendor/bin/phpunit",
      "lint: vendor/bin/php-cs-fixer fix --dry-run --diff",
      "typecheck: vendor/bin/phpstan analyse --no-progress --memory-limit=1G",
    ]);
    assert.deepEqual(commands(php, { "composer.json": dev(["pestphp/pest", "laravel/pint", "phpstan/phpstan"], { scripts: { test: "pest" } }) }), ["test: composer run-script --timeout=0 test", "lint: vendor/bin/pint --test"]);
    assert.deepEqual(commands(php, { "composer.json": dev(["squizlabs/php_codesniffer", "vimeo/psalm"]), "phpcs.xml.dist": "", "psalm.xml": "" }), ["lint: vendor/bin/phpcs", "typecheck: vendor/bin/psalm --no-progress"]);
  });

  // The Mac's open-network run of guzzle/guzzle@f8aca40 failed its install with "guzzlehttp/test-server
  // 1.1.0 requires guzzlehttp/guzzle ^8.1": on the audit's detached checkout Composer named the root
  // dev-f8aca40..., where guzzle's own CI sets COMPOSER_ROOT_VERSION: 8.5.x-dev.
  test("the Composer install names the root version, which a detached checkout loses (guzzle/guzzle@f8aca40)", () => {
    const install = (dir: string, path = ".") => ecosystemOf("composer")!.install(dir, path, { ignoreScripts: false });
    const guzzle = repo({
      "composer.json": JSON.stringify({ name: "guzzlehttp/guzzle", require: { php: "^7.4 || ^8.0" }, "require-dev": { "guzzlehttp/test-server": "^1.1", "phpunit/phpunit": "^9.6.34" } }),
      ".github/workflows/ci.yml": "name: CI\n\non:\n  push:\n\nenv:\n  COMPOSER_ROOT_VERSION: 8.5.x-dev\n\njobs:\n  build:\n    runs-on: ubuntu-24.04\n",
    });
    const plan = install(guzzle);
    assert.equal(plan.command, "COMPOSER_ROOT_VERSION=8.5.x-dev composer install --no-interaction --no-progress");
    assert.equal(plan.reason, "no composer.lock, so the install can't be frozen, with the root package as 8.5.x-dev (the COMPOSER_ROOT_VERSION .github/workflows/ci.yml sets), since the audit's detached checkout has no branch");
    assert.equal(plan.frozen, false);

    const aliased = repo({ "composer.json": JSON.stringify({ name: "acme/lib", extra: { "branch-alias": { "dev-main": "3.x-dev", "dev-2.x": "2.x-dev" } } }) });
    assert.deepEqual(composerRootVersion(aliased, "."), { version: "3.x-dev", from: "composer.json's branch-alias" }, "the highest alias");
    assert.deepEqual(composerRootVersion(repo({ "packages/a/composer.json": JSON.stringify({ name: "acme/a", extra: { "branch-alias": { "dev-main": "1.2-dev" } } }) }), "packages/a"), { version: "1.2-dev", from: "composer.json's branch-alias" });

    for (const json of [{ name: "acme/app", type: "project" }, { name: "acme/lib", version: "1.0.0" }, {}]) {
      assert.equal(composerRootVersion(repo({ "composer.json": JSON.stringify(json), ".github/workflows/ci.yml": "env:\n  COMPOSER_ROOT_VERSION: 9.0.x-dev\n" }), "."), null, JSON.stringify(json));
    }
    assert.equal(install(repo({ "composer.json": JSON.stringify({ name: "acme/app", type: "project" }), "composer.lock": "{}" })).command, "composer install --no-interaction --no-progress", "an application keeps the plain install (symfony/demo)");
    assert.equal(composerRootVersion(repo({ "composer.json": '{"name":"acme/lib"}', ".github/workflows/ci.yml": "env:\n  COMPOSER_ROOT_VERSION: ${{ matrix.v }}\n" }), "."), null, "only a literal version reaches the shell");
  });

  test("with nothing declared, the root version is the latest release tag of the repo the one-commit tree came from", () => {
    const host = repo({ "composer.json": '{"name":"acme/lib"}' });
    const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=Contributor A", "-c", "user.email=a@example.com", ...args], { cwd: host, encoding: "utf8" }).trim();
    g("init", "-q");
    g("add", ".");
    g("commit", "-q", "-m", "one");
    g("tag", "v8.4.0");
    g("tag", "8.10.1");
    g("tag", "8.11.0-beta1");
    g("commit", "-q", "--allow-empty", "-m", "two");
    g("tag", "9.0.0", "HEAD");
    g("commit", "-q", "--allow-empty", "-m", "three");
    const commit = g("rev-parse", "HEAD~1");
    const tree = mkdtempSync(join(tmpdir(), "lang-php-tree-"));
    exportTree(host, commit, tree);
    assert.deepEqual(composerRootVersion(tree, "."), { version: "9.0.0", from: "the latest release tag" });
    const older = mkdtempSync(join(tmpdir(), "lang-php-tree-"));
    exportTree(host, g("rev-parse", "HEAD~2"), older);
    assert.deepEqual(composerRootVersion(older, "."), { version: "8.10.1", from: "the latest release tag" }, "version order, not text order, and no pre-release");
    assert.equal(composerRootVersion(repo({ "composer.json": '{"name":"acme/lib"}' }), "."), null, "no git, no tag");
  });

  test("test counts from PHPUnit and Pest", () => {
    assert.deepEqual(phpTestCounts("OK (12 tests, 30 assertions)\n"), { passed: 12, failed: 0, total: 12 });
    assert.deepEqual(phpTestCounts("FAILURES!\nTests: 12, Assertions: 30, Failures: 2, Errors: 1, Skipped: 1.\n"), { passed: 8, failed: 3, total: 12 });
    assert.deepEqual(phpTestCounts("  Tests:    1 failed, 2 skipped, 10 passed (30 assertions)\n"), { passed: 10, failed: 1, total: 13 });
    assert.equal(phpTestCounts("no summary"), null);
  });

  test("fault sites: C-like conditions, `;` for a dropped throw, and never comments, attributes or declare()", () => {
    assert.deepEqual(ops(phpSites("        if ($n > 10) {")), ["boundary_flip: if ($n >= 10) {", "negate_condition: if (!($n > 10)) {", "change_constant: if ($n > 11) {"]);
    assert.deepEqual(ops(phpSites("        } elseif ($n === 0) {")), ["negate_condition: } elseif (!($n === 0)) {", "change_constant: } elseif ($n === 1) {"]);
    assert.deepEqual(ops(phpSites("            throw new \\RuntimeException('bad');")), ["drop_throw_or_return: ;"]);
    assert.deepEqual(ops(phpSites("        return $a <=> $b; // 1 or -1")), []);
    for (const line of ["# retries 3 times", "#[Route('/blog/{page}', requirements: ['page' => '\\d+'], priority: 2)]", "declare(strict_types=1);", " * @return int<0, 100>", "use Foo\\Bar2;", "$x = 'a > b';"]) assert.deepEqual(phpSites(line), [], line);
  });

  test("text spans: inline HTML, block comments, multi-line strings and heredocs", () => {
    const text = ["<html>", "<?php", "/* a", " 1 > 2 */", "$sql = 'SELECT 1", "  FROM t WHERE n > 2';", "$t = <<<EOT", "  5 > 4", "  EOT;", "$n = 1;", "?>", "<p>3 > 2</p>"].join("\n");
    assert.deepEqual([...phpQuoted(text)].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 7, 8, 11]);
  });

  test("a test covers the source named after it, outside vendor/ and config/", () => {
    const dir = repo({ "composer.json": "{}", "src/Order.php": "", "src/Cart.php": "", "config/Order.php": "", "vendor/x/Order.php": "", "tests/Unit/OrderTest.php": "" });
    const profile = buildProfile(dir, dir, rubric);
    const c = profile.components.find((x) => x.assessed)!;
    assert.deepEqual([c.language, c.packageManager], ["php", "composer"]);
    assert.deepEqual(testFiles(dir, c), ["tests/Unit/OrderTest.php"]);
    assert.deepEqual(targetFiles(dir, c), ["src/Order.php"]);
    assert.equal(php.replay!.mutation.compileError!("PHP Parse error:  syntax error, unexpected token \";\" in src/Order.php on line 4"), true);
  });
});

describe("Ruby", () => {
  test("the image follows .ruby-version, .tool-versions, the Gemfile, then Gemfile.lock, to the nearest pinned minor", () => {
    assert.equal(rubyImage(repo({ ".ruby-version": "ruby-3.3.6\n" }), "."), "ruby:3.3-bookworm");
    assert.equal(rubyImage(repo({ ".tool-versions": "nodejs 22.1.0\nruby 4.0.3\n" }), "."), "ruby:4.0-bookworm");
    assert.equal(rubyImage(repo({ Gemfile: 'source "https://rubygems.org"\nruby "~> 3.2.0"\n' }), "."), "ruby:3.2-bookworm");
    assert.equal(rubyImage(repo({ "Gemfile.lock": "RUBY VERSION\n   ruby 3.3.1p55\n" }), "."), "ruby:3.3-bookworm");
    assert.equal(rubyImage(repo({ ".ruby-version": "3.1.4\n" }), "."), "ruby:3.2-bookworm", "an older minor gets the nearest newer one");
    assert.equal(rubyImage(repo({ ".ruby-version": "5.1.0\n" }), "."), "ruby:4.0-bookworm");
    assert.equal(rubyImage(repo({ Gemfile: "" }), "."), "ruby:3.4-bookworm");
  });

  test("pins: the file that names Ruby's version, the component's before the root's", () => {
    assert.deepEqual(ruby.replay!.pins(repo({ ".ruby-version": "3.4.1\n", "api/Gemfile": "" }), "api"), { found: [".ruby-version"], missing: [] });
    assert.deepEqual(ruby.replay!.pins(repo({ Gemfile: "" }), "."), { found: [], missing: ["the Ruby version (.ruby-version, or a ruby line in the Gemfile)"] });
  });

  test("commands come from the bundle: RSpec, Rails, a Rake test task or bare minitest; RuboCop or Standard; Sorbet or Steep", () => {
    const lock = (gems: string[]) => `GEM\n  remote: https://rubygems.org/\n  specs:\n${gems.map((g) => `    ${g} (1.0.0)\n`).join("")}\n`;
    assert.deepEqual(commands(ruby, { "Gemfile.lock": lock(["rspec-core", "rubocop"]), "spec/a_spec.rb": "", ".rubocop.yml": "" }), ["test: bundle exec rspec", "lint: bundle exec rubocop"]);
    assert.deepEqual(commands(ruby, { "Gemfile.lock": lock(["rake", "minitest", "sorbet-static"]), Rakefile: 'require "rake/testtask"\nRake::TestTask.new(:test)\n', "sorbet/config": "." }), ["test: bundle exec rake test", "typecheck: bundle exec srb tc"]);
    assert.deepEqual(commands(ruby, { "Gemfile.lock": lock(["railties", "standard"]), "bin/rails": "", "config/application.rb": "" }), ["test: bin/rails test", "lint: bundle exec standardrb"]);
    assert.match(commands(ruby, { Gemfile: 'gem "minitest"\n', "test/a_test.rb": "" })[0], /^test: bundle exec ruby -Ilib -Itest -e /);
    assert.deepEqual(commands(ruby, { "Gemfile.lock": lock(["rubocop"]) }), [], "RuboCop only with the repo's .rubocop.yml");
  });

  test("a gem with no Gemfile.lock: the Gemfile and gemspec name the tools as users write them (rspec, rails, sorbet)", () => {
    const gemspec = (deps: string[]) => `Gem::Specification.new do |spec|\n  spec.name = "x"\n${deps.map((d) => `  spec.add_development_dependency '${d}'\n`).join("")}end\n`;
    assert.deepEqual(commands(ruby, { Gemfile: "source 'https://rubygems.org'\ngemspec\n", "x.gemspec": gemspec(["rake", "rspec", "rubocop"]), "spec/x_spec.rb": "", ".rubocop.yml": "" }), ["test: bundle exec rspec", "lint: bundle exec rubocop"]);
    assert.deepEqual(commands(ruby, { Gemfile: 'gem "rake"\ngem "rspec"\n', Rakefile: "require 'rspec/core/rake_task'\nRSpec::Core::RakeTask.new(:unit) do |t|\n  t.pattern = 'checks/**/*_check.rb'\nend\n" }), ["test: bundle exec rake unit"], "an RSpec rake task with its own pattern");
    assert.deepEqual(commands(ruby, { Gemfile: 'gem "rails", "~> 8.0"\n', "bin/rails": "", "config/application.rb": "" }), ["test: bin/rails test"]);
    assert.deepEqual(commands(ruby, { Gemfile: 'gem "sorbet", group: :development\ngem "minitest"\n', "sorbet/config": ".", "test/a_test.rb": "" }).map((c) => c.split(":")[0]), ["test", "typecheck"]);
    assert.deepEqual(commands(ruby, { Gemfile: 'gem "rake"\ngem "minitest"\n', Rakefile: "Rake::TestTask.new(:unit) { |t| t.pattern = 'test/**/*_test.rb' }\n" }), ["test: bundle exec rake unit"]);
    assert.deepEqual(commands(ruby, { "x.gemspec": "Gem::Specification.new do |s|\n  s.add_runtime_dependency 'rspec-core'\nend\n", "spec/a_spec.rb": "" }), ["test: bundle exec rspec"]);
  });

  test("jwt/ruby-jwt's shape (no Gemfile.lock, rspec in the gemspec, RSpec::Core::RakeTask.new(:test)) gets RSpec, not 'no tests'", () => {
    const dir = repo({
      Gemfile: "# frozen_string_literal: true\n\nsource 'https://rubygems.org'\n\ngemspec\n",
      "ruby-jwt.gemspec": "Gem::Specification.new do |spec|\n  spec.name = 'jwt'\n  spec.add_dependency 'base64'\n  spec.add_development_dependency 'rake'\n  spec.add_development_dependency 'rspec'\n  spec.add_development_dependency 'rubocop'\nend\n",
      Rakefile: "require 'rspec/core/rake_task'\nrequire 'rubocop/rake_task'\n\nRSpec::Core::RakeTask.new(:test)\nRuboCop::RakeTask.new(:rubocop)\n\ntask default: %i[rubocop test]\n",
      ".rubocop.yml": "",
      "lib/jwt/encode.rb": "",
      "spec/jwt/encode_spec.rb": "",
    });
    const profile = buildProfile(dir, dir, rubric);
    const c = profile.components.find((x) => x.assessed)!;
    const contract = discoverContract(profile, dir, rubric, []).map((x) => [x.kind, x.command, x.source]);
    assert.deepEqual(contract, [
      ["doctor", "ruby --version && bundle --version", "readiness"],
      ["install", "bundle install", "readiness"],
      ["test", "bundle exec rspec", "Gemfile or gemspec rspec"],
      ["lint", "bundle exec rubocop", ".rubocop.yml"],
    ]);
    assert.deepEqual(targetFiles(dir, c), ["lib/jwt/encode.rb"]);
  });

  test("test counts from minitest, test-unit and RSpec, summed over runs", () => {
    assert.deepEqual(rubyTestCounts("239 runs, 615 assertions, 0 failures, 0 errors, 0 skips\n"), { passed: 239, failed: 0, total: 239 });
    assert.deepEqual(rubyTestCounts("10 runs, 19 assertions, 1 failures, 1 errors, 2 skips\n5 tests, 9 assertions, 1 failures, 0 errors, 0 pendings, 0 omissions\n"), { passed: 10, failed: 3, total: 15 });
    assert.deepEqual(rubyTestCounts("12 examples, 1 failure, 2 pending\n"), { passed: 9, failed: 1, total: 12 });
    assert.equal(rubyTestCounts("no summary"), null);
  });

  test("fault sites: conditions without parentheses, modifiers, implicit returns, and never comments or class lines", () => {
    assert.deepEqual(ops(rubySites("    if points >= 5000")), ["boundary_flip: if points > 5000", "negate_condition: if !(points >= 5000)", "change_constant: if points >= 5001"]);
    assert.deepEqual(ops(rubySites("    return 0 unless cost < balance # 2 more")), ["boundary_flip: return 0 unless cost <= balance # 2 more", "negate_condition: return 0 unless !(cost < balance) # 2 more", "change_constant: return 1 unless cost < balance # 2 more"]);
    assert.deepEqual(ops(rubySites("      true")), ["swap_return: false"]);
    assert.deepEqual(ops(rubySites('      raise ArgumentError, "bad"')), ["drop_throw_or_return: nil"]);
    assert.deepEqual(ops(rubySites("    if a &&")), [], "a condition that continues on the next line");
    assert.deepEqual(ops(rubySites("    while queue.size > 0")), ["boundary_flip: while queue.size >= 0", "change_constant: while queue.size > 1"], "loop conditions aren't negated");
    for (const line of ["# retries 3 times", "class Admin < User", "  validates :name, if: :active?", "require_relative 'v2'", "x = 'a > b'", "sleep 5"]) assert.deepEqual(rubySites(line), [], line);
  });

  test("text spans: =begin blocks, heredocs, multi-line strings and %-literals, and everything after __END__", () => {
    const text = ["=begin", "1 > 2", "=end", "x = <<~SQL", "  n > 2", "SQL", "y = %w[", "  a 1", "]", "z = 'a", "b 2'", "n = 1 # 'quoted", "__END__", "3 > 2"].join("\n");
    assert.deepEqual([...rubyQuoted(text)].sort((a, b) => a - b), [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 12, 13]);
  });

  test("a spec covers the source named after it, and the contract installs frozen with Bundler", () => {
    const dir = repo({ Gemfile: 'gem "rspec"\n', "Gemfile.lock": "GEM\n  specs:\n    rspec-core (3.13.0)\n", ".ruby-version": "3.4.1\n", "lib/shop/cart.rb": "", "lib/shop/order.rb": "", "db/cart.rb": "", "spec/shop/cart_spec.rb": "" });
    const profile = buildProfile(dir, dir, rubric);
    const c = profile.components.find((x) => x.assessed)!;
    assert.deepEqual([c.language, c.packageManager], ["ruby", "bundler"]);
    assert.deepEqual(targetFiles(dir, c), ["lib/shop/cart.rb"]);
    const contract = discoverContract(profile, dir, rubric, []).map((x) => [x.kind, x.command]);
    assert.deepEqual(contract, [["doctor", "ruby --version && bundle --version"], ["install", "BUNDLE_FROZEN=true bundle install"], ["test", "bundle exec rspec"]]);
    assert.equal(ruby.replay!.mutation.compileError!("lib/shop/cart.rb:3: syntax errors found (SyntaxError)"), true);
  });

  test("allSites uses the Ruby rules for a Ruby component", () => {
    const dir = repo({ "lib/a.rb": "def f(n)\n  # 3 > 2\n  n > 3\nend\n" });
    assert.deepEqual(allSites(dir, ["lib/a.rb"], "ruby").map((s) => `${s.line} ${s.operator}`), ["3 boundary_flip", "3 change_constant"]);
  });
});
