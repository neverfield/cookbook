import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { ContainerSession, IMAGE_PATH_VAR, detectRuntime, hostUser, loginShell, parseUserEntry, startArgs, userEntryCommand } from "../skill/agent-readiness/scripts/lib/container.ts";
import { chmodSync } from "node:fs";
import { commandTimeout, discoverContract, imagePlan } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { IMAGE_DIGESTS } from "../skill/agent-readiness/scripts/lib/images.ts";
import { inComponent, namedAfter, sameFolder, withInlineTests } from "../skill/agent-readiness/scripts/lib/languages/coverage.ts";
import { ECOSYSTEMS, LANGUAGES, ecosystemOf, languageOf, notCheckedFor } from "../skill/agent-readiness/scripts/lib/languages/index.ts";
import type { CheckName } from "../skill/agent-readiness/scripts/lib/languages/index.ts";
import type { ManifestScripts, ReplayHooks } from "../skill/agent-readiness/scripts/lib/languages/language.ts";
import { php } from "../skill/agent-readiness/scripts/lib/languages/php.ts";
import { ruby } from "../skill/agent-readiness/scripts/lib/languages/ruby.ts";
import { chooseSites, targetFiles, testFiles } from "../skill/agent-readiness/scripts/lib/mutate.ts";
import { buildProfile } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { RAN_OUT_BEFORE, banRepeats, budgetFloors, environmentLimit, instructionExecutor, newBudget, replay } from "../skill/agent-readiness/scripts/lib/replay.ts";
import type { Executor } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { IDLE_MARK, IDLE_OFFLINE, compilerError, diagnose, failingTests, missingRef } from "../skill/agent-readiness/scripts/lib/diagnose.ts";
import { extractFromMarkdown, instructionItems } from "../skill/agent-readiness/scripts/lib/static.ts";
import { staticSignals } from "../skill/agent-readiness/scripts/lib/signals.ts";
import { instructionKey, packageCommand, replayInstructions } from "../skill/agent-readiness/scripts/lib/instructions.ts";
import { existsExact } from "../skill/agent-readiness/scripts/lib/util.ts";
import { scanText } from "../skill/agent-readiness/scripts/lib/secrets.ts";
import { jvm } from "../skill/agent-readiness/scripts/lib/languages/jvm.ts";
import { loadRubric, latestRubricVersion } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { STACKS, supported } from "../skill/agent-readiness/scripts/lib/support.ts";
import type { Language, PackageManager } from "../skill/agent-readiness/scripts/lib/types.ts";
import { makeAudit } from "./helpers.ts";
import { SKILL } from "../support/tools/fixture.ts";

const rubric = loadRubric(latestRubricVersion());
const LANG_DIR = join(SKILL, "scripts", "lib", "languages");

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lang-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function gitRepo(files: Record<string, string>): { dir: string; commit: string } {
  const dir = repo(files);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Contributor A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "Contributor A", GIT_COMMITTER_EMAIL: "a@example.com" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: dir, env });
  return { dir, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim() };
}

describe("the language registry", () => {
  test("each language file is listed once, owns its codes and stacks alone, and is named after its id", () => {
    const ids = LANGUAGES.map((l) => l.id);
    assert.equal(new Set(ids).size, ids.length);
    const codes = LANGUAGES.flatMap((l) => l.codes);
    assert.equal(new Set(codes).size, codes.length, "a component language belongs to one file");
    const stacks = LANGUAGES.flatMap((l) => l.stacks.map((s) => s.id));
    assert.equal(new Set(stacks).size, stacks.length);
    const files = readdirSync(LANG_DIR).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, ""));
    for (const l of LANGUAGES) assert.ok(files.includes(l.id) || files.includes("others"), `${l.id} has its own file`);
  });

  test("every language the rubric can score has a language file", () => {
    for (const code of rubric.mutation.languages) assert.ok(languageOf(code as Language), `${code} has no language file`);
  });

  test("a language file imports only util.ts, its siblings and types, so the registry has no cycle", () => {
    for (const f of readdirSync(LANG_DIR).filter((x) => x.endsWith(".ts"))) {
      const text = readFileSync(join(LANG_DIR, f), "utf8");
      for (const m of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gm)) {
        const [, isType, from] = m;
        if (isType || from.startsWith("node:") || from.startsWith("./") || from === "../util.ts") continue;
        assert.fail(`${f} imports ${from} at runtime`);
      }
    }
  });

  test("a language with a supported stack has replay hooks, every image they name is pinned, and its proof is a fixture or a pinned repo", () => {
    for (const l of LANGUAGES) {
      const scored = l.stacks.some((s) => s.tier === "supported");
      if (!scored || l.builtIn) continue;
      assert.ok(l.replay, `${l.id} has a supported stack but no replay hooks`);
      for (const [tag, digest] of Object.entries(l.replay!.images)) {
        assert.match(digest, /^sha256:[0-9a-f]{64}$/, `${tag} is pinned to an index digest`);
        assert.equal(IMAGE_DIGESTS[tag], digest, `${tag} reaches the image table`);
      }
      assert.ok(l.ecosystems.length > 0, `${l.id} defines what a reproducible install is`);
    }
  });

  test("every ecosystem has a rule, a unique id, and a row in references/levels.md that says the same", () => {
    const ids = ECOSYSTEMS.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    const doc = readFileSync(join(SKILL, "references", "levels.md"), "utf8");
    const rows = new Map([...doc.matchAll(/^\| `([\w-]+)` \| ([^|]+) \| (.+) \|$/gm)].map((m) => [m[1], { language: m[2].trim(), rule: m[3].trim() }]));
    for (const l of LANGUAGES) {
      for (const e of l.ecosystems) {
        assert.ok(e.rule.trim(), `${e.id} has a rule`);
        assert.deepEqual(rows.get(e.id), { language: l.label, rule: e.rule }, `${e.id}'s row in levels.md`);
      }
    }
    assert.deepEqual([...rows.keys()].sort(), [...ids].sort(), "levels.md lists exactly the ecosystems");
  });

  test("the stacks support.ts lists are the language files' stacks plus the cross-language and machine entries", () => {
    for (const l of LANGUAGES) for (const s of l.stacks) assert.ok(STACKS.includes(s), `${s.id} reaches support.ts`);
  });

  // support/README.md "Adding a language" points here. Each rule is given, or null for "no rule".
  const RULES: Record<CheckName | "lockfiles.secretScanSkips", (v: unknown) => boolean> = {
    "weakening.isTest": (v) => typeof v === "function",
    "weakening.markers": (v) => v instanceof Object && (v as { skip: unknown }).skip instanceof RegExp && (v as { testCase: unknown }).testCase instanceof RegExp,
    "lockfiles.diff": (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
    "lockfiles.secretScanSkips": (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
    "lockfiles.foreign": (v) => v instanceof Object && Object.values(v).every((x) => typeof x === "string"),
    manifestScripts: (v) => v instanceof Object && typeof (v as ManifestScripts).manifest === "function" && typeof (v as ManifestScripts).read === "function" && (v as ManifestScripts).installHook instanceof RegExp,
    tool: (v) => v instanceof RegExp,
  };
  const at = (checks: unknown, path: string) => path.split(".").reduce<unknown>((o, k) => (o instanceof Object ? (o as Record<string, unknown>)[k] : undefined), checks);
  const leaves = (o: object, prefix = ""): string[] => Object.entries(o).flatMap(([k, v]) => (v instanceof Object && !(v instanceof RegExp) && !Array.isArray(v) && typeof v !== "function" && ["weakening", "lockfiles"].includes(k) ? leaves(v, `${k}.`) : [`${prefix}${k}`]));

  test("every language file declares each rule the language-neutral checks read, or null to say it has none", () => {
    for (const l of LANGUAGES) {
      assert.ok(l.checks, `${l.id} has no checks block`);
      for (const [path, valid] of Object.entries(RULES)) {
        const v = at(l.checks, path);
        assert.notEqual(v, undefined, `${l.id} leaves ${path} undeclared: give the rule, or null when the language has none`);
        if (v === null) assert.notEqual(path, "lockfiles.secretScanSkips", `${l.id}: secretScanSkips is a list, [] when it skips nothing`);
        else assert.ok(valid(v), `${l.id}: ${path} isn't a rule of the right shape`);
      }
      assert.deepEqual(leaves(l.checks).sort(), Object.keys(RULES).sort(), `${l.id} declares exactly the rules RULES lists`);
      if (l.replay) assert.equal(l.checks.weakening.isTest, l.replay.mutation.isTest, `${l.id}: readiness diff uses the same test-file rule faults are planted by`);
      if (l.stacks.some((s) => s.tier === "supported")) assert.ok(l.checks.tool, `${l.id} has a supported stack, so a replayed instruction needs its tool`);
      for (const f of l.detect.lockfiles ?? []) if (l.checks.lockfiles.diff) assert.ok(l.checks.lockfiles.diff.includes(f), `${l.id}: readiness diff lists changes to ${f}`);
    }
  });

  test("notCheckedFor names the languages with no rule, once each, and leaves out code no file scores", () => {
    assert.deepEqual(notCheckedFor("weakening.markers", ["go", "ts", "csharp", "js", "go", "other"]), ["Go", ".NET"]);
    assert.deepEqual(notCheckedFor("weakening.markers", ["py", "ts"]), []);
    assert.deepEqual(notCheckedFor("manifestScripts", ["py", "java", "kotlin"]), ["Python", "JVM"]);
  });

  test("the Language and PackageManager unions are exactly the registry's codes and ecosystem ids", () => {
    // A new union member fails to compile here until it is listed; a new code or ecosystem fails below.
    const codes: Record<Exclude<Language, "other">, true> = { ts: true, js: true, py: true, go: true, rust: true, java: true, kotlin: true, csharp: true, php: true, ruby: true };
    const pms: Record<PackageManager, true> = { npm: true, pnpm: true, yarn: true, bun: true, pip: true, uv: true, poetry: true, go: true, cargo: true, maven: true, gradle: true, nuget: true, composer: true, bundler: true };
    assert.deepEqual(LANGUAGES.flatMap((l) => l.codes).sort(), Object.keys(codes).sort());
    assert.deepEqual(ECOSYSTEMS.map((e) => e.id).sort(), Object.keys(pms).sort());
  });

  test("every lockfile a rubric counts is a name some language file declares", () => {
    const declared = new Set(LANGUAGES.flatMap((l) => [...(l.detect.lockfiles ?? []), ...l.ecosystems.flatMap((e) => e.lockfiles), ...(l.checks.lockfiles.diff ?? []), ...l.checks.lockfiles.secretScanSkips, ...Object.values(l.checks.lockfiles.foreign ?? {})]));
    for (const f of readdirSync(join(SKILL, "rubric")).filter((x) => x.endsWith(".json"))) {
      for (const name of loadRubric(f.replace(/\.json$/, "")).components.lockfiles) assert.ok(declared.has(name), `rubric ${f} counts ${name}, which no language file declares`);
    }
  });
});

