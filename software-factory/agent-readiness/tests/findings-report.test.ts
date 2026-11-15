import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { diagnose } from "../skill/agent-readiness/scripts/lib/diagnose.ts";
import { replayInstructions } from "../skill/agent-readiness/scripts/lib/instructions.ts";
import { newBudget } from "../skill/agent-readiness/scripts/lib/replay.ts";
import type { Executor } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { explanationGaps } from "../skill/agent-readiness/scripts/lib/explain.ts";
import { buildProfile, discoverComponents } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { renderMarkdown } from "../skill/agent-readiness/scripts/lib/render.ts";
import { renderHtml } from "../skill/agent-readiness/scripts/lib/render-html.ts";
import { updateRoadmap, watchFor } from "../skill/agent-readiness/scripts/lib/roadmap.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { compute } from "../skill/agent-readiness/scripts/lib/seal.ts";
import { INSTRUCTION_RULES, instructionItems, safetyScan } from "../skill/agent-readiness/scripts/lib/static.ts";
import type { Audit, InstructionItem } from "../skill/agent-readiness/scripts/lib/types.ts";
import { listFiles } from "../skill/agent-readiness/scripts/lib/util.ts";
import { WAIVER_FILE, WAIVER_SCHEMA, applyWaivers, loadWaivers } from "../skill/agent-readiness/scripts/lib/waivers.ts";
import { makeAudit, reportFor } from "./helpers.ts";

const rubric = loadRubric();

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "findings-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Contributor A", "-c", "user.email=a@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "initial"], { cwd: dir });
  return dir;
}

function items(files: Record<string, string>): Map<string, InstructionItem> {
  const dir = repo(files);
  return new Map(instructionItems(dir, buildProfile(dir, dir, rubric)).map((i) => [`${i.source}:${i.line} ${i.text}`, i]));
}

const pnpmLib = { "package.json": JSON.stringify({ name: "ms", scripts: { test: "jest", build: "tsc", "local:gate": "node gate.js" }, devDependencies: { jest: "1" } }), "pnpm-lock.yaml": "", "src/index.ts": "export const a = 1;\n" };

