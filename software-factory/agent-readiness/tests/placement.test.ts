import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { discoverContract, makeTestTarget } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { ecosystemOf } from "../skill/agent-readiness/scripts/lib/languages/index.ts";
import { buildProfile, discoverLayout } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { latestRubricVersion, loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { listFiles } from "../skill/agent-readiness/scripts/lib/util.ts";
import { fixtureNames, materialize } from "../support/tools/fixture.ts";

const rubric = loadRubric(latestRubricVersion());
const older = loadRubric("2026-11-beta");

function tree(files: Record<string, string>, opts: { git?: boolean } = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), "readiness-placement-")), "repo");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  if (opts.git) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Contributor A", "-c", "user.email=a@example.com", "commit", "-q", "-m", "initial"], { cwd: dir });
  }
  return dir;
}

const layout = (dir: string) => discoverLayout(dir, listFiles(dir, { includeHidden: true }), "repo");
const node = (name: string, scripts: Record<string, string> = { test: "node --test" }) => JSON.stringify({ name, version: "1.0.0", scripts });

describe("every manifest is placed", () => {
  test("in every fixture, each folder holding a manifest is placed exactly once, and none is left unplaced", () => {
    for (const name of fixtureNames()) {
      const repo = materialize(name);
      const { units } = layout(repo);
      const paths = units.map((u) => u.path);
      assert.equal(new Set(paths).size, paths.length, `${name}: a folder placed twice`);
      assert.deepEqual(units.filter((u) => u.placement === "unplaced").map((u) => u.manifest), [], name);
      for (const u of units) if (u.placement === "member" || u.placement === "satellite") assert.ok(u.of === undefined || paths.includes(u.of) || u.of === ".", `${name}: ${u.path} belongs to ${u.of}, which isn't placed`);
    }
  });

  test("a manifest under vendored or test-data folders is excluded, and one inside a project's build is a member of it", () => {
    const { units } = layout(tree({ "go.mod": "module app\n\ngo 1.22\n", "main.go": "package main\n", "testdata/proj/package.json": node("proj"), "scripts/requirements.txt": "x==1\n", "scripts/tool.py": "x = 1\n" }));
    const by = Object.fromEntries(units.map((u) => [u.path, [u.placement, u.of ?? null]]));
    assert.deepEqual(by["testdata/proj"], ["excluded", null]);
    assert.deepEqual(by["."], ["component", null]);
  });
});

describe("nested modules", () => {
  test("every go.mod is a module of its own; one under a hint folder is a satellite whose manifest is its go.mod", () => {
    const { components, satellites } = layout(tree({ "go.mod": "module ledger\n\ngo 1.22\n", "ledger.go": "package ledger\n", "exp/go.mod": "module ledger/exp\n\ngo 1.22\n", "exp/batch.go": "package exp\n", "benchmarks/go.mod": "module ledger/benchmarks\n\ngo 1.22\n", "benchmarks/apex_test.go": "package benchmarks\n" }));
    assert.deepEqual(components.map((c) => [c.path, c.manifest]), [[".", "go.mod"], ["exp", "exp/go.mod"]]);
    assert.deepEqual(satellites.map((s) => [s.path, s.manifest]), [["benchmarks", "benchmarks/go.mod"]]);
  });

  test("a nested crate outside any workspace is a component; a workspace's members and the crates it excludes are not", () => {
    const lone = layout(tree({ "Cargo.toml": "[package]\nname = \"pricing\"\n", "src/lib.rs": "\n", "exp/Cargo.toml": "[package]\nname = \"exp\"\n", "exp/src/lib.rs": "\n" }));
    assert.deepEqual(lone.components.map((c) => c.path), [".", "exp"]);
    const ws = layout(tree({ "Cargo.toml": "[workspace]\nmembers = [\"crates/*\"]\nexclude = [\"crates/legacy\"]\n", "crates/core/Cargo.toml": "[package]\nname = \"core\"\n", "crates/core/src/lib.rs": "\n", "crates/legacy/Cargo.toml": "[package]\nname = \"legacy\"\n", "crates/legacy/src/lib.rs": "\n" }));
    assert.deepEqual(ws.components.map((c) => c.path), ["."]);
    assert.deepEqual(ws.units.filter((u) => u.path.startsWith("crates/")).map((u) => [u.path, u.placement, u.of]), [["crates/core", "member", "."], ["crates/legacy", "member", "."]]);
  });
});

