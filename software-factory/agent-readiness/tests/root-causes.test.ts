import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { diagnose, rootError } from "../skill/agent-readiness/scripts/lib/diagnose.ts";
import { buildProfile } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { scanText } from "../skill/agent-readiness/scripts/lib/secrets.ts";
import { INSTALL_BLOCKED, environmentLimit, outputTail } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { validatePart1 } from "../support/evals/lib/part1.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { instructionItems } from "../skill/agent-readiness/scripts/lib/static.ts";
import type { Audit, ContractCommand, Diagnosis } from "../skill/agent-readiness/scripts/lib/types.ts";
import { makeAudit, reportFor } from "./helpers.ts";

// The Mac's open-network run of cursor/agent-readiness-0.2 at cb4e1a8 (Nov 16, 2026). Its sealed
// reports keep only each step's summary, so these outputs are each tool's real format around the
// lines that run quoted: gson's Surefire fork error and offline "module not found", moshi's Dokka
// variant failure, guzzle's root-package conflict (whose first 160 characters the CLI log kept),
// monolog's missing ext-mongodb, symfony/demo's unmatched PHPStan ignore, Newtonsoft.Json's six
// Windows-only tests, sinatra's PandocTest errors and rack's `bundle exec rubocop`.
const out = (name: string) => readFileSync(join(dirname(new URL(import.meta.url).pathname), "tool-outputs", `${name}.txt`), "utf8");
const cmd = (kind: ContractCommand["kind"]): ContractCommand => ({ id: `cmd-app-${kind}`, kind, component: "app", cwd: ".", command: "x", source: "readiness", reason: "x", timeoutSec: 600 });
const image = (name: string) => ({ where: "container" as const, image: name, imageSource: "audit" as const });

