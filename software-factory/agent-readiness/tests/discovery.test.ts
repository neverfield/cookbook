import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildProfile, discoverLayout } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { latestRubricVersion, loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { capCutFolders, capCutReason, sampledScope } from "../skill/agent-readiness/scripts/lib/scope.ts";
import { listFiles, listFilesScoped } from "../skill/agent-readiness/scripts/lib/util.ts";
import { makeAudit } from "./helpers.ts";

const rubric = loadRubric(latestRubricVersion());

function tree(files: Record<string, string>, opts: { git?: boolean } = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), "readiness-discovery-")), "repo");
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

// The shape of open-telemetry/opentelemetry-demo: a root package.json with only markdownlint, and
// services in many languages under src/, some Python ones with only a requirements.txt.
const otelDemo: Record<string, string> = {
  "package.json": JSON.stringify({ name: "opentelemetry-demo", private: true, devDependencies: { "markdownlint-cli": "^0.50.0" } }),
  "package-lock.json": "{}",
  "README.md": "# Demo\n",
  "src/agent/requirements.txt": "openai==1.0.0\n",
  "src/agent/run.py": "print('agent')\n",
  "src/load-generator/requirements.txt": "locust==2.0.0\n",
  "src/load-generator/locustfile.py": "print('load')\n",
  "src/flagd-ui/mix.exs": "defmodule FlagdUi.MixProject do\n  def project, do: [app: :flagd_ui, version: \"0.1.0\"]\nend\n",
  "src/flagd-ui/mix.lock": "%{}\n",
  "src/flagd-ui/lib/flagd_ui.ex": "defmodule FlagdUi do\nend\n",
  "src/checkout/go.mod": "module checkout\n\ngo 1.22\n",
  "src/checkout/main.go": "package main\n",
  "src/payment/package.json": JSON.stringify({ name: "payment", scripts: { test: "node --test" } }),
  "src/payment/package-lock.json": "{}",
  "src/payment/index.js": "module.exports = 1;\n",
  "src/telemetry-docs/requirements.txt": "mkdocs==1.6.0\n",
  "src/telemetry-docs/mkdocs.yml": "site_name: docs\n",
};

describe("polyglot monorepo discovery", () => {
  test("requirements-only Python and Elixir services next to a tooling-only root are components, and the root isn't", () => {
    const { components, satellites } = layout(tree(otelDemo));
    const byPath = new Map(components.map((c) => [c.path, c]));
    assert.equal(byPath.get("src/agent")?.stack, "pip");
    assert.equal(byPath.get("src/load-generator")?.stack, "pip");
    assert.equal(byPath.get("src/flagd-ui")?.stack, "elixir");
    assert.equal(byPath.get("src/flagd-ui")?.lockfile, "src/flagd-ui/mix.lock");
    assert.match(byPath.get("src/flagd-ui")!.notAssessedReason!, /Elixir/);
    assert.equal(byPath.get("src/checkout")?.stack, "go");
    assert.equal(byPath.get("src/payment")?.stack, "npm");
    assert.equal(byPath.has("."), false, "a root with only markdownlint can't take the repo's changes and set its level");
    assert.equal(byPath.has("src/telemetry-docs"), false, "a requirements.txt with no Python next to it is a docs build, not a service");
    const root = satellites.find((s) => s.path === ".");
    assert.match(root!.reason, /only repo tooling \(markdownlint-cli\)/);
  });

  test("a root package with dependencies, a test script or source of its own stays a component", () => {
    const extras: Record<string, string>[] = [
      { "package.json": JSON.stringify({ name: "app", dependencies: { express: "4.0.0" } }) },
      { "package.json": JSON.stringify({ name: "app", scripts: { test: "node --test" } }) },
      { "package.json": JSON.stringify({ name: "app" }), "lib/index.js": "module.exports = 1;\n" },
    ];
    for (const extra of extras) {
      const { components } = layout(tree({ ...otelDemo, ...extra }));
      assert.ok(components.some((c) => c.path === "."), Object.keys(extra).join(", "));
    }
  });

  test("next to a Python root, a nested requirements-only folder is still part of it", () => {
    const { components } = layout(tree({ "pyproject.toml": "[project]\nname = \"app\"\n", "app/main.py": "x = 1\n", "scripts/requirements.txt": "requests==2.0.0\n", "scripts/tool.py": "x = 1\n" }));
    assert.deepEqual(components.map((c) => c.path), ["."]);
  });

  test("a Python docs build under docs/ is a satellite, not a component that has no tests", () => {
    const { components, satellites } = layout(tree({ ...otelDemo, "docs/requirements.txt": "sphinx==7.0.0\n", "docs/conf.py": "project = 'x'\n" }));
    assert.equal(components.some((c) => c.path === "docs"), false);
    assert.match(satellites.find((s) => s.path === "docs")!.reason, /documentation build/);
  });
});

