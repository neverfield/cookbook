import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { computeOutcomes, fetchPrs } from "../skill/agent-readiness/scripts/lib/outcomes.ts";
import { isShallow, lastChanged, workspaceDirs } from "../skill/agent-readiness/scripts/lib/util.ts";
import { codeSeed, componentSeed, exportTree } from "../skill/agent-readiness/scripts/lib/workspace.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { makeAudit } from "./helpers.ts";
import { SKILL, commitAll, materialize, readiness } from "../support/tools/fixture.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "first-run-"));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repoWith(files: Record<string, string>): string {
  const dir = tmp();
  sh(dir, "init", "-q");
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  commitAll(dir, "init");
  return dir;
}

const head = (repo: string) => sh(repo, "rev-parse", "HEAD").trim();

function fakeGh(script: string): { restore: () => void } {
  const bin = tmp();
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\n${script}\nexit 1\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  return { restore: () => (process.env.PATH = old) };
}

const page = (nodes: unknown[], next: string | null = null, total = nodes.length) => ({ totalCount: total, pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes });
const gqlPr = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  headRefName: `cursor/pr-${n}`,
  createdAt: "2026-11-10T00:00:00Z",
  mergedAt: null,
  state: "OPEN",
  author: { __typename: "User", login: "dev" },
  labels: { nodes: [] },
  changesRequested: { totalCount: 0 },
  files: page([{ path: "api/a.js" }]),
  commits: page([{ commit: { oid: `sha${n}`, message: "x" } }]),
  ...extra,
});

describe("first run", { concurrency: 4 }, () => {
  test("the copied skill runs in a repo whose package.json says \"type\": \"commonjs\"", () => {
    const repo = materialize("healthy-node");
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ ...pkg, type: "commonjs" }, null, 2));
    commitAll(repo, "commonjs");
    const skill = join(repo, ".cursor", "skills", "agent-readiness");
    cpSync(SKILL, skill, { recursive: true });
    const r = readiness(repo, ["init", "--tier", "read-only"], {}, join(skill, "scripts", "readiness.ts"));
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /Cannot use import statement/);
  });

  test("a closed output pipe ends the CLI quietly instead of crashing on EPIPE", () => {
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["init", "--tier", "read-only"]).code, 0);
    assert.equal(readiness(repo, ["scan"]).code, 0);
    const cli = join(SKILL, "scripts", "readiness.ts");
    const r = spawnSync("bash", ["-o", "pipefail", "-c", `node --experimental-strip-types --no-warnings '${cli}' status --json | true`], { cwd: repo, encoding: "utf8" });
    assert.doesNotMatch(r.stderr, /EPIPE|Unhandled|at /);
    assert.equal(r.status, 0, r.stderr);
  });

  test("--help documents --force on audit and --allow-host", () => {
    const r = readiness(tmp(), ["help"]);
    assert.match(r.out, /audit --tier T .*--force/);
    assert.match(r.out, /--allow-host/);
  });
});