describe("Level 1 per ecosystem: what counts as a reproducible install", () => {
  const install = (pm: Parameters<typeof ecosystemOf>[0], files: Record<string, string>, path = ".") => {
    const dir = repo(files);
    const e = ecosystemOf(pm)!;
    return { ...e.install(dir, path, { ignoreScripts: false }), unpinned: e.unpinned(dir, path) };
  };

  test("Go modules: go.sum pins what go.mod requires, a module with no requirements needs none, vendor/ counts", () => {
    const req = "module example.com/api\n\ngo 1.23\n\nrequire github.com/google/uuid v1.6.0\n";
    assert.deepEqual(install("go", { "go.mod": req, "go.sum": "x" }), { command: "GOFLAGS=-mod=readonly go mod download", reason: "download of the modules go.sum pins, without changing go.mod", frozen: true, unpinned: null });
    const loose = install("go", { "go.mod": req });
    assert.equal(loose.frozen, false);
    assert.equal(loose.unpinned, "go.mod requires modules but no go.sum is committed");
    assert.equal(install("go", { "go.mod": "module example.com/api\n\ngo 1.23\n" }).unpinned, null);
    assert.equal(install("go", { "go.mod": req, "vendor/modules.txt": "# github.com/google/uuid v1.6.0\n" }).frozen, true);
  });

  test("Cargo: a committed Cargo.lock, fetched with --locked", () => {
    assert.equal(install("cargo", { "Cargo.toml": "[package]\nname='x'\n", "Cargo.lock": "" }).command, "cargo fetch --locked");
    assert.equal(install("cargo", { "Cargo.toml": "[package]\nname='x'\n" }).unpinned, "no Cargo.lock is committed");
  });

  test("Maven: no version ranges, LATEST or RELEASE in any pom.xml, through the wrapper when there is one", () => {
    const pom = (v: string) => `<project><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>${v}</version></dependency></dependencies></project>`;
    const fixed = install("maven", { "pom.xml": pom("1.2.3"), mvnw: "#!/bin/sh\n" });
    assert.deepEqual([fixed.command, fixed.frozen, fixed.unpinned], ['JAVA_TOOL_OPTIONS="-Duser.home=$HOME" ./mvnw -B -ntp dependency:go-offline', true, null]);
    assert.equal(install("maven", { "pom.xml": pom("1.2.3"), "core/pom.xml": pom("[1.0,2.0)") }).unpinned, "pom.xml leaves 1 version open (a range, LATEST or RELEASE)");
    assert.equal(install("maven", { "pom.xml": pom("LATEST") }).frozen, false);
  });

  test("Gradle: a committed gradle.lockfile, or no dynamic versions", () => {
    const dyn = 'dependencies { implementation "com.google.guava:guava:33.+" }\n';
    assert.equal(install("gradle", { "build.gradle": dyn, gradlew: "" }).unpinned, "the Gradle build uses 1 dynamic version and commits no gradle.lockfile");
    assert.equal(install("gradle", { "build.gradle": dyn, "gradle.lockfile": "" }).unpinned, null);
    assert.equal(install("gradle", { "build.gradle.kts": 'dependencies { implementation("com.google.guava:guava:33.2.1-jre") }\n' }).frozen, true);
  });

  test("NuGet: a packages.lock.json next to every project that references packages, restored in locked mode", () => {
    const proj = '<Project><ItemGroup><PackageReference Include="Serilog" Version="4.0.0" /></ItemGroup></Project>';
    assert.equal(install("nuget", { "src/Api/Api.csproj": proj, "src/Api/packages.lock.json": "{}" }).command, "dotnet restore --locked-mode");
    assert.equal(install("nuget", { "src/Api/Api.csproj": proj, "src/Api/packages.lock.json": "{}", "tests/Api.Tests/Api.Tests.csproj": proj }).unpinned, "1 of 2 projects that reference packages have no packages.lock.json");
    assert.equal(install("nuget", { "Tool.csproj": "<Project></Project>" }).unpinned, null, "a project with no packages has nothing to lock");
  });

  test("Composer: a committed composer.lock, unless only PHP and its extensions are required", () => {
    assert.equal(install("composer", { "composer.json": '{"require":{"monolog/monolog":"^3"}}' }).unpinned, "no composer.lock is committed");
    assert.equal(install("composer", { "composer.json": '{"require":{"php":">=8.2","ext-json":"*"}}' }).unpinned, null);
    assert.equal(install("composer", { "composer.json": "{}", "composer.lock": "{}" }).frozen, true);
  });

  test("Bundler: a committed Gemfile.lock, installed frozen", () => {
    assert.equal(install("bundler", { Gemfile: "source 'https://rubygems.org'\n", "Gemfile.lock": "" }).command, "BUNDLE_FROZEN=true bundle install");
    assert.equal(install("bundler", { Gemfile: "source 'https://rubygems.org'\n" }).unpinned, "no Gemfile.lock is committed");
  });

  test("npm and pip keep the rules they had: a lockfile for npm, exact pins for pip", () => {
    assert.equal(install("npm", { "package.json": "{}" }).unpinned, "no lockfile is committed");
    assert.equal(install("pip", { "requirements.txt": "requests>=2\nflask==3.0.0\n" }).unpinned, "requirements.txt doesn't pin exact versions for 1 of 2 packages");
  });
});

describe("one image per component", () => {
  const node = { "package.json": '{"name":"web","scripts":{"test":"node --test"}}', "package-lock.json": "{}", "src/a.js": "export const a = 1;\n" };
  const uvService = { "services/pricing/pyproject.toml": '[project]\nname = "pricing"\nrequires-python = ">=3.13"\n', "services/pricing/uv.lock": "version = 1\n", "services/pricing/tests/test_x.py": "" };

  test("a Python project with its own lockfile next to Node packages runs in Python's image, with uv for a uv project", () => {
    const dir = repo({ ...node, ...uvService });
    const profile = buildProfile(dir, dir, rubric);
    assert.deepEqual(imagePlan(profile, dir), [
      { image: "node:22-bookworm", components: ["web"] },
      { image: "ghcr.io/astral-sh/uv:python3.13-trixie-slim", components: ["pricing"] },
    ]);
    const doctors = discoverContract(profile, dir, rubric, []).filter((c) => c.kind === "doctor").map((c) => [c.id, c.command]);
    assert.deepEqual(doctors, [["cmd-repo-doctor", "node --version && npm --version"], ["cmd-pricing-doctor", "python3 --version && uv --version"]]);
  });

  test("a repo that declares its environment, or a run given --image, runs everything in one image", () => {
    const dir = repo({ ...node, ...uvService, ".cursor/environment.json": '{"install":"npm ci"}' });
    const profile = buildProfile(dir, dir, rubric);
    assert.equal(imagePlan(profile, dir).length, 1);
    const plain = repo({ ...node, ...uvService });
    assert.deepEqual(imagePlan(buildProfile(plain, plain, rubric), plain, "node:24-bookworm"), [{ image: "node:24-bookworm", components: ["web", "pricing"] }]);
  });

  test("a Node project with its own lockfile next to a Python root runs in Node's image", () => {
    const dir = repo({ "pyproject.toml": '[project]\nname = "api"\n', "uv.lock": "version = 1\n", "api/x.py": "", "frontend/package.json": '{"name":"frontend","scripts":{"test":"vitest"}}', "frontend/package-lock.json": "{}", "frontend/src/a.ts": "export const a = 1;\n" });
    const plan = imagePlan(buildProfile(dir, dir, rubric), dir);
    assert.deepEqual(plan.map((g) => g.image), ["ghcr.io/astral-sh/uv:python3.12-trixie-slim", "node:22-bookworm"]);
  });
});

