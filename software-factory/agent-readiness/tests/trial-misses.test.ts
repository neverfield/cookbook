import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { discoverContract, toolSetup } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { rubyImage } from "../skill/agent-readiness/scripts/lib/languages/ruby.ts";
import { buildProfile } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { instructionKey } from "../skill/agent-readiness/scripts/lib/instructions.ts";
import { instructionItems } from "../skill/agent-readiness/scripts/lib/static.ts";
import type { InstructionItem, Profile } from "../skill/agent-readiness/scripts/lib/types.ts";

// The general causes behind the rate misses and false instruction findings the Plan A trials found
// (airflow, eShop, netbox, langfuse, mastodon, spree, sentry-javascript, dd-trace-go, jellyfin,
// saleor), each reproduced in a small tree that has the same shape as the repo it came from.

const rubric = loadRubric();

function repo(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "trial-misses-")), "repo");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Contributor A", "-c", "user.email=a@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "initial"], { cwd: dir });
  return dir;
}

function profileOf(files: Record<string, string>): { dir: string; profile: Profile } {
  const dir = repo(files);
  return { dir, profile: buildProfile(dir, dir, rubric) };
}

function items(files: Record<string, string>): Map<string, InstructionItem> {
  const { dir, profile } = profileOf(files);
  return new Map(instructionItems(dir, profile).map((i) => [`${i.source}:${i.line} ${i.text}`, i]));
}

const failures = (by: Map<string, InstructionItem>) => [...by.entries()].filter(([, i]) => i.result === "fail").map(([k, i]) => `${k}: ${i.reason}`);

const pkg = (name: string, scripts: Record<string, string> = {}, extra: Record<string, unknown> = {}) => JSON.stringify({ name, version: "1.0.0", scripts, ...extra });
const pyproject = (name: string) => `[project]\nname = "${name}"\nversion = "1.0"\n\n[dependency-groups]\ndev = ["pytest"]\n`;

function testsOf(files: Record<string, string>): Map<string, string> {
  const { dir, profile } = profileOf(files);
  return new Map(discoverContract(profile, dir, rubric, []).filter((k) => k.kind === "test").map((k) => [k.component, k.command]));
}