// The shape of a shallow torvalds/linux clone: huge deep trees that sort first (arch, drivers), core
// folders after them (fs, kernel, mm), and a Python docs build under Documentation/.
function kernelShaped(): Record<string, string> {
  const files: Record<string, string> = {
    "Makefile": "all:\n",
    "Documentation/sphinx/requirements.txt": "sphinx==7.0.0\n",
    "Documentation/sphinx/kerneldoc.py": "x = 1\n",
    "fs/ext4/inode.c": "int x;\n",
    "kernel/sched/core.c": "int x;\n",
    "mm/slab.c": "int x;\n",
  };
  for (let i = 0; i < 30; i++) files[`arch/x86/kernel/cpu/f${i}.c`] = "int x;\n";
  for (let i = 0; i < 30; i++) files[`drivers/gpu/drm/amd/f${i}.c`] = "int x;\n";
  return files;
}

describe("a file cap on a large tree", () => {
  test("the listing drops the deepest files of every folder, not whole folders that sort late, and names what it cut", () => {
    const dir = tree(kernelShaped());
    const { files, cut } = listFilesScoped(dir, { maxFiles: 20 });
    assert.equal(files.length, 20);
    for (const f of ["fs/ext4/inode.c", "kernel/sched/core.c", "mm/slab.c", "Documentation/sphinx/kerneldoc.py"]) assert.ok(files.includes(f), `${f} is listed`);
    assert.deepEqual(cut, ["arch", "drivers"]);
    assert.deepEqual(files, [...files].sort((a, b) => (a.split("/").join("\0") < b.split("/").join("\0") ? -1 : 1)), "files come back in a depth-first walk's order");
    assert.deepEqual(listFilesScoped(dir).cut, [], "under the cap nothing is cut");
  });

  test("a folder the cap cut short is listed with its share of changes, and the report's sampled scope names it", () => {
    const dir = tree(kernelShaped(), { git: true });
    const profile = buildProfile(dir, dir, rubric, "HEAD", 20);
    const cut = profile.components.filter((c) => c.notAssessedReason === capCutReason(20));
    assert.deepEqual(cut.map((c) => c.path), ["arch", "drivers"]);
    assert.deepEqual(cut.map((c) => c.changeShare), [0.484, 0.484], "their changes come from git, not the capped listing");
    const sphinx = profile.components.find((c) => c.path === "Documentation/sphinx");
    assert.ok(sphinx && sphinx.changeShare < 0.1, "the docs build no longer gets every change");
    const audit = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] });
    audit.profile = { ...profile, scope: { boundMinutes: 3, files: 20, fileCap: 20, secrets: { scanned: 20, total: 20 }, assetHistory: { read: 0, total: 0 } } };
    assert.equal(sampledScope(audit), "the scan stopped at 20 files, before it listed everything in arch and drivers, which aren't assessed");
    assert.deepEqual(capCutFolders(audit), ["arch", "drivers"], "the scan's log names the same folders");
    assert.deepEqual(capCutFolders({ profile: { ...audit.profile, scope: { ...audit.profile.scope!, fileCap: null } } }), []);
  });
});