describe("the root error, not the build tool's closing lines", () => {
  test("google/gson's build names Surefire's error in test-jpms, not Maven's resume hint", () => {
    const d = diagnose(out("maven-jpms-surefire-fork"), false, "build");
    assert.equal(d.detail, "surefire:test failed in module test-jpms: java.lang.NoClassDefFoundError: module-info is not a class because access_flag ACC_MODULE is set");
    assert.equal(d.fromTool, true);
    assert.doesNotMatch(d.detail, /-rf :test-jpms/);
  });

  test("google/gson's lint names the files Spotless flagged", () => {
    assert.equal(diagnose(out("maven-spotless-violations"), false, "lint").detail, "spotless:check failed in module test-jpms: The following files had format violations: src/test/java/com/google/gson/jpms_test/ExportedPackagesTest.java");
  });

  test("square/moshi's install names Gradle's what-went-wrong, not \"BUILD FAILED in 4m 17s\"", () => {
    const d = diagnose(out("gradle-dokka-no-variant"), false, "install");
    assert.equal(d.detail, "Could not resolve all dependencies for configuration ':moshi:dokkaHtmlPublicationPluginApiOnly~internal': No matching variant of org.jetbrains.dokka:all-modules-page-plugin:2.0.0 was found.");
    assert.notEqual(d.cause, "network");
  });

  test("guzzle/guzzle's install gives Composer's whole conflict, not a message cut mid-URL", () => {
    const d = diagnose(out("composer-root-package"), false, "install");
    assert.equal(d.detail, "guzzlehttp/test-server 1.1.0 requires guzzlehttp/guzzle ^8.1 -> satisfiable by guzzlehttp/guzzle[8.1.0, ..., 8.5.x-dev] but guzzlehttp/guzzle is the root package and cannot be modified.");
    assert.equal(environmentLimit(image("composer:2.11"), cmd("install"), d, []), undefined, "a conflict in the repo's requirements stays the repo's");
  });

  test("symfony/demo's type-check names PHPStan's error, not \"[ERROR] Found 1 error\", and drops its emoji lines", () => {
    const withIdentifier = out("phpstan-unmatched-ignore").replace(/(was not matched in reported errors\.\s*\n)/, `$1         ${String.fromCodePoint(0x1faaa)}  ignore.unmatched\n`);
    for (const text of [out("phpstan-unmatched-ignore"), withIdentifier]) {
      const d = diagnose(text, false, "typecheck");
      assert.match(d.detail, /^PHPStan found 1 error in src\/Kernel\.php: Ignored error pattern #\^Method App\\\\Kernel\\:\\:getAllowedEnvs\\\(\\\) is unused\\\.\$# \(method\.unused\) in path \/work\/src\/Kernel\.php was not matched in reported errors\.$/);
    }
  });

  test("a stored output tail keeps the root error once Maven's stack trace fills the last 4 KB", () => {
    const text = out("maven-jpms-surefire-fork");
    assert.ok(text.length > 4000);
    const kept = outputTail(text);
    assert.equal(kept.split("\n")[0], rootError(text));
    assert.ok(kept.endsWith("mvn <args> -rf :test-jpms\n"));
    assert.equal(outputTail("short output"), "short output", "a short output is kept as it is");
  });

  test("Ruby's uncaught error, not the backtrace frame under it", () => {
    const trace = "/usr/local/lib/ruby/3.4.0/bundler/definition.rb:691:in 'Bundler::Definition#materialize': Could not find openssl-2.2.3 in locally installed gems (Bundler::GemNotFound)\n\tfrom /usr/local/lib/ruby/3.4.0/bundler/cli/exec.rb:23:in 'Bundler::CLI::Exec#run'\n\tfrom /usr/local/lib/ruby/3.4.0/bundler/friendly_errors.rb:117:in 'Bundler.with_friendly_errors'\n";
    assert.equal(diagnose(trace, false, "test").detail, "Could not find openssl-2.2.3 in locally installed gems (Bundler::GemNotFound)");
  });
});

describe("the network is named only when the output shows it", () => {
  test("google/gson's offline test run fails on \"module not found\", whatever Maven warned about fetching plugins", () => {
    const d = diagnose(out("maven-offline-jpms-module-not-found"), false, "test");
    assert.deepEqual(d, { cause: "compile", detail: "/work/test-jpms/src/test/java/module-info.java:[19,22] module not found: com.google.gson" });
  });

  test("a Maven error that reaches the registry is still the network", () => {
    const blocked = "[INFO] BUILD FAILURE\n[ERROR] Failed to execute goal on project app: Could not resolve dependencies for project ex:app:jar:1.0: Could not transfer artifact junit:junit:jar:4.13 from/to central (https://repo.maven.apache.org/maven2): Remote host terminated the handshake -> [Help 1]\n";
    assert.equal(diagnose(blocked, false, "install").cause, "network");
  });

  test("JamesNK/Newtonsoft.Json's Windows-path tests are named, with no network cause", () => {
    const d = diagnose(out("dotnet-windows-paths"), false, "test");
    assert.deepEqual(d, { cause: "unknown", detail: "Newtonsoft.Json.Tests.Issues.Issue1619.Test and 5 more failed" });
    const audit = makeAudit({ components: [{ id: "Src", share: 1, test: "fail", diagnosis: d, faults: "not_run" }] });
    const r = reportFor(audit);
    assert.equal(r.executive.headline, "Agents can't pass the tests in Src from a clean checkout: Newtonsoft.Json.Tests.Issues.Issue1619.Test and 5 more failed.");
    assert.deepEqual(validatePart1(r, loadRubric(audit.rubric)), []);
  });

  test("Surefire's failing tests are named from its summary", () => {
    const text = "[ERROR] Failures: \n[ERROR]   CartTest.total:12 expected: <3> but was: <2>\n[ERROR]   CartTest.empty:20 expected: <0> but was: <1>\n[INFO] \n[ERROR] Tests run: 4, Failures: 2, Errors: 0, Skipped: 0\n";
    assert.equal(diagnose(text, false, "test").detail, "CartTest.total and 1 more failed");
  });
});

// A component whose step failed for `d`, recorded as run would record it.
function withStep(audit: Audit, kind: "build" | "lint", condition: "clean.build" | "commands", d: Diagnosis, blocked?: string): Audit {
  const c = { id: `cmd-app-${kind}`, kind, component: "app", cwd: "app", command: "x", source: "readiness", reason: "x", timeoutSec: 600 } satisfies ContractCommand;
  audit.contract.push(c);
  audit.evidence.push({ ...audit.evidence[0], id: `ev-${kind}`, checkId: kind === "build" ? "bootstrap.cold_replay" : "verify.canonical_interface", condition, component: "app", kind, contractId: c.id, command: "x", result: "fail", summary: `${kind} failed: ${d.detail}`, diagnosis: d, ...(blocked ? { blocked } : {}) });
  return audit;
}

describe("headlines name the cause the output gave", () => {
  test("google/gson: the build's root error, not Maven's resume hint", () => {
    const d = diagnose(out("maven-jpms-surefire-fork"), false, "build");
    const audit = withStep(makeAudit({ components: [{ id: "app", share: 1, test: "fail", diagnosis: diagnose(out("maven-offline-jpms-module-not-found"), false, "test"), faults: "not_run" }] }), "build", "clean.build", d);
    const r = reportFor(audit);
    assert.equal(r.executive.headline, "app doesn't build from a clean checkout because surefire:test failed in module test-jpms: java.lang.NoClassDefFoundError: module-info is not a class because access_flag ACC_MODULE is set.");
    assert.deepEqual(validatePart1(r, loadRubric(audit.rubric)), []);
  });

  test("a tool's error that holds a term part 1 never uses stays out of the headline", () => {
    const d: Diagnosis = { cause: "unknown", detail: "compiler:compile failed in module bootstrap: Compilation failure", fromTool: true };
    const audit = withStep(makeAudit({ components: [{ id: "app", share: 1, faults: "not_run" }] }), "build", "clean.build", d);
    assert.equal(reportFor(audit).executive.headline, "app doesn't build from a clean checkout.");
  });

  test("Seldaek/monolog: ext-mongodb missing from the audit's composer image is blocked on this machine, not Level 0", () => {
    const d = diagnose(out("composer-ext-missing"), false, "install");
    assert.deepEqual(d, { cause: "missing_tool", detail: "PHP's mongodb extension (ext-mongodb) is not installed" });
    const blocked = environmentLimit(image("composer:2.11"), cmd("install"), d, []);
    assert.equal(blocked, "PHP's mongodb extension (ext-mongodb) is not installed in the audit's image (composer:2.11)");
    assert.equal(environmentLimit({ ...image("ex/php"), imageSource: "repo" }, cmd("install"), d, []), undefined, "the repo's own image lacking it is the repo's to fix");
    const audit = makeAudit({ install: "fail", components: [{ id: "app", share: 1, test: "not_run", faults: "not_run" }] });
    Object.assign(audit.evidence[0], { diagnosis: d, blocked, summary: `install failed: ${d.detail}` });
    for (const e of audit.evidence.filter((x) => x.condition === "clean.test")) Object.assign(e, { blocked: "the install was blocked on this machine", summary: `test ${INSTALL_BLOCKED}` });
    const r = reportFor(audit);
    assert.notEqual(r.maturity.outcome, "proven");
    assert.match(r.executive.headline, /couldn't be proved for app because PHP's mongodb extension \(ext-mongodb\) is not installed in the audit's image \(composer:2\.11\)/);
    assert.doesNotMatch(r.executive.headline, /doesn't install/);
  });

  test("sinatra/sinatra: PandocTest needs the pandoc program, which the audit's image lacks", () => {
    const d = diagnose(out("minitest-pandoc-missing"), false, "test");
    assert.deepEqual(d, { cause: "missing_tool", detail: "pandoc is not installed" });
    const blocked = environmentLimit(image("ruby:3.4-bookworm"), cmd("test"), d, []);
    assert.equal(blocked, "pandoc is not installed in the audit's image (ruby:3.4-bookworm)");
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "fail", diagnosis: d, faults: "not_run" }] });
    for (const e of audit.evidence.filter((x) => x.condition === "clean.test")) e.blocked = blocked;
    const r = reportFor(audit);
    assert.match(r.executive.headline, /couldn't be proved for app because pandoc is not installed in the audit's image/);
    assert.doesNotMatch(r.executive.headline, /network/);
    assert.equal(diagnose("Errno::ENOENT: No such file or directory - config\n    /work/lib/app.rb:3:in 'File.read'\n", false, "test").cause, "unknown", "a missing file isn't a missing program");
  });

  test("rack/rack: RuboCop isn't in the bundle, and Bundler is there", () => {
    const d = diagnose(out("bundler-gem-not-bundled"), false, "lint");
    assert.deepEqual(d, { cause: "missing_tool", detail: "rubocop is not installed by bundle install" });
    const blocked = environmentLimit(image("ruby:3.4-bookworm"), cmd("lint"), d, []);
    assert.equal(blocked, "rubocop is not installed by bundle install, so the audit couldn't run its lint command");
    const audit = withStep(makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] }), "lint", "commands", d, blocked);
    const r = reportFor(audit);
    assert.match(r.executive.headline, /because rubocop is not installed by bundle install/);
    assert.doesNotMatch(r.executive.headline, /bundler is not installed|has the tool, passed with --image/);
  });
});

