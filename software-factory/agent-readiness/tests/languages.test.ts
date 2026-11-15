import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { ContainerSession, IMAGE_PATH_VAR, detectRuntime, hostUser, loginShell } from "../skill/agent-readiness/scripts/lib/container.ts";
import { commandTimeout, discoverContract, imagePlan } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { IMAGE_DIGESTS } from "../skill/agent-readiness/scripts/lib/images.ts";
import { inComponent, namedAfter, sameFolder, withInlineTests } from "../skill/agent-readiness/scripts/lib/languages/coverage.ts";
import { ECOSYSTEMS, LANGUAGES, ecosystemOf, languageOf } from "../skill/agent-readiness/scripts/lib/languages/index.ts";
import type { ReplayHooks } from "../skill/agent-readiness/scripts/lib/languages/language.ts";
import { ruby } from "../skill/agent-readiness/scripts/lib/languages/ruby.ts";
import { chooseSites, targetFiles, testFiles } from "../skill/agent-readiness/scripts/lib/mutate.ts";
import { buildProfile } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { budgetFloors, environmentLimit, replay } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { diagnose } from "../skill/agent-readiness/scripts/lib/diagnose.ts";
import { scanText } from "../skill/agent-readiness/scripts/lib/redact.ts";
import { jvm } from "../skill/agent-readiness/scripts/lib/languages/jvm.ts";
import { loadRubric, latestRubricVersion } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { STACKS, supported } from "../skill/agent-readiness/scripts/lib/support.ts";
import type { Language } from "../skill/agent-readiness/scripts/lib/types.ts";
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
    assert.deepEqual([fixed.command, fixed.frozen, fixed.unpinned], ["./mvnw -B -q dependency:go-offline", true, null]);
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
      { image: "ghcr.io/astral-sh/uv:python3.13-bookworm-slim", components: ["pricing"] },
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
    assert.deepEqual(plan.map((g) => g.image), ["ghcr.io/astral-sh/uv:python3.12-bookworm-slim", "node:22-bookworm"]);
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
    assert.deepEqual(scanText("APP_SECRET=not-a-secret--read-the-doc!\n").map((h) => h.line), [1]);
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