describe("workspaces", () => {
  test("an app at the root of a pnpm workspace is a component beside the members, and members report the root lockfile", () => {
    const { components } = layout(tree({ "package.json": node("web-app"), "pnpm-workspace.yaml": "packages:\n  - packages/*\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "src/index.js": "export {};\n", "packages/api/package.json": node("api"), "packages/api/src/index.js": "export {};\n" }));
    assert.deepEqual(components.map((c) => [c.path, c.lockfile]), [[".", "pnpm-lock.yaml"], ["packages/api", "pnpm-lock.yaml"]]);
  });

  test("members with no test script of their own are members of a root that runs the tests; a root that only runs its members' scripts is no component", () => {
    const runs = layout(tree({ "package.json": JSON.stringify({ name: "mono", workspaces: ["packages/*"], scripts: { test: "vitest" } }), "package-lock.json": "{}", "packages/cli/package.json": node("cli", {}), "packages/cli/src/a.test.ts": "\n", "packages/write/package.json": node("write") }));
    assert.deepEqual(runs.components.map((c) => c.path), [".", "packages/write"]);
    assert.deepEqual(runs.members.map((m) => [m.path, m.of]), [["packages/cli", "."]]);
    const delegates = layout(tree({ "package.json": JSON.stringify({ name: "mono", workspaces: ["packages/*"], scripts: { test: "npm run test --workspaces" } }), "package-lock.json": "{}", "scripts/lint.mjs": "\n", "packages/a/package.json": node("a") }));
    assert.deepEqual(delegates.components.map((c) => c.path), ["packages/a"]);
  });

  test("a root with tests of its own beside its members is a component, even when its test script runs the members'", () => {
    const { components } = layout(tree({ "package.json": JSON.stringify({ name: "servers", workspaces: ["src/*"], scripts: { test: "npm run test --workspaces", "test:scripts": "node --test scripts/" } }), "package-lock.json": "{}", "scripts/verify.mjs": "\n", "scripts/verify.test.mjs": "\n", "src/a/package.json": node("a") }));
    assert.deepEqual(components.map((c) => c.path), [".", "src/a"]);
  });

  test("a Lerna monorepo with no workspaces field takes its packages from lerna.json", () => {
    const { components } = layout(tree({ "package.json": JSON.stringify({ name: "mono", scripts: { test: "lerna run test" } }), "package-lock.json": "{}", "lerna.json": JSON.stringify({ packages: ["packages/*"] }), "packages/a/package.json": node("a"), "packages/b/package.json": node("b") }));
    assert.deepEqual(components.map((c) => c.path), ["packages/a", "packages/b"]);
  });

  test("a committed build folder with its own lockfile is a project; build output without one isn't", () => {
    const dir = tree({ "services/build/package.json": node("build"), "services/build/package-lock.json": "{}", "services/build/src/index.js": "\n", "web/package.json": node("web"), "web/package-lock.json": "{}", "web/dist/package.json": node("bundle") }, { git: true });
    const profile = buildProfile(dir, dir, rubric);
    assert.deepEqual(profile.components.map((c) => c.path).sort(), ["services/build", "web"]);
    assert.ok(profile.components.find((c) => c.path === "services/build")!.changes > 0, "a component under build/ owns its own changes");
  });
});

describe("folder-name hints and shares", () => {
  const plugins = { "package.json": JSON.stringify({ name: "mono", workspaces: ["packages/*", "plugins/*"] }), "package-lock.json": "{}", "packages/core/package.json": node("core"), "packages/core/index.js": "\n", "plugins/auth/package.json": node("auth"), "plugins/auth/a.js": "\n", "plugins/auth/b.js": "\n", "plugins/cache/package.json": node("cache"), "plugins/cache/a.js": "\n", "plugins/cache/b.js": "\n" };

  test("a plugins/ folder holding most of the changes stays components; without the history, or under 2026-11-beta, the hint demotes it", () => {
    const dir = tree(plugins, { git: true });
    assert.deepEqual(buildProfile(dir, dir, rubric).components.map((c) => c.path), ["packages/core", "plugins/auth", "plugins/cache"]);
    assert.deepEqual(buildProfile(dir, dir, older).components.map((c) => c.path), ["packages/core"]);
    assert.deepEqual(layout(dir).components.map((c) => c.path), ["packages/core"]);
  });

  test("shares are of every counted change, and what no component or satellite holds is the unowned share", () => {
    const dir = tree({ "app/package.json": node("app"), "app/package-lock.json": "{}", "app/a.js": "\n", "app/b.js": "\n", "docs/guide.md": "#\n", "README.md": "#\n", "examples/demo/package.json": node("demo"), "examples/demo/package-lock.json": "{}" }, { git: true });
    const profile = buildProfile(dir, dir, rubric);
    const app = profile.components.find((c) => c.path === "app")!;
    const demo = profile.satellites.find((s) => s.path === "examples/demo")!;
    assert.equal(profile.ownership!.changes, 6, "lockfiles don't count");
    assert.deepEqual([app.changeShare, demo.changeShare, profile.ownership!.unownedShare], [0.5, 0.167, 0.333]);
    assert.deepEqual([...profile.ownership!.unownedTop].sort(), ["README.md", "docs/"]);
    assert.equal(buildProfile(dir, dir, older).components.find((c) => c.path === "app")!.changeShare, 1, "2026-11-beta's shares are of owned changes");
  });
});

describe("task runners and test extras", () => {
  test("a Make target that runs the tests through a target it depends on or calls is found, with its line", () => {
    assert.deepEqual(makeTestTarget(".PHONY: test\ntest:\n\tnpm run test:unit\n"), { target: "test", line: 2 });
    assert.deepEqual(makeTestTarget("all: build\n\ntest: lint unit\n\nunit:\n\t@go test ./...\n"), { target: "test", line: 3 });
    assert.deepEqual(makeTestTarget("check:\n\t$(MAKE) -s cover\ncover:\n\tpytest --cov\n"), { target: "check", line: 1 });
    assert.equal(makeTestTarget("test:\n\techo nothing here\n"), null);
    assert.equal(makeTestTarget("build:\n\tgo build ./...\n"), null);
  });

  test("a package with only a test:unit script, run by make test, gets make test as its test command", () => {
    const dir = tree({ "package.json": node("billing", { "test:unit": "node --test test/" }), "package-lock.json": "{}", Makefile: ".PHONY: test\ntest:\n\tnpm run test:unit\n", "test/a.test.js": "\n" });
    const test = discoverContract(buildProfile(dir, dir, rubric), dir, rubric, []).find((c) => c.kind === "test")!;
    assert.deepEqual([test.command, test.source], ["make test", "Makefile:2"]);
  });

  test("tox runs the tests when the repo configures it and declares pytest nowhere else, and the install adds tox", () => {
    const dir = tree({ "pyproject.toml": "[project]\nname = \"pricing\"\n", "tox.ini": "[testenv]\ndeps = pytest\ncommands = pytest test/\n", "src/pricing/__init__.py": "\n", "test/test_a.py": "\n" });
    const cmds = discoverContract(buildProfile(dir, dir, rubric), dir, rubric, []);
    assert.match(cmds.find((c) => c.kind === "test")!.command, /-m tox$/);
    assert.match(cmds.find((c) => c.kind === "install")!.command, / tox$/);
  });

  test("the install includes the optional-dependency extra that declares pytest", () => {
    const dir = tree({ "pyproject.toml": "[project]\nname = \"pricing\"\n\n[project.optional-dependencies]\ntest = [\"pytest>=8\"]\ndocs = [\"sphinx\"]\n", "src/pricing/__init__.py": "\n" });
    assert.match(ecosystemOf("pip")!.install(dir, ".", { ignoreScripts: false }).command, / -e '\.\[test\]'$/);
  });
});