describe("the instruction checker skips what isn't a step for this repo", () => {
  test("README usage for the package's users isn't a finding, and the repo's own scripts in it still are checked", () => {
    const md = "# ms\n\n## Installation\n\n```\nnpm install ms\nyarn add ms\n```\n\n## Usage\n\n```\nnode split.js -s a\nnpx ms 1d\n./examples/pizza -V\n```\n\n## Caught a bug?\n\nLink it: `npm link`, then `npm link ms`. Run the tests with `npm test`, and `npm run missing`.\n";
    const by = items({ ...pnpmLib, "README.md": md });
    for (const key of ["README.md:6 npm install ms", "README.md:7 yarn add ms", "README.md:13 node split.js -s a", "README.md:14 npx ms 1d", "README.md:15 ./examples/pizza -V", "README.md:20 npm link", "README.md:20 npm link ms"]) {
      assert.equal(by.get(key)?.result, "not_run", key);
      assert.equal(by.get(key)?.category, "skipped", key);
    }
    assert.equal(by.get("README.md:20 npm test")!.category, "replay", "npm runs scripts in a pnpm repo, so its test script is a step to replay");
    assert.deepEqual([by.get("README.md:20 npm run missing")!.result, by.get("README.md:20 npm run missing")!.reason], ["not_run", by.get("README.md:20 npm run missing")!.reason]);
  });

  test("chains, cd, prose mentions, never-do sentences and steps for another checkout", () => {
    const agents = [
      "# Agents",
      "Before pushing, `npm run local:gate; echo \"EXIT=$?\"`.",
      "Then `cd web && npm test` and `cd nowhere && npm test`.",
      "It detects options like `node --eval`, and never `npm audit fix`.",
      "1. Inside the `pmndrs/docs` directory:",
      "   1. Run `npm install` and `npm run dev`.",
      "2. Run `npm run local:gate:missing`.",
      "## UI",
      "1. Navigate to the `web` directory",
      "2. Run `npm run build`.",
    ].join("\n");
    const by = items({ ...pnpmLib, "web/package.json": JSON.stringify({ name: "web", scripts: { test: "vitest", build: "vite build" } }), "web/package-lock.json": "{}", "AGENTS.md": agents });
    assert.equal(by.get('AGENTS.md:2 npm run local:gate; echo "EXIT=$?"')!.staticResult, "pass");
    assert.equal(by.get("AGENTS.md:3 cd web && npm test")!.staticResult, "pass");
    assert.match(by.get("AGENTS.md:3 cd nowhere && npm test")!.reason!, /no nowhere folder/);
    assert.equal(by.get("AGENTS.md:4 node --eval")!.rule, "mention");
    assert.equal(by.get("AGENTS.md:4 npm audit fix")!.rule, "negated");
    assert.equal(by.get("AGENTS.md:6 npm install")!.rule, "elsewhere", "a step for another repository isn't checked against this one");
    assert.match(by.get("AGENTS.md:7 npm run local:gate:missing")!.reason!, /no "local:gate:missing" script/, "the scope ends with its list");
    const build = by.get("AGENTS.md:10 npm run build")!;
    assert.deepEqual([build.staticResult, build.cwd], ["pass", "web"], "the section says to work in web");
  });

  test("paths: package-relative, deleted, examples, a sibling worktree and build output pass; a broken link still fails", () => {
    const skill = "# Structure\n\n`server/index.ts` holds the factory. `.github/dependabot.yml` is gone. For monorepos like `apps/backend/app.js`, see below. Work in a worktree (`../repo-4810`). Run `dist/index.js`. See [setup](docs/setup.md) and [canvas](file:///Users/x/a.tsx).\n";
    const by = items({ ...pnpmLib, "src/everything/package.json": JSON.stringify({ name: "everything" }), "src/everything/server/index.ts": "x\n", ".claude/skills/structure/SKILL.md": skill });
    const paths = [...by.values()].filter((i) => i.kind === "path").map((i) => `${i.text}:${i.result}`);
    assert.deepEqual(paths, ["server/index.ts:pass", "docs/setup.md:fail"]);
  });

  test("a program a build makes first, and a Go command where Go isn't assessed, aren't findings", () => {
    const by = items({ ...pnpmLib, "go.mod": "module x\n", "main.go": "package main\n", "CONTRIBUTING.md": "# Contributing\n\nRun `go test ./...`, then `./app serve`, then `./scripts/missing.sh`.\n" });
    assert.equal(by.get("CONTRIBUTING.md:3 go test ./...")!.rule, "unassessed-stack");
    assert.equal(by.get("CONTRIBUTING.md:3 ./app serve")!.rule, "built-program");
    assert.equal(by.get("CONTRIBUTING.md:3 ./scripts/missing.sh")!.result, "fail");
  });

  test("a Make target whose recipe runs Go isn't replayed while Go isn't assessed", () => {
    const by = items({ ...pnpmLib, Makefile: "test:\n\tgo test ./... -v\n\nbuild:\n\tnpm run build\n", "CONTRIBUTING.md": "Run `make test` and `make build`.\n" });
    assert.equal(by.get("CONTRIBUTING.md:1 make test")!.rule, "unassessed-stack");
    assert.equal(by.get("CONTRIBUTING.md:1 make build")!.category, "replay");
  });

  test("an instruction that runs a check's own command takes that check's result instead of failing twice", async () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "fail" }] });
    audit.contract.find((k) => k.kind === "test")!.cwd = ".";
    audit.instructions = [{ id: "ins-001", source: "CONTRIBUTING.md", line: 27, kind: "command", text: "npm run test", category: "replay", staticResult: "pass", result: "not_run", reason: "waiting for replay", cwd: "." }];
    const ran: string[] = [];
    const ex: Executor = { where: "container", strength: "clean_replay", image: "node:22", imageSource: "audit", root: mkdtempSync(join(tmpdir(), "ex-")), exec: async (c) => (ran.push(c), { exitCode: 1, output: "", timedOut: false, durationMs: 1 }), offline: () => true, networkOff: true, close: () => {} };
    await replayInstructions(audit, ex, ex.root, newBudget(15, 1), [], null);
    assert.deepEqual(ran, []);
    assert.deepEqual([audit.instructions[0].result, audit.instructions[0].rule], ["not_run", "same-as-check"]);
  });

  test("an instruction that fails on the host is unproven on this machine, not wrong", async () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1 }] });
    audit.instructions = [{ id: "ins-001", source: "AGENTS.md", line: 48, kind: "command", text: "npm run check", category: "replay", staticResult: "pass", result: "not_run", reason: "waiting for replay", cwd: "." }];
    const ex: Executor = { where: "fresh_copy", strength: "executed", image: null, imageSource: null, root: mkdtempSync(join(tmpdir(), "ex-")), exec: async () => ({ exitCode: 1, output: "not ok 1 - a\n", timedOut: false, durationMs: 1 }), offline: () => false, networkOff: null, close: () => {} };
    await replayInstructions(audit, ex, ex.root, newBudget(15, 1), [], null);
    assert.equal(audit.instructions[0].result, "not_run");
    assert.match(audit.instructions[0].blocked!, /not in a clean container/);
  });

  test("a README command an agent file already gives is checked once, there", () => {
    const by = items({ ...pnpmLib, "AGENTS.md": "Run `pnpm test`.\n", "README.md": "## Development\n\nRun `pnpm test`.\n" });
    assert.equal(by.get("AGENTS.md:1 pnpm test")!.category, "replay");
    assert.equal(by.get("README.md:3 pnpm test")!.rule, "duplicate");
  });

  test("every rule an item names has text the report can print", () => {
    const by = items({ ...pnpmLib, "AGENTS.md": "Run `pnpm test`, `pnpm run nope`, `npx -y some-tool`, `pnpm add left-pad`.\n" });
    for (const i of by.values()) assert.ok(INSTRUCTION_RULES[i.rule!], `${i.text}: ${i.rule}`);
    assert.equal(by.get("AGENTS.md:1 npx -y some-tool")!.category, "needs_access");
  });
});