describe("discovery (airflow, eShop, langfuse)", () => {
  const uvWorkspace = {
    "pyproject.toml": `[project]\nname = "app"\nversion = "1.0"\n\n[tool.uv.workspace]\nmembers = ["core", "dev/breeze", "scripts", "sdk"]\n`,
    "uv.lock": "",
    "core/pyproject.toml": pyproject("core"),
    "core/src/app/__init__.py": "",
    "core/tests/test_core.py": "def test_x():\n    assert True\n",
    "core/src/app/ui/package.json": pkg("ui", { test: "vitest run" }, { devDependencies: { vitest: "1" } }),
    "core/src/app/ui/pnpm-lock.yaml": "",
    "core/src/app/ui/src/app.test.ts": "test('x', () => {});\n",
    "dev/breeze/pyproject.toml": pyproject("breeze"),
    "dev/breeze/breeze.py": "",
    "scripts/pyproject.toml": pyproject("scripts"),
    "scripts/run.py": "",
    "sdk/pyproject.toml": pyproject("sdk"),
    "sdk/sdk.py": "",
  };

  test("a Node package with its own lockfile inside a Python workspace member is a component of its own", () => {
    const { profile } = profileOf(uvWorkspace);
    const ui = profile.components.find((c) => c.path === "core/src/app/ui");
    assert.ok(ui, `components: ${profile.components.map((c) => c.path).join(", ")}`);
    assert.equal(ui.stack, "pnpm");
    assert.equal(profile.units!.find((u) => u.path === "core/src/app/ui")?.placement, "component");
  });

  test("uv workspace members under dev/ and scripts/ are satellites, as in a Node workspace", () => {
    const { profile } = profileOf(uvWorkspace);
    assert.deepEqual(profile.satellites.map((s) => s.path).sort(), ["dev/breeze", "scripts"]);
    assert.deepEqual(profile.components.filter((c) => c.language === "py").map((c) => c.path).sort(), [".", "core", "sdk"]);
  });

  const solution = {
    "package.json": pkg("e2e-harness", { "test:e2e": "playwright test" }, { devDependencies: { "@playwright/test": "1" } }),
    "package-lock.json": "{}",
    "e2e/home.spec.ts": "",
    "Shop.slnx": `<Solution>\n  <Project Path="src/Api/Api.csproj" />\n  <Project Path="src/Client/Client.csproj" />\n  <Project Path="tests/Api.Tests/Api.Tests.csproj" />\n</Solution>\n`,
    "global.json": `{ "sdk": { "version": "8.0.100" } }\n`,
    "src/Api/Api.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n`,
    "src/Api/Program.cs": "class Program { static void Main() {} }\n",
    "src/Client/Client.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n`,
    "src/Client/Client.sln": "Microsoft Visual Studio Solution File, Format Version 12.00\n",
    "src/Client/App.cs": "class App {}\n",
    "tests/Api.Tests/Api.Tests.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup></Project>\n`,
    "tests/Api.Tests/ApiTests.cs": "public class ApiTests {}\n",
  };

  test("a root .slnx beside a root package.json is the .NET component, with the projects it lists as members", () => {
    const { profile } = profileOf(solution);
    const root = profile.components.find((c) => c.path === "." && c.stack === "dotnet");
    assert.ok(root, `components: ${profile.components.map((c) => `${c.path} ${c.stack}`).join(", ")}`);
    assert.equal(root.manifest, "Shop.slnx");
    const placed = Object.fromEntries(profile.units!.map((u) => [u.path, u.placement]));
    assert.equal(placed["src/Api"], "member");
    assert.equal(placed["tests/Api.Tests"], "member");
    // A folder with a solution of its own is built from it, apart from the root solution.
    assert.equal(placed["src/Client"], "component");
    assert.match(testsOf(solution).get(root.id) ?? "", /^dotnet test\b/);
  });

  const wrapper = {
    "package.json": pkg("mono", { test: "turbo run test" }, { devDependencies: { turbo: "2" } }),
    "pnpm-workspace.yaml": "packages:\n  - web\n  - gateway\n",
    "pnpm-lock.yaml": "",
    "web/package.json": pkg("web", { test: "vitest run" }, { devDependencies: { vitest: "1" } }),
    "web/src/a.test.ts": "",
    "gateway/package.json": pkg("gateway", { test: "pnpm run rust:test", "rust:test": "cargo test --locked" }),
    "gateway/Cargo.toml": `[package]\nname = "gateway"\nversion = "0.1.0"\nedition = "2021"\n`,
    "gateway/Cargo.lock": "version = 3\n",
    "gateway/src/lib.rs": "#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {}\n}\n",
  };

  test("a workspace member whose test script hands over to cargo is a Rust component, tested with cargo", () => {
    const { profile } = profileOf(wrapper);
    const gateway = profile.components.find((c) => c.path === "gateway")!;
    assert.equal(gateway.stack, "rust");
    assert.equal(gateway.manifest, "gateway/Cargo.toml");
    assert.match(testsOf(wrapper).get(gateway.id) ?? "", /^cargo test\b/);
    assert.equal(profile.components.find((c) => c.path === "web")?.stack, "pnpm");
  });

  test("at the cap, a package with a test script goes before one without at the same share", () => {
    const names = Array.from({ length: rubric.components.maxAssessed }, (_, i) => `p${String(i).padStart(2, "0")}`);
    const files: Record<string, string> = { "package.json": pkg("mono"), "pnpm-workspace.yaml": "packages:\n  - packages/*\n", "pnpm-lock.yaml": "" };
    for (const n of names) files[`packages/${n}/package.json`] = pkg(n);
    files["packages/zz-tested/package.json"] = pkg("zz-tested", { test: "vitest run" });
    const { profile } = profileOf(files);
    assert.equal(profile.components.find((c) => c.path === "packages/zz-tested")?.assessed, true);
    assert.equal(profile.components.filter((c) => c.assessed).length, rubric.components.maxAssessed);
  });
});