// The Mac's rerun at dfe50b0, after PR 46 let each repo get one step further. Its reports keep the
// summaries only ("BUILD FAILED in 3s", "Error in bootstrap script: RuntimeException:", gson's
// network cause); the outputs are each tool's format around the errors that run reproduced.
describe("the rerun at dfe50b0", () => {
  test("google/gson: test-jpms not compiling wins over anything the Gson module's tests logged", () => {
    const d = diagnose(out("maven-offline-jpms-after-test-logs"), false, "test");
    assert.deepEqual(d, { cause: "compile", detail: "/work/test-jpms/src/test/java/module-info.java:[19,22] module not found: com.google.gson" });
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "fail", diagnosis: d, faults: "not_run" }] });
    const r = reportFor(audit);
    assert.equal(r.executive.headline, "Agents can't pass the tests in app from a clean checkout because /work/test-jpms/src/test/java/module-info.java:[19,22] module not found: com.google.gson.");
    assert.doesNotMatch(r.executive.headline, /network/);
  });

  test("square/moshi: the build's JDK 21 toolchain, which the audit's JDK 17 image lacks, not \"BUILD FAILED in 3s\"", () => {
    const d = diagnose(out("gradle-toolchain-jdk21"), false, "build");
    assert.deepEqual(d, { cause: "missing_tool", detail: "JDK 21 is not installed" });
    assert.equal(environmentLimit(image("eclipse-temurin:17-jdk"), cmd("build"), d, []), "JDK 21 is not installed in the audit's image (eclipse-temurin:17-jdk)");
    assert.equal(diagnose("> No matching toolchains found for requested specification: {languageVersion=21, vendor=any, implementation=vendor-specific} for LINUX on aarch64.\n", false, "build").detail, "JDK 21 is not installed", "older Gradle's wording");
  });

  test("guzzle/guzzle: its test server needs node, which composer:2.11 lacks; blocked, not the network", () => {
    const d = diagnose(out("phpunit-bootstrap-no-node"), false, "test");
    assert.deepEqual(d, { cause: "missing_tool", detail: "node is not installed" });
    const blocked = environmentLimit(image("composer:2.11"), cmd("test"), d, []);
    assert.equal(blocked, "node is not installed in the audit's image (composer:2.11)");
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "fail", diagnosis: d, faults: "not_run" }] });
    for (const e of audit.evidence.filter((x) => x.condition === "clean.test")) e.blocked = blocked;
    const r = reportFor(audit);
    assert.match(r.executive.headline, /couldn't be proved for app because node is not installed in the audit's image \(composer:2\.11\)/);
    assert.doesNotMatch(r.executive.headline, /network/);
  });
});