describe("diagnosis reads only the failing output", () => {
  const cases: [string, string, string, string][] = [
    ["a passing test's title names the network", "ok 1 - network, TLS and proxy errors are diagnosed\nnot ok 2 - adds\n  ---\n  error: 1 !== 2\n  ...\n", "test", "unknown"],
    ["ensurepip wrapped across lines", "because ensurepip is not\navailable. On Debian", "install", "missing_tool"],
    ["a Next font fetch", "There was an issue establishing a connection while requesting https://fonts.googleapis.com/css2?family=Inter", "build", "network"],
    ["curl can't resolve", "curl: (6) Could not resolve host: example.com", "install", "network"],
    ["corepack can't reach the registry", "Internal Error: Error when performing the request to https://repo.yarnpkg.com/4.1.0/yarn.js", "doctor", "network"],
    ["the Node the repo needs", 'error x@1.0.0: The engine "node" is incompatible with this module. Expected version ">=24". Got "22.1.0"', "install", "missing_tool"],
    ["git has no identity", "not ok 1 - tags\n  ---\n  error: Author identity unknown\n  ...\n", "test", "missing_tool"],
  ];
  for (const [name, out, phase, cause] of cases) test(name, () => assert.equal(diagnose(out, false, phase).cause, cause));
});

describe("safety findings that aren't committed secrets don't block", () => {
  test("documented example keys, key headers with no key, fixtures and scanner test data are listed, not blocking", () => {
    const awsExample = "AKIA" + "IOSFODNN7EXAMPLE";
    const dir = repo({
      ...pnpmLib,
      "scripts/perf.js": `const env = 'AWS_ACCESS_KEY_ID=${awsExample}';\n`,
      "forms/apple.go": "// Usually wrapped within -----BEGIN PRIVATE KEY----- X -----END PRIVATE KEY-----.\n",
      "ui/options.js": 'placeholder: "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----",\n',
      "test/fixtures/app/test/pay.test.js": "const key = process.env.PAYMENTS_LIVE_KEY;\n",
      "test/scan.test.ts": 'const files = { "a.test.js": "const k = process.env.PAYMENTS_LIVE_KEY;" };\n',
      "test/real.test.ts": "const k = process.env.PAYMENTS_LIVE_KEY;\n",
    });
    const found = safetyScan(dir, buildProfile(dir, dir, rubric));
    assert.deepEqual(found.filter((f) => f.blocking).map((f) => f.file), ["test/real.test.ts"]);
    assert.deepEqual(found.filter((f) => !f.blocking).map((f) => f.rule).sort(), ["credential-fixture", "secret-example", "secret-no-key", "secret-no-key"]);
  });
});