describe("coverage helpers for languages whose tests don't import files by path", () => {
  const src = (f: string) => /\.(go|java|rb|rs)$/.test(f) && !/(_test\.go|Test\.java|_spec\.rb)$/.test(f);

  test("sameFolder: a Go test covers its package's files", () => {
    assert.deepEqual(sameFolder(["svc/stock_test.go"], ["svc/stock.go", "svc/stock_test.go", "svc/db/db.go", "main.go"], src), ["svc/stock.go"]);
  });

  test("namedAfter: OrderTest covers Order, cart_spec covers cart, wherever they are", () => {
    const java = ["src/main/java/shop/Order.java", "src/main/java/shop/Cart.java", "src/test/java/shop/OrderTest.java"];
    assert.deepEqual(namedAfter(["src/test/java/shop/OrderTest.java"], java, src), ["src/main/java/shop/Order.java"]);
    const rb = ["lib/cart.rb", "lib/order.rb", "spec/cart_spec.rb"];
    assert.deepEqual(namedAfter(["spec/cart_spec.rb"], rb, src), ["lib/cart.rb"]);
  });

  test("withInlineTests: a Rust file with its own test module covers itself", () => {
    const dir = repo({ "src/lib.rs": "pub fn f() {}\n#[cfg(test)]\nmod tests {}\n", "src/other.rs": "pub fn g() {}\n" });
    assert.deepEqual(withInlineTests(dir, ["src/lib.rs", "src/other.rs"], src, /#\[cfg\(test\)\]/), ["src/lib.rs"]);
    assert.deepEqual(inComponent(["a/x.rs", "b/y.rs"], "a"), ["a/x.rs"]);
  });
});

// Toy hooks on the Ruby file, which isn't scored yet: a Gemfile project whose "tests" run Python's
// unittest in the pinned Python image. They drive every hook a language group fills in, so the
// plumbing is proved before any group lands a real language.
const TOY_IMAGE = "python:3.12-slim";
const toy: ReplayHooks = {
  classify: () => ({ language: "ruby", packageManager: null }),
  image: () => TOY_IMAGE,
  images: {},
  doctor: "python3 --version",
  pins: () => ({ found: ["Gemfile"], missing: [] }),
  commands: () => [{ kind: "test", command: "python3 -m unittest discover -s tests -t .", source: "readiness", reason: "the toy language's test runner" }],
  testCounts: (output) => {
    const ran = output.match(/^Ran (\d+) tests?/m);
    if (!ran) return null;
    const failed = Number(output.match(/FAILED \((?:failures|errors)=(\d+)/)?.[1] ?? 0);
    return { passed: Number(ran[1]) - failed, failed, total: Number(ran[1]) };
  },
  budget: { commandTimeoutSec: 900, componentMinutes: 20, mutationRunTimeoutSec: 400 },
  mutation: {
    isTest: (f) => /(^|\/)tests\/test_[^/]+\.py$/.test(f),
    isSource: (f) => f.endsWith(".py") && !f.includes("tests/"),
    covered: (_tree, _comp, tests, files) => namedAfter(tests, files, (f) => f.endsWith(".py") && !f.includes("tests/")),
    compileProbe: (comp) => ({ command: "python3 -m py_compile calc.py", cwd: comp.path }),
    compileError: (output) => /SyntaxError/.test(output),
  },
};

const TOY_REPO = {
  Gemfile: "source 'https://rubygems.org'\n",
  ".python-version": "3.12\n",
  "calc.py": [
    "def tier(points):",
    "    if points >= 100:",
    "        return 2",
    "    return 1",
    "",
    "",
    "def shipping(weight):",
    "    if weight > 20:",
    "        return 30",
    "    return weight + 1",
    "",
  ].join("\n"),
  "tests/__init__.py": "",
  "tests/test_calc.py": [
    "import unittest",
    "from calc import shipping, tier",
    "",
    "",
    "class CalcTest(unittest.TestCase):",
    "    def test_tier(self):",
    "        self.assertEqual(tier(99), 1)",
    "        self.assertEqual(tier(100), 2)",
    "",
    "    def test_shipping(self):",
    "        self.assertEqual(shipping(20), 21)",
    "        self.assertEqual(shipping(21), 30)",
    "        self.assertEqual(shipping(2), 3)",
    "",
  ].join("\n"),
};

function withToy<T>(fn: () => T): T {
  const saved = { replay: ruby.replay, tier: ruby.stacks[0].tier };
  ruby.replay = toy;
  ruby.stacks[0].tier = "supported";
  const restore = () => {
    ruby.replay = saved.replay;
    ruby.stacks[0].tier = saved.tier;
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore) as T;
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}

describe("a language file's replay hooks", () => {
  test("decide detection, the contract, timeouts, the image, budgets and where faults go", () =>
    withToy(() => {
      const dir = repo(TOY_REPO);
      const profile = buildProfile(dir, dir, rubric);
      const comp = profile.components.find((c) => c.assessed)!;
      assert.equal(supported("ruby"), true);
      assert.deepEqual([comp.language, comp.stack, comp.notAssessedReason], ["ruby", "ruby", undefined]);
      const contract = discoverContract(profile, dir, rubric, []);
      assert.deepEqual(contract.map((c) => [c.id, c.command, c.timeoutSec]), [
        [`cmd-${comp.id}-doctor`, "python3 --version", 60],
        [`cmd-${comp.id}-install`, "true", 900],
        [`cmd-${comp.id}-test`, "python3 -m unittest discover -s tests -t .", 900],
      ]);
      assert.equal(commandTimeout(rubric, comp), 900);
      assert.deepEqual(imagePlan(profile, dir).slice(1), [{ image: TOY_IMAGE, components: [comp.id] }]);
      assert.deepEqual(budgetFloors(profile), { [comp.id]: 20 });
      assert.deepEqual(testFiles(dir, comp), ["tests/test_calc.py"]);
      assert.deepEqual(targetFiles(dir, comp), ["calc.py"]);
      assert.ok(profile.toolchain.files.includes("Gemfile"), "the language file's pins count");
    }));

  test("run the component in its own image and plant faults there", { skip: detectRuntime("auto") ? false : "no container runtime: this replay needs docker or podman", timeout: 10 * 60 * 1000 }, () =>
    withToy(async () => {
      const { dir, commit } = gitRepo(TOY_REPO);
      const profile = buildProfile(dir, dir, rubric);
      const comp = profile.components.find((c) => c.assessed)!;
      assert.ok(chooseSites(dir, dir, comp, "", 5, commit).length >= 3, "the C-like default operators find sites in the covered file");
      const audit = makeAudit({ components: [] });
      Object.assign(audit, { id: `aud-lang-${Date.now()}`, repo: { name: "toy", commit, dirtyTree: false }, profile, contract: discoverContract(profile, dir, rubric, []), evidence: [], environment: { containerRuntime: null, image: null, registryEnv: [], inheritEnv: false } });
      const tree = join(mkdtempSync(join(tmpdir(), "lang-tree-")), "tree");
      const log: string[] = [];
      await replay(audit, dir, tree, rubric, { mutants: true, instructions: false, runtime: "auto", budgetComponentMinutes: 15, budgetTotalMinutes: 60, log: (l) => log.push(l) });
      const byKind = (k: string) => audit.evidence.find((e) => e.kind === k || e.condition === k)!;
      assert.equal(audit.environment.image, TOY_IMAGE, log.join("\n"));
      assert.equal(audit.environment.images, undefined, "nothing repo-wide ran, so only the component's image started");
      assert.deepEqual([byKind("test").result, byKind("test").image, byKind("test").summary], ["pass", TOY_IMAGE, "test passed (2 of 2 tests)"], log.join("\n"));
      const faults = byKind("faults");
      assert.equal(faults.image, TOY_IMAGE);
      assert.equal(faults.result, "pass", faults.summary);
      assert.match(faults.summary, /^caught \d of \d planted faults/);
      assert.equal(byKind("lockfile").result, "fail", "no ecosystem, so no frozen install: the lockfile condition says so");
    }));
});

// Go lives in /usr/local/go/bin, which only the image's ENV PATH names. Debian's /etc/profile resets
// PATH for a login shell, so a plain `bash -lc` reported go as not installed in the golang image.
const GO_IMAGE = "golang:1.23-bookworm@sha256:167053a2bb901972bf2c1611f8f52c44d5fe7e762e5cab213708d82c421614db";

describe("commands see the image's PATH", () => {
  test("the login shell puts the image's PATH back in front and keeps pipefail", () => {
    const [bash, flag, script] = loginShell("go version | head -1", true);
    assert.deepEqual([bash, flag], ["bash", "-c"]);
    assert.ok(script.startsWith(`${IMAGE_PATH_VAR}="$PATH" exec bash -o pipefail -lc `), script);
    assert.ok(script.includes(`export PATH="$${IMAGE_PATH_VAR}:$PATH"`), script);
    assert.ok(!loginShell("true", false)[2].includes("pipefail"));
  });

  test("a tool outside /usr/local/bin is found, both by the repo's commands and the audit's setup", { skip: detectRuntime("auto") ? false : "no container runtime: this needs docker or podman", timeout: 5 * 60 * 1000 }, async () => {
    const runtime = detectRuntime("auto")!;
    const session = new ContainerSession(runtime, `readiness-path-${Date.now()}`, GO_IMAGE, mkdtempSync(join(tmpdir(), "lang-path-")), [], hostUser());
    const started = session.start();
    assert.ok(started.ok, started.output);
    try {
      const out = await session.exec("command -v go && go version", ".", 120);
      assert.equal(out.exitCode, 0, out.output);
      assert.match(out.output, /^\/usr\/local\/go\/bin\/go$/m);
      assert.match(out.output, /go version go1\.23/);
      const setup = session.asImageUser("command -v go", 60000);
      assert.ok(setup.ok, setup.output);
      const failing = await session.exec("false | true", ".", 60);
      assert.notEqual(failing.exitCode, 0, "pipefail still applies to the repo's commands");
      const leaked = await session.exec(`test -z "\${${IMAGE_PATH_VAR}:-}"`, ".", 60);
      assert.equal(leaked.exitCode, 0, "the saved PATH doesn't reach the command's environment");
    } finally {
      session.remove();
    }
  });
});

// Output captured from each tool's real install (Nov 15, 2026) with the registry blocked by egress
// (the cloud VM resets TLS to hosts it doesn't allow) and with the network off. Go and Cargo reach
// their registries from the VM, so their egress-blocked runs used a blocked mirror (goproxy.io,
// rsproxy.cn): same tool, same failure, another host.
const OUTPUTS = join(dirname(new URL(import.meta.url).pathname), "registry-outputs");
const output = (name: string) => readFileSync(join(OUTPUTS, `${name}.txt`), "utf8");
const install = { id: "cmd-app-install", kind: "install" as const, component: "app", cwd: ".", command: "install", source: "readiness", reason: "x", timeoutSec: 600 };
const inContainer = { where: "container" as const, image: "x", imageSource: "audit" as const };

describe("a blocked registry is this machine's limit, in every ecosystem", () => {
  const blocked = readdirSync(OUTPUTS).filter((f) => /-(egress-blocked|offline)\.txt$/.test(f)).map((f) => f.replace(/\.txt$/, ""));

  test("there is a capture of both kinds for each ecosystem", () => {
    for (const eco of ["go", "cargo", "maven", "gradle", "nuget", "composer", "bundler"]) {
      assert.ok(blocked.includes(`${eco}-egress-blocked`) && blocked.includes(`${eco}-offline`), eco);
    }
  });

  for (const name of blocked) {
    test(`${name}: the install is blocked, not a repo failure`, () => {
      const d = diagnose(output(name), false, "install");
      assert.equal(d.cause, "network", d.detail);
      assert.ok(environmentLimit(inContainer, install, d, []), "reported as blocked");
    });
  }

  test("a wrong dependency version stays the repo's failure", () => {
    const wrong = [
      // google/gson@6c06cbc with a plugin version that doesn't exist, through a reachable Maven Central mirror.
      readFileSync(join(dirname(OUTPUTS), "tool-outputs", "maven-wrong-version.txt"), "utf8"),
      output("cargo-wrong-version"),
      output("go-wrong-version"),
      "[ERROR] Failed to execute goal on project app: Could not resolve dependencies for project ex:app:jar:1.0: Could not find artifact junit:junit:jar:99.0 in central (https://repo.maven.apache.org/maven2)",
      "   > Could not resolve com.google.guava:guava:99.0.\n      > Could not find com.google.guava:guava:99.0.",
      "/w/App.csproj : error NU1102: Unable to find package Serilog with version (>= 99.0.0)",
      "Could not find gem 'rake (= 99.0)' in rubygems repository https://rubygems.org/ or installed locally.",
      "  Problem 1\n    - Root composer.json requires monolog/monolog ^99.0, found monolog/monolog[1.0.0, ..., 3.8.1] but it does not match the constraint.",
      // Gradle says this for a blocked plugin portal and for a plugin version that doesn't exist alike,
      // so on its own it can't be called blocked; the "Could not GET" line under it can.
      "Plugin [id: 'com.github.ben-manes.versions', version: '9.9.9'] was not found in any of the following sources:\n- Plugin Repositories (could not resolve plugin artifact 'com.github.ben-manes.versions:com.github.ben-manes.versions.gradle.plugin:9.9.9')",
    ];
    for (const text of wrong) {
      const d = diagnose(text, false, "install");
      assert.notEqual(d.cause, "network", text);
      assert.equal(environmentLimit(inContainer, install, d, []), undefined, text);
    }
  });
});

describe("Symfony parameter references aren't secrets", () => {
  test("%env(...)% and %name% name where a value comes from; a committed literal is still flagged", () => {
    assert.deepEqual(scanText("framework:\n    secret: '%env(APP_SECRET)%'\n"), []);
    assert.deepEqual(scanText("parameters:\n    secret: '%kernel.secret%'\n"), []);
    assert.deepEqual(scanText("APP_SECRET=3f9a1c07be52d84e6a1f0c93d2b7e815\n").map((h) => h.line), [1]);
  });

  test("symfony/demo@f42980c's .env.local.demo value says it isn't a secret, and isn't flagged", () => {
    const demo = "# This variable is for the demo app only!\n# See https://symfony.com/doc/current/reference/configuration/framework.html#configuration-framework-secret\nAPP_SECRET=not-a-secret--read-the-doc!\n";
    assert.deepEqual(scanText(demo), []);
  });
});

describe("a root build a language file refines keeps its source folders", () => {
  test("an Android Gradle root doesn't split app/ off as a JVM folder with no manifest", () => {
    const android = { id: "android", label: "Android", kind: "stack" as const, tier: "not_assessed" as const, proof: [] };
    jvm.stacks.push(android);
    STACKS.push(android);
    jvm.detect.refine = (_manifest, text) => (/com\.android\.(application|library)/.test(text) ? "android" : undefined);
    try {
      const dir = repo({ "build.gradle": "plugins { id 'com.android.application' version '8.5.0' apply false }\n", "settings.gradle": "include ':app'\n", "app/build.gradle": "plugins { id 'com.android.application' }\n", "app/src/main/java/shop/Cart.java": "class Cart {}\n" });
      const comps = buildProfile(dir, dir, rubric).components;
      assert.deepEqual(comps.map((c) => [c.path, c.stack]), [[".", "android"]]);
    } finally {
      delete jvm.detect.refine;
      jvm.stacks.splice(jvm.stacks.indexOf(android), 1);
      STACKS.splice(STACKS.indexOf(android), 1);
    }
  });
});

// GitHub runs as uid 1001 and a Mac as 501, which images have no /etc/passwd line for. The .NET SDK
// then fails every restore, new and build on its NuGet migrations; with a line it works under the
// audit's dropped capabilities. Digests: sdk:8.0 from dotnet/versions image-info (Nov 10, 2026);
// mcr.microsoft.com is blocked on cloud VMs, so that test passes on GitHub and the Mac only.
const SDK_IMAGE = "mcr.microsoft.com/dotnet/sdk:8.0@sha256:1b955f179b02df4f0eb5fadedaa898cbe44d620a64aab52eec72c8e91d1355b5";
const NODE_IMAGE = "node:22-bookworm@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb";
// Runs as uid 101 by default, with /etc/passwd owned by root and not writable by it.
const NON_ROOT_IMAGE = "nginxinc/nginx-unprivileged:1.27-bookworm@sha256:f9dfa9c20b2b0b7c5cc830374f22f23dee3f750b6c5291ca7e0330b5c88e6403";
const NO_ENTRY_UID = "4242:4242";

function session(image: string, user: string): ContainerSession {
  const dir = mkdtempSync(join(tmpdir(), "lang-user-"));
  chmodSync(dir, 0o777);
  return new ContainerSession(detectRuntime("auto")!, `readiness-user-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, image, dir, [], user);
}

describe("the ordinary user gets an /etc/passwd entry", () => {
  test("the entry is added only when the uid and gid have none, and the outcome is read back", () => {
    const cmd = userEntryCommand("1001:121");
    assert.match(cmd, /getent passwd 1001/);
    assert.match(cmd, /readiness:x:1001:121:readiness:\/tmp\/home:\/bin\/sh' >> \/etc\/passwd/);
    assert.match(cmd, /getent group 121/);
    assert.equal(parseUserEntry(true, "added\n"), "added");
    assert.equal(parseUserEntry(true, "present\n"), "present");
    assert.equal(parseUserEntry(true, "missing\n"), "missing");
    assert.equal(parseUserEntry(true, "present\ngroup-missing\n"), "missing");
    assert.equal(parseUserEntry(false, ""), "missing");
  });

  const docker = { skip: detectRuntime("auto") ? false : "no container runtime: this needs docker or podman", timeout: 10 * 60 * 1000 };

  test("a uid the image doesn't know gets a name, a group and the shared home", docker, async () => {
    const s = session(NODE_IMAGE, NO_ENTRY_UID);
    const started = s.start();
    assert.ok(started.ok, started.output);
    try {
      assert.equal(s.userEntry, "added");
      const out = await s.exec("whoami && id -gn && getent passwd 4242 | cut -d: -f6", ".", 60);
      assert.equal(out.exitCode, 0, out.output);
      assert.deepEqual(out.output.trim().split("\n"), ["readiness", "readiness", "/tmp/home"]);
      const again = s.asImageUser(userEntryCommand(NO_ENTRY_UID));
      assert.equal(parseUserEntry(again.ok, again.output), "present", "a second start adds nothing");
    } finally {
      s.remove();
    }
  });

  test("an image whose user can't write /etc/passwd still starts, and says the entry is missing", docker, async () => {
    const s = session(NON_ROOT_IMAGE, NO_ENTRY_UID);
    const started = s.start();
    assert.ok(started.ok, started.output);
    try {
      assert.equal(s.userEntry, "missing");
      assert.equal((await s.exec("true", ".", 60)).exitCode, 0);
    } finally {
      s.remove();
    }
  });

  test("the .NET SDK builds under a uid with no entry of its own", docker, async () => {
    const s = session(SDK_IMAGE, NO_ENTRY_UID);
    const started = s.start();
    assert.ok(started.ok, started.output);
    try {
      assert.equal(s.userEntry, "added");
      const out = await s.exec("dotnet --info >/dev/null && dotnet new console -o app >/dev/null && cd app && dotnet build -p:NuGetAudit=false", ".", 400);
      assert.equal(out.exitCode, 0, out.output.slice(-3000));
      assert.doesNotMatch(out.output, /NuGet-Migrations/);
    } finally {
      s.remove();
    }
  });
});

describe("a supported language an older rubric doesn't list", () => {
  test("is left out with a reason that names it and the rubric, for PHP and Ruby alike", () => {
    const old = loadRubric("2026-10-alpha");
    assert.ok(!old.mutation.languages.includes("php") && !old.mutation.languages.includes("ruby"));
    const saved = { replay: php.replay, tier: php.stacks[0].tier };
    php.replay = { ...toy, classify: () => ({ language: "php", packageManager: "composer" }) };
    php.stacks[0].tier = "supported";
    try {
      withToy(() => {
        const dir = repo({ "app/composer.json": '{"name":"acme/app"}', "app/src/Cart.php": "<?php\n", "worker/Gemfile": "source 'https://rubygems.org'\n", "worker/lib/job.py": "" });
        const byId = Object.fromEntries(buildProfile(dir, dir, old).components.map((c) => [c.id, c]));
        assert.deepEqual([byId.app.assessed, byId.app.notAssessedReason], [false, "PHP isn't scored under rubric 2026-10-alpha"]);
        assert.deepEqual([byId.worker.assessed, byId.worker.notAssessedReason], [false, "Ruby isn't scored under rubric 2026-10-alpha"]);
        const current = Object.fromEntries(buildProfile(dir, dir, rubric).components.map((c) => [c.id, c]));
        assert.deepEqual([current.app.assessed, current.worker.assessed], [true, true], "the newest rubric scores both");
      });
    } finally {
      php.replay = saved.replay;
      php.stacks[0].tier = saved.tier;
    }
  });
});

// pocketbase/pocketbase@7f2773e CONTRIBUTING.md, lines 28-90: "Navigate to `examples/base`" is a step
// for running the example, and the test and lint blocks say they run from the root; the UI section's
// "Navigate to the `ui` project directory" holds to the end of that section, `npm run build` included.
const POCKETBASE_CONTRIBUTING = "\n## Making changes in the Go code\n\nPocketBase is distributed as a Go package, which means that in order to run the project you'll have to create a Go `main` program that imports the package.\n\nThe repository already includes such program, located in `examples/base`, that is also used for the prebuilt executables.\n\nSo, let's assume that you already done some changes in the PocketBase Go code and you want now to run them:\n\n1. Navigate to `examples/base`\n2. Run `go run main.go serve`\n\nThis will start a web server on `http://localhost:8090` with the embedded prebuilt Superuser UI from `ui/dist`. And that's it!\n\n**Before making a PR to the main repository, it is a good idea to:**\n\n- Add unit/integration tests for your changes (we are using the standard `testing` go package).\n  To run the tests, you could execute (while in the root project directory):\n\n  ```sh\n  go test ./...\n\n  # or using the Makefile\n  make test\n  ```\n\n- Run the linter - **golangci** ([see how to install](https://golangci-lint.run/usage/install/#local-installation)):\n\n  ```sh\n  golangci-lint run -c ./golangci.yml ./...\n\n  # or using the Makefile\n  make lint\n  ```\n\n## Making changes in the Superuser UI\n\nPocketBase Superuser UI is a single-page application (SPA) built with Svelte and Vite.\n\nTo start the Superuser UI:\n\n1. Navigate to the `ui` project directory\n2. Run `npm install` to install the node dependencies\n3. Start vite's dev server\n   ```sh\n   npm run dev\n   ```\n\nYou could open the browser and access the running Superuser UI at `http://localhost:5173`.\n\nSince the Superuser UI is just a client-side application, you need to have the PocketBase backend server also running in the background (either manually running the `examples/base/main.go` or download a prebuilt executable).\n\n> [!NOTE]\n> By default, the Superuser UI is expecting the backend server to be started at `http://localhost:8090`, but you could change that by creating a new `ui/.env.development.local` file with `PB_BACKEND_URL = YOUR_ADDRESS` variable inside it.\n\nEvery change you make in the Superuser UI should be automatically reflected in the browser at `http://localhost:5173` without reloading the page.\n\nOnce you are done with your changes, you have to build the Superuser UI with `npm run build`, so that it can be embedded in the go package. And that's it - you can make your PR to the main PocketBase repository.\n";

describe("a step's working folder stays in its block", () => {
  test("Navigate to `examples/base` doesn't carry into the later test and lint blocks", () => {
    const folders = new Set(["examples/base", "ui"]);
    const found = extractFromMarkdown(POCKETBASE_CONTRIBUTING, { exists: (p) => folders.has(p) }).filter((e) => e.kind === "command");
    const within = Object.fromEntries(found.map((e) => [e.text, e.within ?? "."]));
    assert.equal(within["go run main.go serve"], "examples/base");
    assert.equal(within["go test ./..."], ".");
    assert.equal(within["make test"], ".");
    assert.equal(within["make lint"], ".");
    assert.equal(within["npm install"], "ui", "the UI section's own step holds for its list");
    assert.equal(within["npm run dev"], "ui");
    assert.equal(within["npm run build"], "ui", "and for the later paragraphs of its section (CONTRIBUTING.md:85)");
  });

  test("a step's folder holds through subsections, and ends at the next section or a line back to the root", () => {
    const md = "## Web\n\nNavigate to the `web` folder:\n\n```sh\nnpm test\n```\n\n### Checks\n\nRun `npm run lint` too.\n\n## Docs\n\n```sh\nnpm run docs\n```\n\n## API\n\nNavigate to `web`.\n\nThen, from the repository root:\n\n```sh\nnpm run api\n```\n";
    const found = extractFromMarkdown(md, { exists: (p) => p === "web" });
    assert.deepEqual(found.filter((e) => e.kind === "command").map((e) => [e.text, e.within ?? "."]), [["npm test", "web"], ["npm run lint", "web"], ["npm run docs", "."], ["npm run api", "."]]);
  });
});

describe("a replayed instruction runs in the image of the component it targets", () => {
  const ex = (name: string) => ({ image: name }) as unknown as Executor;
  const exs = { forComponent: (id: string) => ex(`image of ${id}`), repo: ex("the repo's image") };
  const comp = (id: string, path: string, language: Language, assessed = true) => ({ id, path, language, assessed, manifest: null, scripts: {}, changes: 1, changeShare: 0.5 });
  const tree = repo({ Makefile: "test:\n\tgo test ./...\n\nlint:\n\tgolangci-lint run ./...\n\nui:\n\tnpm --prefix ui run build\n" });
  const pick = (components: ReturnType<typeof comp>[], cwd: string, command: string) => (instructionExecutor(exs, { components } as unknown as Parameters<typeof instructionExecutor>[1], tree, cwd, command) as unknown as { image: string }).image;
  const both = [comp("pocketbase", ".", "go"), comp("ui", "ui", "js")];

  test("by the tool it runs, the Make target's recipe, and the folder it runs in", () => {
    assert.equal(pick(both, ".", "go test ./..."), "image of pocketbase");
    assert.equal(pick(both, ".", "make test"), "image of pocketbase");
    assert.equal(pick(both, ".", "make ui"), "image of ui");
    assert.equal(pick(both, ".", "npm --prefix ui ci"), "image of ui");
    assert.equal(pick(both, "ui", "npm run build"), "image of ui");
    assert.equal(pick(both, ".", "cd ui && npm test"), "image of ui");
    assert.equal(pick(both, ".", "./scripts/release.sh"), "image of pocketbase", "an unknown tool goes to the root component");
  });

  test("a tool no assessed component uses stays in the repo's image", () => {
    assert.equal(pick([comp("pocketbase", ".", "go", false), comp("ui", "ui", "js")], ".", "go test ./..."), "the repo's image");
  });
});

describe("a failing Go or Rust test is named in the summary", () => {
  const out = (name: string) => readFileSync(join(dirname(new URL(import.meta.url).pathname), "tool-outputs", `${name}.txt`), "utf8");

  test("go test's --- FAIL lines, a subtest only when its parent isn't failing", () => {
    assert.deepEqual(failingTests(out("go-test-failed")), ["TestAdd", "TestTable"]);
    assert.deepEqual(diagnose(out("go-test-failed"), false, "test"), { cause: "unknown", detail: "TestAdd and 1 more failed" });
  });

  test("cargo test's FAILED lines", () => {
    assert.deepEqual(diagnose(out("cargo-test-failed"), false, "test"), { cause: "unknown", detail: "tests::adds failed" });
  });
});

// TheAlgorithms/C-Sharp@6d3b02a README.md:156 links ./Algorithms/Shufflers/LinqShuffler.cs, but the
// file is LINQShuffler.cs. A Mac's case-insensitive filesystem would let it pass there and fail on
// Linux, so paths are matched against the folders' listings, exactly.
describe("an instruction path must match the repo's spelling, on every filesystem", () => {
  test("existsExact compares each segment with its folder's listing", () => {
    const dir = repo({ "Algorithms/Shufflers/LINQShuffler.cs": "", Makefile: "test:\n\ttrue\n" });
    assert.equal(existsExact(dir, "Algorithms/Shufflers/LINQShuffler.cs"), true);
    assert.equal(existsExact(dir, "./Algorithms/Shufflers/../Shufflers/LINQShuffler.cs"), true);
    assert.equal(existsExact(dir, "Algorithms/Shufflers/LinqShuffler.cs"), false);
    assert.equal(existsExact(dir, "algorithms/Shufflers/LINQShuffler.cs"), false);
    assert.equal(existsExact(dir, "Algorithms"), true);
    assert.equal(existsExact(dir, "."), true);
    assert.equal(existsExact(dir, "makefile"), false);
  });

  test("a README link that differs from the file only in case is flagged", () => {
    const dir = repo({ "Algorithms/Shufflers/LINQShuffler.cs": "class LINQShuffler {}\n", "README.md": "# Algorithms\n\n- [LINQ shuffler](./Algorithms/Shufflers/LinqShuffler.cs)\n- [Same, spelled right](./Algorithms/Shufflers/LINQShuffler.cs)\n" });
    const items = instructionItems(dir, buildProfile(dir, dir, rubric)).filter((i) => i.kind === "path");
    assert.deepEqual(items.map((i) => [i.text, i.result]), [["./Algorithms/Shufflers/LinqShuffler.cs", "fail"], ["./Algorithms/Shufflers/LINQShuffler.cs", "pass"]]);
  });
});

describe("an instruction that runs a check's own command takes that check's result", () => {
  const tree = repo({ Makefile: "test:\n\tgo test ./...\n\nlint:\n\tgolangci-lint run ./...\n\nci:\n\tgo vet ./...\n\tgo test ./...\n" });
  const same = (a: string, b: string) => instructionKey(a, tree, ".") === instructionKey(b, tree, ".");

  test("the same test run with other flags, or through a one-line Make target, is the same run", () => {
    assert.ok(same("go test ./...", "go test -count=1 -v ./..."));
    assert.ok(same("make test", "go test -count=1 -v ./..."), "CONTRIBUTING.md:51 make test runs the contract's go test");
    assert.ok(same("GOFLAGS=-mod=readonly go test -run TestX ./...", "go test ./..."));
    assert.ok(same("cargo test", "cargo test --locked"));
    assert.ok(same("uv run pytest -q tests", ".venv/bin/python -m pytest tests"));
    assert.ok(same("./gradlew test", "gradle --no-daemon test"));
    assert.ok(same("./mvnw -B test", "mvn -q test"));
    assert.ok(same("dotnet test", "dotnet test --nologo"));
    assert.ok(same("bundle exec rspec", "rspec --format progress"));
    assert.ok(same("vendor/bin/phpunit", "./vendor/bin/phpunit --colors=never"));
  });

  test("a run that selects other packages, or a multi-line Make target, isn't", () => {
    assert.ok(!same("go test ./api/...", "go test ./..."));
    assert.ok(!same("cargo test -p core", "cargo test"));
    assert.ok(!same("make ci", "go test ./..."));
    assert.ok(!same("./gradlew build", "./gradlew test"));
    assert.ok(!same("pytest tests/unit", "pytest"));
  });
});

describe("a tool a Make recipe or script can't find is this machine's limit", () => {
  const out = (name: string) => readFileSync(join(dirname(new URL(import.meta.url).pathname), "tool-outputs", `${name}.txt`), "utf8");

  for (const form of ["direct", "shell", "script"]) {
    test(`make lint with golangci-lint missing (${form}): blocked, naming the tool`, () => {
      assert.deepEqual(diagnose(out(`make-missing-tool-${form}`), false, "instruction"), { cause: "missing_tool", detail: "golangci-lint is not installed" });
    });
  }

  test("a missing script of the repo's own stays the repo's failure", () => {
    assert.notEqual(diagnose("make: ./scripts/lint.sh: No such file or directory\nmake: *** [Makefile:2: lint] Error 127\n", false, "instruction").cause, "missing_tool");
  });
});

describe("a build's summary names the first compiler error", () => {
  const out = (name: string) => readFileSync(join(dirname(new URL(import.meta.url).pathname), "tool-outputs", `${name}.txt`), "utf8");

  test("dotnet build: the first error CS line, not MSBuild's tally (nested-apps-dotnet's commerce-core with an error planted)", () => {
    assert.deepEqual(diagnose(out("dotnet-build-failed"), false, "build"), { cause: "compile", detail: "CSC : error CS5001: Program does not contain a static 'Main' method suitable for an entry point" });
    assert.equal(compilerError("/work/Program.cs(3,11): error CS0103: The name 'WebApplication' does not exist in the current context [/work/IdentityDev.csproj]"), "/work/Program.cs(3,11): error CS0103: The name 'WebApplication' does not exist in the current context");
  });

  test("Maven: the first [ERROR] file line after COMPILATION ERROR", () => {
    assert.deepEqual(diagnose(out("maven-compile-failed"), false, "build"), { cause: "compile", detail: "/w/src/main/java/shop/Cart.java:[5,12] cannot find symbol" });
  });

  test("Gradle with kotlinc: the e: file line", () => {
    assert.deepEqual(diagnose(out("gradle-kotlin-compile-failed"), false, "build"), { cause: "compile", detail: "file:///w/src/main/kotlin/Points.kt:4:30 Unresolved reference 'gold'." });
  });

  test("anything else keeps the summary it had", () => {
    assert.equal(compilerError("npm error Lifecycle script `build` failed with error:\nnpm error code 1"), null);
    assert.deepEqual(diagnose("Error: something broke\n", false, "build"), { cause: "unknown", detail: "Error: something broke" });
  });
});

describe("servers and stalls don't spend the audit's time", () => {
  test("start, serve, dev and watch scripts, and a Make target that only serves, aren't replayed as if they finish", () => {
    const dir = repo({ "package.json": '{"name":"everything","scripts":{"start:sse":"node dist/sse.js","start:streamableHttp":"node dist/http.js","dev":"vite","build:watch":"tsc -w","startup-check":"node check.js"}}', Makefile: "serve:\n\tnpm run dev\n\ncheck:\n\tnpm run startup-check\n", "README.md": "# Everything\n\n- `npm run start:sse`\n- `npm run start:streamableHttp`\n- `npm run dev`\n- `npm run build:watch`\n- `npm run startup-check`\n- `make serve`\n- `make check`\n" });
    const items = instructionItems(dir, buildProfile(dir, dir, rubric)).filter((i) => i.kind === "command");
    assert.deepEqual(Object.fromEntries(items.map((i) => [i.text, i.category])), {
      "npm run start:sse": "long_running",
      "npm run start:streamableHttp": "long_running",
      "npm run dev": "long_running",
      "npm run build:watch": "long_running",
      "npm run startup-check": "replay",
      "make serve": "long_running",
      "make check": "replay",
    });
    assert.ok(items.filter((i) => i.category === "long_running").every((i) => i.result === "not_run" && /long-running/.test(i.reason ?? "")), "each says why it wasn't replayed");
  });

  test("a command line that timed out once isn't run again in the audit; a run with a planted fault still runs", async () => {
    const calls: string[] = [];
    const ex = { where: "container", strength: "clean_replay", image: "x", imageSource: "audit", root: "/w", networkOff: true, offline: () => true, close: () => {}, exec: async (command: string) => (calls.push(command), { exitCode: null, timedOut: true, durationMs: 300000, output: "" }) } as unknown as Executor;
    const timedOut = new Set<string>();
    banRepeats(ex, timedOut);
    assert.equal((await ex.exec("npm test", ".", 300)).durationMs, 300000);
    const again = await ex.exec("npm test", ".", 300);
    assert.deepEqual([again.timedOut, again.durationMs, again.output], [true, 0, `readiness: ${RAN_OUT_BEFORE}`]);
    assert.equal((await ex.exec("npm test", "packages/a", 300)).durationMs, 300000, "another folder is another command line");
    await ex.execFresh!("npm test", ".", 300);
    assert.deepEqual(calls, ["npm test", "npm test", "npm test"]);
  });

  test("a stall with no CPU while the network is off reads as a likely network wait", () => {
    const stalled = `> npm run pack:verify\nadded 0 packages\n${IDLE_MARK}: no CPU in its last 2 seconds, ${IDLE_OFFLINE}\n`;
    assert.deepEqual(diagnose(stalled, true, "test"), { cause: "network", detail: `the test step stopped using CPU ${IDLE_OFFLINE}, likely waiting on the network` });
    assert.equal(diagnose(`${IDLE_MARK}: no CPU in its last 2 seconds\n`, true, "test").cause, "timeout", "with the network on, a stall stays a timeout");
    assert.equal(diagnose("still crunching\n", true, "test").cause, "timeout");
  });

  test("a container command stuck with no CPU after the network is cut is marked idle at its timeout", { skip: detectRuntime("auto") ? false : "no container runtime: this needs docker or podman", timeout: 5 * 60 * 1000 }, async () => {
    const s = session(NODE_IMAGE, hostUser() ?? NO_ENTRY_UID);
    const started = s.start();
    assert.ok(started.ok, started.output);
    try {
      assert.ok(s.disconnectNetwork());
      const idle = await s.exec("sleep 60", ".", 3);
      assert.ok(idle.timedOut);
      assert.match(idle.output, new RegExp(`${IDLE_MARK}: no CPU in its last 2 seconds, ${IDLE_OFFLINE}`));
      const busy = await s.exec("while :; do :; done", ".", 3);
      assert.ok(busy.timedOut);
      assert.doesNotMatch(busy.output, new RegExp(IDLE_MARK), "a command spinning the CPU isn't idle");
    } finally {
      s.remove();
    }
  });
});

describe("the targeted-tests signal knows every scored toolchain's runner", () => {
  const signal = (language: Language, command: string) => {
    const dir = repo({ "README.md": "# x\n" });
    const profile = { ...buildProfile(dir, dir, rubric), components: [{ id: "app", path: ".", language, assessed: true, manifest: null, scripts: {}, changes: 1, changeShare: 1 }] };
    const contract = [{ id: "cmd-app-test", kind: "test" as const, component: "app", cwd: ".", command, source: "readiness", reason: "x", timeoutSec: 600 }];
    return staticSignals(dir, profile, contract).find((s) => s.id === "targeted_tests")!;
  };

  test("each runner says how it runs one test", () => {
    const cases: [Language, string, RegExp][] = [
      ["java", "./mvnw -B -q test", /-Dtest=Class/],
      ["kotlin", "./gradlew --no-daemon test", /--tests/],
      ["kotlin", "gradle jvmTest", /--tests/],
      ["csharp", "dotnet test --nologo", /--filter/],
      ["go", "go test -count=1 -v ./...", /-run/],
      ["rust", "cargo test --locked", /test name filter/],
      ["php", "vendor/bin/phpunit", /--filter/],
      ["php", "./vendor/bin/pest", /Pest/],
      ["ruby", "bundle exec rspec", /spec file/],
      ["ruby", "ruby -Itest test/cart_test.rb", /minitest/],
      ["ruby", "bin/rails test", /minitest/],
    ];
    for (const [language, command, how] of cases) {
      const s = signal(language, command);
      assert.equal(s.found, true, `${command}: ${s.detail}`);
      assert.match(s.detail, how, command);
    }
  });

  test("a command that runs no test runner still shows no way to run one file", () => {
    assert.equal(signal("go", "go vet ./...").found, false);
    assert.equal(signal("java", "./mvnw -B package -DskipTests=false").found, false);
  });
});

// modelcontextprotocol/servers@e1dc4b1: each class of instruction the open-network replay found, from
// the command's real output in the audit's images (Nov 15, 2026), offline, in a one-commit clone.
describe("mcp-servers' instruction findings are explained on their merits", () => {
  const out = (name: string) => readFileSync(join(dirname(new URL(import.meta.url).pathname), "tool-outputs", `${name}.txt`), "utf8");

  test("a ref the one-commit clean copy doesn't have is an environment limit, named", () => {
    for (const name of ["local-gate-missing-ref", "interface-diff-missing-ref", "verify-dco-missing-ref", "changeset-prompt"]) {
      const d = diagnose(out(name), false, "instruction");
      assert.equal(d.cause, "missing_ref", name);
      assert.match(d.detail, /^the clean copy has no (origin\/v2\/main|v2\/main) ref; it is one commit with no remote$/, name);
      assert.ok(environmentLimit(inContainer, install, d, []), "a contract command hitting it is blocked too");
    }
    assert.equal(missingRef("fatal: ambiguous argument 'origin/main': unknown revision or path not in the working tree."), "the clean copy has no origin/main ref; it is one commit with no remote");
  });

  test("a CLI a repo script can't find on PATH is a missing tool, named", () => {
    assert.deepEqual(diagnose(out("skills-eval-no-claude"), false, "instruction"), { cause: "missing_tool", detail: "claude is not installed" });
    assert.deepEqual(diagnose(out("coverage-py-no-uv"), false, "instruction"), { cause: "missing_tool", detail: "uv is not installed" });
    assert.deepEqual(diagnose("npm was not found on PATH, so Readability.js's dependencies cannot be installed\n", false, "instruction"), { cause: "missing_tool", detail: "npm is not installed" });
  });

  test("a test run that logs a fallback (\"Node.js was not found on PATH\") still fails on its own failures", () => {
    const pytest = "[fetch] Node.js was not found on PATH; using the pure-Python extractor\nFAILED tests/test_hidden_ssr.py::test_hydration - AssertionError: assert 'a' == 'b'\n1 failed, 490 passed in 14.2s\n";
    assert.notEqual(diagnose(pytest, false, "test").cause, "missing_tool");
  });

  test("a network lookup during the offline replay needs the network", () => {
    assert.equal(diagnose(out("uv-run-offline"), false, "instruction").cause, "network");
  });

  test("a command that needs a logged-in account needs access", () => {
    assert.deepEqual(diagnose(out("npm-whoami"), false, "instruction"), { cause: "credential", detail: "needs a logged-in npm account" });
  });

  test("a prompt that waits for a person is interactive", () => {
    assert.equal(diagnose("◻ @modelcontextprotocol/server-everything\n↑/↓ to navigate • Space: select • Enter: confirm\n", false, "instruction").cause, "interactive");
  });

  test("a per-package command run at the root, where its manifest isn't, belongs to one of the packages", () => {
    const dir = repo({ "package.json": "{}", "src/fetch/pyproject.toml": "", "src/git/pyproject.toml": "", "src/time/pyproject.toml": "" });
    const audit = makeAudit({ components: [] });
    audit.profile!.components = ["fetch", "git", "time"].map((s) => ({ id: s, path: `src/${s}`, language: "py" as const, manifest: `src/${s}/pyproject.toml`, scripts: {}, changes: 1, changeShare: 0.3, assessed: true }));
    assert.deepEqual(packageCommand(out("uv-lock-at-root"), audit, dir, "."), { manifest: "pyproject.toml", paths: ["src/fetch", "src/git", "src/time"] });
    assert.equal(packageCommand(out("uv-lock-at-root"), audit, dir, "src/git"), null, "in a package folder it's that package's own failure");
  });

  test("a script run without the arguments it requires stays a real finding", () => {
    const d = diagnose(out("release-notes-no-flags"), false, "instruction");
    assert.deepEqual([d.cause, d.detail], ["unknown", "release-notes: --milestone, --merge-sha, --merge-branch and --ledger-url are all required"]);
  });

  test("steps that can't be replayed as written are skipped with a reason, before anything runs", () => {
    const dir = repo({
      "package.json": '{"name":"servers","scripts":{"verify:dco":"node v.mjs","test:scripts":"node --test scripts/"}}',
      "src/fetch/pyproject.toml": "",
      "AGENTS.md": "# Servers\n\n```sh\n# Python: per server\ncd src/<server>\nuv run pytest\n```\n\n| Server | Runner |\n| --- | --- |\n| Root tooling | `node --test` |\n\n| Task | Command |\n| --- | --- |\n| One Python server | `uv run pytest -q` in `src/<server>` |\n\n`uv run` creates the server's `.venv` on first use. Check yours with `npm run verify:dco -- --base <lower branch>`.\n",
      "scripts/guard.mjs": "",
      ".claude/skills/release/SKILL.md": "# Release\n\n```sh\ncd ../servers-release && npm ci\nfor s in a b; do\n  node scripts/guard.mjs \"src/$s\"\ndone\n```\n",
    });
    const items = Object.fromEntries(instructionItems(dir, buildProfile(dir, dir, rubric)).filter((i) => i.kind === "command").map((i) => [i.text, [i.category, i.reason]]));
    assert.deepEqual(items["uv run pytest"], ["skipped", "not replayed: it runs in src/<server>, a folder the docs leave to the reader"]);
    assert.deepEqual(items["uv run pytest -q"], ["skipped", "not replayed: it runs in src/<server>, a folder the docs leave to the reader"]);
    assert.deepEqual(items["node --test"], ["skipped", "not replayed: it names a tool in a table's runner or tool column, not a command to run"]);
    assert.deepEqual(items["uv run"], ["skipped", "not replayed: it names the launcher, not a command for it to run"]);
    assert.deepEqual(items["npm run verify:dco -- --base <lower branch>"], ["skipped", "not replayed: it has a placeholder to fill in"]);
    assert.deepEqual(items["cd ../servers-release && npm ci"], ["skipped", "not replayed: it works in ../servers-release, outside this repository"]);
    assert.deepEqual(items['node scripts/guard.mjs "src/$s"'], ["skipped", "not replayed: it uses $s, a shell variable the lines around it set"]);
  });

  test("the audit's container reaps orphaned processes, so a killed process tree is gone", { skip: detectRuntime("auto") ? false : "no container runtime: this needs docker or podman", timeout: 5 * 60 * 1000 }, async () => {
    assert.ok(startArgs("c", "node:22", "/w").includes("--init"));
    const s = session(NODE_IMAGE, hostUser() ?? NO_ENTRY_UID);
    const started = s.start();
    assert.ok(started.ok, started.output);
    try {
      assert.equal((await s.exec("sleep 300 & echo $! > /tmp/home/child", ".", 30)).exitCode, 0);
      const gone = await s.exec("kill $(cat /tmp/home/child) && sleep 1 && test ! -e /proc/$(cat /tmp/home/child)", ".", 30);
      assert.equal(gone.exitCode, 0, `the orphan stayed a zombie: ${gone.output}`);
    } finally {
      s.remove();
    }
  });
});

describe("PHP, Ruby, JVM and .NET commands in the docs are instructions", () => {
  test("they're extracted, and a version or a word after the tool's name stays prose", () => {
    const md = "# Dev\n\n- `composer test`\n- `bundle exec rake test`\n- `bin/rails test test/models/cart_test.rb`\n- `vendor/bin/phpunit --filter Cart`\n- `php artisan test`\n- `ruby -Itest test/cart_test.rb`\n- `./mvnw test`\n- `gradle test`\n- `dotnet test`\n- `mvn -B verify`\n\nNeeds `ruby 3.3`, `php 8.2`, `gradle 8.5` and `dotnet 8.0`; see `ruby docs` too.\n";
    assert.deepEqual(extractFromMarkdown(md).filter((e) => e.kind === "command").map((e) => e.text), ["composer test", "bundle exec rake test", "bin/rails test test/models/cart_test.rb", "vendor/bin/phpunit --filter Cart", "php artisan test", "ruby -Itest test/cart_test.rb", "./mvnw test", "gradle test", "dotnet test", "mvn -B verify"]);
  });

  test("a documented test command takes the test check's result instead of running again", async () => {
    const cases: [string, string][] = [
      ["bundle exec rake test", "bundle exec rake test"],
      ["composer test", "composer run-script --timeout=0 test"],
      ["./mvnw test", "./mvnw -B -q test"],
      ["dotnet test", "dotnet test --nologo"],
    ];
    for (const [documented, contract] of cases) {
      const dir = repo({ "package.json": '{"name":"app"}', mvnw: "#!/bin/sh\n", "AGENTS.md": `# App\n\n- Test: \`${documented}\`\n` });
      const audit = makeAudit({ components: [] });
      audit.instructions = instructionItems(dir, buildProfile(dir, dir, rubric)).filter((i) => i.kind === "command");
      assert.equal(audit.instructions.length, 1, documented);
      audit.contract = [{ id: "cmd-app-test", kind: "test", component: "app", cwd: ".", command: contract, source: "readiness", reason: "x", timeoutSec: 600 }];
      audit.evidence = [{ id: "ev-001", at: audit.createdAt, checkId: "bootstrap.cold_replay", condition: "clean.test", component: "app", kind: "test", contractId: "cmd-app-test", strength: "clean_replay", where: "container", result: "pass", command: contract, summary: "test passed" }];
      const ex = { ...({} as Executor), where: "container", exec: async () => assert.fail(`${documented} ran again`) } as unknown as Executor;
      await replayInstructions(audit, ex, dir, newBudget(15, 60), [], null);
      const item = audit.instructions[0];
      assert.deepEqual([item.result, item.reason, item.evidenceId], ["pass", "it runs the same command as the test check, which passed", "ev-001"], documented);
    }
  });
});

describe("final review round: blocked registries and tests that need the network (B2, H8, the PyPI handshake)", () => {
  const out = (name: string) => readFileSync(join(dirname(OUTPUTS), "tool-outputs", `${name}.txt`), "utf8");

  test("google/gson@6c06cbc behind a blocked Maven Central: the build extension's artifact descriptor, the only error -q and -e print, reads as blocked", () => {
    const d = diagnose(output("maven-extension-egress-blocked"), false, "install");
    assert.deepEqual(d, { cause: "network", detail: "an unreachable package registry on the network" });
    assert.match(environmentLimit(inContainer, install, d, []) ?? "", /^the install hit an unreachable package registry/);
  });

  test("pallets/click@e38188e behind a blocked PyPI: uv's \"tls handshake eof\" is an unreachable registry, not a certificate problem", () => {
    assert.deepEqual(diagnose(output("uv-egress-blocked"), false, "install"), { cause: "network", detail: "an unreachable package registry on the network" });
    const badCert = "  ├─▶ error sending request for url (https://files.pythonhosted.org/packages/x.whl)\n  ╰─▶ invalid peer certificate: UnknownIssuer";
    assert.equal(diagnose(badCert, false, "install").detail, "a TLS or certificate error on the network", "a certificate the client rejects is still a certificate error");
  });

  test("pocketbase@7f2773e's OAuth2 test fails offline with no network error: the failing test names the host it fetches", () => {
    const d = diagnose(out("go-test-offline-fetch"), false, "test");
    assert.deepEqual(d, { cause: "network", detail: "TestRecordAuthWithOAuth2 failed; it refers to pocketbase.io, and tests run with the network off" });
    assert.equal(environmentLimit(inContainer, { ...install, id: "cmd-app-test", kind: "test" }, d, []), undefined, "a test that needs the network is still the repo's to fix");
    assert.equal(diagnose(out("go-test-offline-fetch"), false, "install").cause, "unknown", "only a test run is read this way");
    assert.deepEqual(diagnose(out("go-test-offline-fetch-verbose"), false, "test"), d, "go test -v, as the audit runs it: the log sits under the subtest's === RUN line, above the package's FAIL line");
    const laterPassing = `${out("go-test-offline-fetch-verbose")}\n=== RUN   TestUpload\n    upload_test.go:9: using https://s3.amazonaws.com/bucket\n--- PASS: TestUpload (0.01s)\nok  \tgithub.com/x/y\t0.1s\n`;
    assert.equal(diagnose(laterPassing, false, "test").detail, d.detail, "a passing test's URL further down isn't the failing test's");
  });

  test("a failing test whose output links to docs, a local server or a reserved domain isn't called a network test", () => {
    for (const text of [
      "FAIL src/a.test.ts\n  expect(received).toBe(expected) // see https://jestjs.io/docs/expect\n  Expected: 2\n  Received: 3",
      "--- FAIL: TestServe (0.00s)\n    serve_test.go:12: GET http://127.0.0.1:8080/health: got 500, want 200",
      "--- FAIL: TestURL (0.00s)\n    url_test.go:9: parsed https://api.example.com/v1 wrong",
      "--- FAIL: TestIssue (0.00s)\n    issue_test.go:4: regression for https://github.com/org/repo/issues/12",
    ]) assert.notEqual(diagnose(text, false, "test").cause, "network", text);
  });

  test("a network error printed by a test is explained as the network being off for tests", () => {
    assert.deepEqual(diagnose("--- FAIL: TestFetch (0.01s)\n    fetch_test.go:20: Get \"https://api.stripe.com/v1\": dial tcp: lookup api.stripe.com: Temporary failure in name resolution", false, "test"), { cause: "network", detail: "a test tried to reach the network, which is off while tests run" });
  });
});