describe("audit tree", { concurrency: 4 }, () => {
  test("is a one-commit clone with .git, relative symlinks and export-ignored files, as CI checks it out", () => {
    const repo = repoWith({ "package.json": "{}", "tests/fixtures/pm/index.js": "x\n", ".gitattributes": "tests/** export-ignore\n" });
    symlinkSync("pm", join(repo, "tests/fixtures/pmlink"));
    commitAll(repo, "symlink");
    const dest = join(tmp(), "tree");
    const info = exportTree(repo, head(repo), dest);
    assert.equal(info.git, true);
    assert.equal(sh(dest, "rev-parse", "HEAD").trim(), head(repo));
    assert.equal(isShallow(dest), true);
    assert.equal(sh(dest, "status", "--porcelain"), "");
    assert.equal(readlinkSync(join(dest, "tests/fixtures/pmlink")), "pm");
    assert.ok(existsSync(join(dest, "tests/fixtures/pm/index.js")), "export-ignore doesn't drop files from the audit tree");
  });

  test("never runs the repo's hooks or the user's", () => {
    const repo = repoWith({ "a.txt": "a\n" });
    const marker = join(tmp(), "ran");
    const hooks = tmp();
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(hooks, "post-checkout"), 0o755);
    sh(repo, "config", "core.hooksPath", hooks);
    exportTree(repo, head(repo), join(tmp(), "tree"));
    assert.equal(existsSync(marker), false);
  });

  test("copies a submodule from the host's checkout and names one the host doesn't have", () => {
    const lib = repoWith({ "lib.js": "module.exports = 1;\n" });
    const repo = repoWith({ "package.json": "{}" });
    sh(repo, "submodule", "add", "-q", lib, "vendor/lib");
    sh(repo, "submodule", "add", "-q", lib, "vendor/other");
    commitAll(repo, "submodules");
    execFileSync("rm", ["-rf", join(repo, "vendor/other"), join(repo, ".git/modules/vendor/other")]);
    mkdirSync(join(repo, "vendor/other"));
    const dest = join(tmp(), "tree");
    const info = exportTree(repo, head(repo), dest);
    assert.equal(readFileSync(join(dest, "vendor/lib/lib.js"), "utf8"), "module.exports = 1;\n");
    assert.deepEqual(info.submodulesMissing, ["vendor/other"]);
  });

  test("init records a shallow clone and says what that does to change shares", () => {
    const src = materialize("healthy-node");
    writeFileSync(join(src, "NOTES.md"), "notes\n");
    commitAll(src, "second", 1);
    const repo = join(tmp(), "shallow");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${src}`, repo]);
    const r = readiness(repo, ["init", "--tier", "read-only"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /This clone is shallow/);
    const id = readFileSync(join(repo, ".agent-readiness/work/CURRENT"), "utf8").trim();
    assert.equal(JSON.parse(readFileSync(join(repo, ".agent-readiness/work", id, "audit.json"), "utf8")).repo.shallow, true);
  });
});

describe("git helpers", () => {
  test("lastChanged dates every file from one walk", () => {
    const repo = repoWith({ "a.js": "1\n", "b.js": "1\n" });
    writeFileSync(join(repo, "a.js"), "2\n");
    commitAll(repo, "touch a", 0);
    const dates = lastChanged(repo, ["a.js", "b.js", "missing.js"]);
    assert.deepEqual([...dates.keys()].sort(), ["a.js", "b.js"]);
    assert.ok(dates.get("a.js")! >= dates.get("b.js")!);
  });

  test("the code seed holds while the code does, and a component's seed moves only with its own files", () => {
    const repo = repoWith({ "api/a.js": "1\n", "web/b.js": "1\n" });
    const c1 = head(repo);
    assert.equal(codeSeed(repo, c1), codeSeed(repo, c1));
    assert.notEqual(codeSeed(repo, c1, "pin-a"), codeSeed(repo, c1, "pin-b"));
    writeFileSync(join(repo, "web/b.js"), "2\n");
    commitAll(repo, "web");
    const c2 = head(repo);
    const base = "seed";
    assert.equal(componentSeed(base, repo, c1, "api"), componentSeed(base, repo, c2, "api"));
    assert.notEqual(componentSeed(base, repo, c1, "web"), componentSeed(base, repo, c2, "web"));
  });

  test("the released rubric keeps a fresh seed for every audit", () => {
    assert.notEqual((loadRubric("2026-11-alpha").mutation as { seedFrom?: string }).seedFrom, "code");
  });
});

describe("workspace globs", () => {
  const tree = () => {
    const dir = tmp();
    for (const d of ["packages/a", "packages/b", "packages/nested/c", "packages/legacy", "apps/web", "apps/web/e2e", "tools/x", "node_modules/y"]) {
      mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, d, "package.json"), "{}");
    }
    mkdirSync(join(dir, "packages/empty"), { recursive: true });
    return dir;
  };
  const hasPkg = (dir: string) => (d: string) => existsSync(join(dir, d, "package.json"));

  test("* is one level, ** is any depth, and ! excludes wherever it sits in the list", () => {
    const dir = tree();
    assert.deepEqual(workspaceDirs(dir, ["packages/*"], hasPkg(dir)), ["packages/a", "packages/b", "packages/legacy"]);
    assert.deepEqual(workspaceDirs(dir, ["!packages/legacy", "packages/**"], hasPkg(dir)), ["packages/a", "packages/b", "packages/nested/c"]);
    assert.deepEqual(workspaceDirs(dir, ["**/web", "apps/web/**", "!**/e2e"], hasPkg(dir)), ["apps/web"]);
    assert.deepEqual(workspaceDirs(dir, ["{apps,tools}/*", "./packages/a/"], hasPkg(dir)), ["apps/web", "packages/a", "tools/x"]);
  });

  test("never reaches into node_modules", () => {
    const dir = tree();
    assert.ok(!workspaceDirs(dir, ["**"], hasPkg(dir)).some((d) => d.startsWith("node_modules")));
  });
});

describe("GitHub paging", () => {
  test("pages the PR search, a PR's files past 100 and every check-run page, without one huge query", async () => {
    const dir = tmp();
    const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify({ data: value }));
    write("search1.json", { search: { issueCount: 3, pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [gqlPr(1, { files: page([{ path: "api/a.js" }], "f1", 2) }), gqlPr(2, { author: { __typename: "Bot", login: "cursor" } })] } });
    write("search2.json", { search: { issueCount: 3, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [gqlPr(3, { files: page([{ path: "web/b.js" }], null, 5000) })] } });
    write("files.json", { repository: { pullRequest: { files: page([{ path: "web/c.js" }], null, 2) } } });
    const log = join(dir, "calls.log");
    const gh = fakeGh(`echo "$*" >> '${log}'
if [ "$2" = "graphql" ]; then
  case "$*" in
    *"files(first: 100, after"*) cat '${dir}/files.json'; exit 0;;
    *"after=c1"*) cat '${dir}/search2.json'; exit 0;;
    *) cat '${dir}/search1.json'; exit 0;;
  esac