describe("waivers", () => {
  const write = (entries: unknown[]) => repo({ ...pnpmLib, [WAIVER_FILE]: JSON.stringify({ schema: WAIVER_SCHEMA, waivers: entries }) });
  const base = { check: "context.instructions_verified", match: "README.md:4", reason: "consumer install snippet for users", by: "Contributor A" };

  test("a waiver from the audited commit marks the finding, keeps what it was, and the report explains it", () => {
    const dir = write([{ id: "w1", ...base }, { id: "w2", ...base, match: "README.md:9" }, { id: "w3", ...base, check: "bootstrap.cold_replay" }, { id: "w4", ...base, expires: "2020-01-01" }]);
    const record = loadWaivers(dir, rubric, "2026-11-15")!;
    assert.deepEqual(record.rejected.map((r) => [r.id, r.reason]), [["w3", "Level 1 checks can't be waived"], ["w4", "it expired on 2020-01-01"]]);
    const audit = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }], instructions: [{ id: "ins-001", source: "README.md", line: 4, kind: "command", text: "yarn add ms", category: "replay", staticResult: "fail", result: "fail", reason: "uses yarn, but the repo uses npm" }] });
    audit.waivers = record;
    applyWaivers(audit);
    assert.deepEqual([audit.instructions[0].result, audit.instructions[0].waived?.was], ["not_run", "wrong: uses yarn, but the repo uses npm"]);
    const report = reportFor(audit);
    assert.deepEqual(report.waivers!.applied.map((a) => [a.id, a.findings]), [["w1", 1]]);
    assert.deepEqual(report.waivers!.unused.map((u) => u.id), ["w2"]);
    assert.match(report.executive.coverage, /Waivers: 1 finding is treated as a false positive by \.agent-readiness\/waivers\.json/);
    assert.match(renderMarkdown(report, rubric), /#### Waivers[\s\S]*w1 \| `context\.instructions_verified`/);
    assert.equal(report.explanations!.find((e) => e.subject === "README.md:4")!.result, "waived");
  });

  test("an uncommitted edit doesn't count, and a malformed file is ignored with its reason", () => {
    const dir = write([{ id: "w1", ...base }]);
    assert.match(loadWaivers(dir, rubric, "2026-11-15", "{}")!.ignored!, /working copy's .* differs from the audited commit/);
    const bad = repo({ ...pnpmLib, [WAIVER_FILE]: "{ not json" });
    assert.match(loadWaivers(bad, rubric, "2026-11-15")!.ignored!, /isn't valid JSON/);
    assert.equal(loadWaivers(repo(pnpmLib), rubric, "2026-11-15"), null);
  });
});