describe("test commands (netbox) and installs (mastodon)", () => {
  test("a Django project in a subfolder is tested with its manage.py, and .pytest_cache in a config isn't pytest", () => {
    const tests = testsOf({
      "requirements.txt": "Django==5.0\n",
      "pyproject.toml": `[project]\nname = "netbox"\nversion = "1.0"\n\n[tool.ruff]\nexclude = [".pytest_cache"]\n`,
      "netbox/manage.py": "import django\n",
      "netbox/netbox/settings.py": "",
      "netbox/dcim/tests/test_api.py": "",
    });
    assert.equal(tests.get("netbox"), ".readiness-venv/bin/python netbox/manage.py test netbox/");
  });

  test("pytest declared as a dependency still wins over manage.py", () => {
    const tests = testsOf({ "requirements.txt": "Django==5.0\npytest-django==4.9\n", "manage.py": "", "app/tests.py": "" });
    assert.match([...tests.values()][0] ?? "", /-m pytest -q$/);
  });

  test("a pnpm or Yarn component gets Corepack added where the image lacks it, as Node 26's does", () => {
    const { dir, profile } = profileOf({ "package.json": pkg("app", { test: "vitest run" }, { packageManager: "yarn@4.18.1" }), "yarn.lock": "__metadata:\n  version: 8\n", ".nvmrc": "26.13\n", "a.test.ts": "" });
    const corepack = toolSetup(profile, dir).find((t) => t.tool === "corepack");
    assert.ok(corepack, "corepack setup");
    assert.match(corepack.install, /^npm install -g .*corepack@\d/);
    assert.equal(corepack.present, undefined, "it runs only when `command -v corepack` fails");
    const npmOnly = profileOf({ "package.json": pkg("lib", { test: "node --test" }), "package-lock.json": "{}" });
    assert.equal(toolSetup(npmOnly.profile, npmOnly.dir).some((t) => t.tool === "corepack"), false);
  });

  test("an exact Ruby patch the table has gets that patch's image, so Bundler accepts the Gemfile's ruby", () => {
    const at = (version: string) => repo({ ".ruby-version": `${version}\n`, Gemfile: "source 'https://rubygems.org'\nruby file: '.ruby-version'\n" });
    assert.equal(rubyImage(at("4.0.10"), "."), "ruby:4.0.10-bookworm");
    assert.equal(rubyImage(at("4.0.9"), "."), "ruby:4.0-bookworm");
    assert.equal(rubyImage(at("3.3.6"), "."), "ruby:3.3-bookworm");
  });
});