const tmp = () => mkdtempSync(join(tmpdir(), "readiness-causes-"));
function gitRepo(files: Record<string, string>): string {
  const dir = tmp();
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Contributor A", "-c", "user.email=a@example.com", "commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

describe("jwt/ruby-jwt@c22701e's two holds were false", () => {
  test("bin/smoke.rb's signing key names itself; a random one in a script still blocks", () => {
    const smoke = "require 'jwt'\n\nputs \"Running simple encode/decode test for #{JWT.gem_version}\"\nsecret = 'secretkeyforsigning'\ntoken  = JWT.encode({ con: 'tent' }, secret, 'HS256')\n";
    assert.deepEqual(scanText(smoke), []);
    assert.deepEqual(scanText("secret = 'q7Rk2vLx9TzW4mPa'\n").map((h) => h.line), [1]);
  });

  test("`bundle exec appraisal rake test` is skipped as package-adding, like `appraisal install`", () => {
    const contributing = "# Contributing\n\nTo run the complete set of tests and linter run the following\n\n```bash\nbundle install\nbundle exec appraisal rake test\nbundle exec rubocop\n```\n";
    const repo = gitRepo({ "Gemfile": "source 'https://rubygems.org'\n\ngemspec\n", "jwt.gemspec": "Gem::Specification.new do |s|\n  s.name = 'jwt'\n  s.add_development_dependency 'appraisal'\n  s.add_development_dependency 'rspec'\n  s.add_development_dependency 'rubocop'\nend\n", "Appraisals": "appraise 'openssl' do\n  gem 'openssl', '~> 2.1'\nend\n", "spec/jwt_spec.rb": "", "lib/jwt.rb": "", "CONTRIBUTING.md": contributing });
    const items = instructionItems(repo, buildProfile(repo, repo, loadRubric()));
    const by = new Map(items.map((i) => [i.text, i]));
    const appraisal = by.get("bundle exec appraisal rake test")!;
    assert.deepEqual([appraisal.category, appraisal.result, appraisal.rule], ["skipped", "not_run", "adds-packages"]);
    assert.match(appraisal.reason!, /appraisal install/);
    assert.equal(by.get("bundle exec rubocop")!.category, "replay", "the plain bundle commands are still replayed");
  });
});