fi
if [ "$2" = "--paginate" ]; then echo 'completed success'; exit 0; fi`);
    try {
      const { prs, truncated } = await fetchPrs("example-org/example", 30);
      assert.equal(truncated, false);
      assert.deepEqual(prs.map((p) => p.number), [1, 2, 3]);
      assert.deepEqual(prs[0].files, ["api/a.js", "web/c.js"]);
      assert.equal(prs[1].author, "app/cursor");
      assert.equal(prs[2].filesIncomplete, true);
      assert.ok(prs.every((p) => p.firstCheck === "success"));
      const calls = readFileSync(log, "utf8");
      assert.doesNotMatch(calls, /pr list/);
      assert.match(calls, /n=25/);
      const comps = makeAudit({ components: [{ id: "api", share: 0.5 }, { id: "web", share: 0.5 }] }).profile!.components.map((c) => ({ ...c, path: c.id }));
      const o = computeOutcomes(prs.map((p) => ({ ...p, createdAt: new Date().toISOString() })), comps, loadRubric("2026-11-alpha"), { branchPrefixes: ["cursor/"], labels: [], authors: [], coAuthorTrailers: [] }, 30, "gh");
      assert.equal(o.filesIncomplete, 1);
      assert.equal(o.byComponent.web.opened, 1);
    } finally {
      gh.restore();
    }
  });

  test("truncated when the search holds more PRs than were read", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "s.json"), JSON.stringify({ data: { search: { issueCount: 4000, pageInfo: { hasNextPage: true, endCursor: "c" }, nodes: [gqlPr(1), gqlPr(2)] } } }));
    const gh = fakeGh(`if [ "$2" = "graphql" ]; then cat '${dir}/s.json'; exit 0; fi
if [ "$2" = "--paginate" ]; then exit 0; fi`);
    try {
      const r = await fetchPrs("example-org/example", 30, 2);
      assert.equal(r.prs.length, 2);
      assert.equal(r.truncated, true);
      assert.equal(r.prs[0].firstCheck, null, "no check runs proves nothing");
    } finally {
      gh.restore();
    }
  });

  test("audit seals without outcomes when GitHub fails, so no draft is left open", () => {
    const repo = materialize("healthy-node");
    const bin = tmp();
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
if [ "$1" = "auth" ]; then exit 0; fi
echo "GraphQL: requesting up to 1,000,000 possible nodes which exceeds the maximum limit of 500,000." >&2
exit 1
`);
    chmodSync(join(bin, "gh"), 0o755);
    const r = readiness(repo, ["audit", "--tier", "external-systems", "--runtime", "none", "--no-mutants", "--no-instructions", "--repo-slug", "example-org/example"], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /outcomes weren't measured: .*500,000/);
    assert.equal(readFileSync(join(repo, ".agent-readiness/work/CURRENT"), "utf8").trim(), "");
    const report = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    assert.ok(report.audit);
  });
});