describe("instruction findings that aren't wrong", () => {
  const workspace = {
    "package.json": pkg("mono", { test: "turbo run test", seed: "pnpm --filter=shared run seed:scenario", "dev:web": "turbo run dev --filter=web" }, { devDependencies: { turbo: "2" } }),
    "pnpm-workspace.yaml": "packages:\n  - web\n  - packages/*\n",
    "pnpm-lock.yaml": "",
    "web/package.json": pkg("web", { test: "vitest run", "test:watch": "vitest" }),
    "packages/shared/package.json": pkg("shared", { test: "vitest run", "seed:scenario": "tsx scripts/cli.ts" }),
  };

  test("a script written without its folder, which another package has, runs there and isn't a missing script (langfuse, spree)", () => {
    const by = items({
      ...workspace,
      "packages/shared/scripts/seeder/AGENTS.md": "# Seeder\n\n```bash\npnpm run seed -- doctor\n```\n",
      "web/AGENTS.md": "# Web\n\nStart it with `pnpm run dev:web`.\n",
      "CONTRIBUTING.md": "# Contributing\n\n```sh\npnpm run test:watch\npnpm run nothing-has-this\n```\n",
    });
    for (const key of ["packages/shared/scripts/seeder/AGENTS.md:4 pnpm run seed -- doctor", "web/AGENTS.md:3 pnpm run dev:web", "CONTRIBUTING.md:4 pnpm run test:watch"]) {
      assert.equal(by.get(key)?.rule, "per-package", key);
      assert.equal(by.get(key)?.result, "not_run", key);
    }
    assert.equal(by.get("CONTRIBUTING.md:5 pnpm run nothing-has-this")?.result, "fail");
  });

  test("a package-manager command no package defines, with words after it, is the manager's own command (langfuse, sentry-javascript)", () => {
    const by = items({ ...workspace, "CONTRIBUTING.md": "# Contributing\n\n- `pnpm change check` checks the versions agree.\n- `pnpm runtime set node 24 -g` sets Node.\n- `pnpm nosuchscript` does nothing.\n" });
    assert.equal(by.get("CONTRIBUTING.md:3 pnpm change check")?.rule, "pm-command");
    assert.equal(by.get("CONTRIBUTING.md:4 pnpm runtime set node 24 -g")?.rule, "pm-command");
    assert.equal(by.get("CONTRIBUTING.md:5 pnpm nosuchscript")?.result, "fail");
  });

  test("Make targets with a slash are found, and a missing one is still wrong (dd-trace-go)", () => {
    const by = items({ "go.mod": "module x\n\ngo 1.22\n", "x.go": "package x\n", Makefile: ".PHONY: lint/misc\nlint/misc: ## lint\n\techo lint\n\ntest/unit:\n\tgo test ./...\n", "CONTRIBUTING.md": "# Contributing\n\n```shell\nmake lint/misc\nmake test/unit\nmake test-integration\n```\n" });
    assert.notEqual(by.get("CONTRIBUTING.md:4 make lint/misc")?.result, "fail");
    assert.notEqual(by.get("CONTRIBUTING.md:5 make test/unit")?.result, "fail");
    assert.equal(by.get("CONTRIBUTING.md:6 make test-integration")?.result, "fail");
  });

  test("a step's file in the one folder that has it, and a guide that says which folder its commands run from (netbox)", () => {
    const files = { "requirements.txt": "Django==5.0\n", "netbox/manage.py": "", "netbox/netbox/settings.py": "" };
    const by = items({
      ...files,
      "AGENTS.md": "# NetBox\n\n## Commands\n\nAll commands run from the `netbox/` subdirectory with the venv active.\n\n| Command | What it does |\n|---|---|\n| `python manage.py test` | Run the tests |\n\n## Other\n\nText.\n",
      ".claude/skills/remove-model/SKILL.md": "---\nname: remove-model\n---\n\n# Remove\n\n```bash\npython manage.py migrate\npython nothere.py\n```\n",
    });
    assert.equal(by.get("AGENTS.md:9 python manage.py test")?.cwd, "netbox");
    assert.notEqual(by.get("AGENTS.md:9 python manage.py test")?.result, "fail");
    assert.equal(by.get(".claude/skills/remove-model/SKILL.md:8 python manage.py migrate")?.rule, "per-package");
    assert.equal(by.get(".claude/skills/remove-model/SKILL.md:9 python nothere.py")?.result, "fail");
  });

  test("a block given for a lockfile the folder doesn't have is another manager's alternative (netbox)", () => {
    const by = items({
      "web/package.json": pkg("web", { bundle: "esbuild" }),
      "web/yarn.lock": "",
      "AGENTS.md": "# UI\n\n## Update\n\nWork in `web/`. Pick the commands by lockfile.\n\n**npm** (`package-lock.json`):\n\n```bash\nnpm run upgrade\n```\n\n**yarn** (`yarn.lock`):\n\n```bash\nyarn bundle\nyarn missing\n```\n",
    });
    assert.equal(by.get("AGENTS.md:10 npm run upgrade")?.rule, "elsewhere");
    assert.notEqual(by.get("AGENTS.md:16 yarn bundle")?.result, "fail");
    assert.equal(by.get("AGENTS.md:17 yarn missing")?.result, "fail");
  });

  test("a folder one guide says a step makes isn't missing in another guide (spree)", () => {
    const by = items({
      ...workspace,
      "package.json": pkg("mono", { "server:setup": "sh scripts/server-setup.sh" }),
      "scripts/server-setup.sh": "#!/bin/sh\n",
      ".github/CONTRIBUTING.md": "# Contributing\n\n`pnpm server:setup` clones [spree-starter](https://github.com/spree/spree-starter) into `./server/`, then starts it.\n\nLint config is `server/.rubocop.yml`.\n",
      "AGENTS.md": "# Agents\n\n- Seed with `cd server && bin/rails db:seed`.\n- Then `cd nowhere && make x`.\n",
    });
    assert.deepEqual(failures(by), ["AGENTS.md:4 cd nowhere && make x: there is no nowhere folder to cd into"]);
    assert.equal(by.get("AGENTS.md:3 cd server && bin/rails db:seed")?.result, "not_run");
  });

  test("paths that belong to another repository, stay on the machine, or are written by a tool aren't stale (langfuse, airflow, sentry-javascript, dd-trace-go)", () => {
    const by = items({
      ...workspace,
      "web/src/log/os_task_handler.py": "",
      "task-sdk/src/sdk/coordinators/java/coordinator.py": "",
      "internal/appsec/appsec.go": "package appsec\n",
      "java-sdk/gradlew": "#!/bin/sh\n",
      "CONTRIBUTING.md": [
        "# Contributing",
        "",
        "- Tool-specific configs generated locally and not committed:",
        "  - `.cursor/mcp.json`",
        "  - `.codex/config.toml`",
        "",
        "- **Deploy access.** Add your login to `k8s/preview/bootstrap/set.yaml` (repo",
        "  `acme/infrastructure`), open a PR, and merge.",
        "",
        "The docs live in the Turborepo repository under `apps/docs/content/docs/`.",
        "",
        "Virtualenvs go under `.build/mypy-venvs/`; the cache is `dev/registry/.inventory_cache/`; the digest is `output/digest.json`.",
        "",
        "Release notes go in `docs/release-notes/version-X.Y.md`, schemas in `versions/vYYYY_MM_DD.py`, the site at `airflow.apache.org/registry/`.",
        "",
        "Tests mirror the source: `src/shared/route.ts` →",
        "  `test/shared/route.test.ts`. Use the app directory (e.g. `orders/lock_objects.py`).",
        "",
        "Benchmarks run `./internal/appsec/...`; the build writes `./app`; see `task-sdk/.../coordinators/java/coordinator.py` and `log/os_task_handler.py`.",
        "",
        "Always use `./gradlew` from inside `java-sdk/`.",
        "",
        "A stale one: `src/gone/away.ts`.",
        "",
      ].join("\n"),
      "web/AGENTS.md": "# Web\n\nUse the MCP server from `.cursor/mcp.json`.\n",
    });
    assert.deepEqual(failures(by), ["CONTRIBUTING.md:23 src/gone/away.ts: src/gone/away.ts doesn't exist"]);
  });

  test("a documented build is the build check's command, and a bare `dotnet run` in prose names the launcher (jellyfin)", () => {
    const dir = repo({ "a.txt": "" });
    assert.equal(instructionKey("dotnet build", dir, "."), instructionKey("dotnet build --no-restore", dir, "."));
    assert.equal(instructionKey("cargo build", dir, "."), instructionKey("cargo build --locked --offline", dir, "."));
    assert.notEqual(instructionKey("dotnet build src/App", dir, "."), instructionKey("dotnet build", dir, "."));
    const by = items({ "App.sln": "", "src/App/App.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n`, "src/App/Program.cs": "", "CONTRIBUTING.md": "# App\n\n## Running From the Command Line\n\nYou can use the `dotnet run` command. Run `dotnet run --project src/App`.\n" });
    assert.equal(by.get("CONTRIBUTING.md:5 dotnet run")?.rule, "mention");
    assert.notEqual(by.get("CONTRIBUTING.md:5 dotnet run --project src/App")?.rule, "mention");
  });

  test("a skill dotagents installs from another repository is vendored (sentry-javascript)", () => {
    const by = items({
      ...workspace,
      "agents.toml": `version = 1\n\n[[skills]]\nname = "dotagents"\nsource = "getsentry/dotagents"\n\n[[skills]]\nname = "own"\nsource = "path:.agents/skills/own"\n`,
      ".agents/skills/dotagents/SKILL.md": "---\nname: dotagents\n---\n\n# dotagents\n\nSymlinks: `.cursor/skills/` points here.\n\n```bash\npnpm run nothing\n```\n",
      ".agents/skills/own/SKILL.md": "---\nname: own\n---\n\n# Own\n\n```bash\npnpm run nothing\n```\n",
    });
    assert.equal(by.get(".agents/skills/dotagents/SKILL.md:10 pnpm run nothing")?.rule, "vendored");
    assert.equal(by.get(".agents/skills/own/SKILL.md:8 pnpm run nothing")?.result, "fail");
  });
});