describe("the roadmap", () => {
  test("a watch on a stray lockfile keeps its path when outcomes weren't measured", () => {
    assert.equal(watchFor("prs_adding_path", "repo", null, rubric, "yarn.lock").metric, "prs_adding_path:yarn.lock");
  });

  test("a step stays open when a later audit leaves its condition unknown, and the repo install fix names only the failing component", () => {
    const failing = makeAudit({ components: [{ id: "app", share: 1, faults: "fail" }] });
    const ctx = (audit: Audit) => {
      const c = compute(audit, rubric, []);
      return { audit, rubric, components: audit.profile!.components, states: c.states, active: c.active, outcomes: null };
    };
    const first = updateRoadmap(null, ctx(failing)).roadmap;
    assert.ok(first.items.some((i) => i.id === "faults:app"));
    const unknown = makeAudit({ components: [{ id: "app", share: 1, faults: "not_run" }] });
    unknown.evidence = unknown.evidence.filter((e) => e.condition !== "faults");
    const second = updateRoadmap(first, ctx(unknown)).roadmap;
    assert.notEqual(second.items.find((i) => i.id === "faults:app")!.status, "done");
    const passing = updateRoadmap(first, ctx(makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] }))).roadmap;
    assert.equal(passing.items.find((i) => i.id === "faults:app")!.status, "done");
  });
});

describe("every result is explained by the report", () => {
  const audits: [string, Audit][] = [
    ["a healthy repo", makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] })],
    ["mixed results with findings", makeAudit({ components: [{ id: "api", share: 0.6, faults: "fail", lint: "fail" }, { id: "web", share: 0.3, test: "fail" }, { id: "infra", share: 0.1, assessed: false }], instructions: [{ id: "ins-001", source: "AGENTS.md", line: 2, kind: "command", text: "pnpm test", category: "replay", staticResult: "fail", result: "fail", reason: "uses pnpm, but the repo uses npm", rule: "package-manager" }, { id: "ins-002", source: "README.md", line: 9, kind: "path", text: "docs/a.md", category: "path", staticResult: "pass", result: "pass" }], safety: [{ id: "saf-001", kind: "secret", file: "src/a.ts", line: 3, detail: "AWS access key", blocking: true }, { id: "saf-002", kind: "lifecycle_hook", file: "package.json", detail: "scripts.postinstall runs on every install", blocking: false }] })],
    ["a blocked test", makeAudit({ components: [{ id: "app", share: 1, test: "not_run", where: "fresh_copy" }] })],
  ];
  for (const [name, audit] of audits) {
    test(name, () => {
      const report = reportFor(audit);
      assert.deepEqual(explanationGaps(report, audit), []);
      const md = renderMarkdown(report, rubric);
      assert.match(md, /### How each result was reached/);
      assert.doesNotMatch(md, /\bundefined\b/);
      assert.match(renderHtml(report), /How each result was reached/);
    });
  }

  test("the check catches a result with no reason", () => {
    const audit = audits[1][1];
    const report = reportFor(audit);
    report.explanations = report.explanations!.map((e) => (e.kind === "safety" ? { ...e, rule: "" } : e));
    assert.ok(explanationGaps(report, audit).some((g) => /src\/a\.ts:3 has no rule/.test(g)));
    report.explanations = report.explanations!.filter((e) => e.subject !== "api");
    assert.ok(explanationGaps(report, audit).includes("the report doesn't explain api's level"));
  });

  test("a repo mostly in an unassessed language says so in the heading", () => {
    const report = reportFor(makeAudit({ components: [{ id: "ui", share: 0.1, test: "missing" }, { id: "backend", share: 0.9, assessed: false }] }));
    assert.match(report.executive.heading, /covers only 10% of recent changes, and the rest isn't assessed/);
  });
});

describe("workspace globs", () => {
  test("** reaches nested packages and ! leaves some out", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "root", private: true }),
      "pnpm-lock.yaml": "",
      "pnpm-workspace.yaml": "packages:\n  - 'packages/**'\n  - '!packages/legacy/**'\n",
      "packages/a/package.json": JSON.stringify({ name: "a" }),
      "packages/group/b/package.json": JSON.stringify({ name: "b" }),
      "packages/legacy/old/package.json": JSON.stringify({ name: "old" }),
    });
    assert.deepEqual(discoverComponents(dir, listFiles(dir, { includeHidden: true })).map((c) => c.path).sort(), ["packages/a", "packages/group/b"]);
  });
});
