import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe } from "node:test";
import { afterAudit } from "../support/holdout/observe.ts";
import { guards } from "../support/tools/known-failures.ts";
import { ACCELERATOR, SKILL, materialize, readiness } from "../support/tools/fixture.ts";

// The README Quickstart, run verbatim in a fresh clone of a healthy repo, with only the clone URL
// pointed at this checkout. Afterwards the repo must be as usable as before: its own test command
// runs, its tree is as it was found, and nothing is left behind. The guard is installed whether or
// not the Quickstart installs it, since a user who opts in must get the same. The audit runs as on a
// machine with no container runtime, so the journey is the same on every CI job.
const guard = guards(import.meta.url);
const UPSTREAM = "https://github.com/cursor/cookbook";
const SKILL_REL = ".cursor/skills/agent-readiness";

function quickstartBlocks(): string[] {
  const readme = readFileSync(join(ACCELERATOR, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Quickstart"), readme.indexOf("\n## ", readme.indexOf("## Quickstart") + 3));
  return [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

function sourceCheckout(): string {
  const src = join(mkdtempSync(join(tmpdir(), "journey-src-")), "cookbook");
  mkdirSync(join(src, "software-factory", "agent-readiness"), { recursive: true });
  cpSync(SKILL, join(src, "software-factory", "agent-readiness", "skill", "agent-readiness"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: src });
  execFileSync("git", ["add", "-A"], { cwd: src });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Contributor A", "-c", "user.email=a@example.com", "commit", "-q", "-m", "skill"], { cwd: src });
  return src;
}

function freshClone(): string {
  const origin = materialize("healthy-node");
  const clone = join(mkdtempSync(join(tmpdir(), "journey-")), "healthy-node");
  execFileSync("git", ["clone", "-q", origin, clone]);
  return clone;
}

function bash(script: string, cwd: string, env: Record<string, string>): { code: number; out: string } {
  const r = spawnSync("bash", ["-euo", "pipefail", "-c", script], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

// Asks the hooks .cursor/hooks.json installs whether an agent may run `command` in the repo.
function hookAllows(repo: string, command: string): { allowed: boolean; why: string } {
  const file = join(repo, ".cursor", "hooks.json");
  if (!existsSync(file)) return { allowed: true, why: "no hook installed" };
  const hooks = (JSON.parse(readFileSync(file, "utf8")).hooks?.beforeShellExecution ?? []) as { command: string }[];
  for (const h of hooks) {
    const r = spawnSync("bash", ["-c", h.command], { cwd: repo, input: JSON.stringify({ command, cwd: repo, workspace_roots: [repo] }), encoding: "utf8" });
    const d = JSON.parse(r.stdout || "{}") as { permission?: string; agent_message?: string };
    if (d.permission === "deny") return { allowed: false, why: d.agent_message ?? "denied" };
  }
  return { allowed: true, why: "allowed" };
}

describe("the Quickstart journey", () => {
  let repo: string;
  let tmp: string;
  let steps: { code: number; out: string }[] = [];
  let beforeAudit: { allowed: boolean; why: string };
  const env = () => ({ SA_READINESS_RUNTIME: "none", SA_READINESS_EVAL_SEED: "journey-seed", TMPDIR: tmp });

  before(() => {
    const src = sourceCheckout();
    repo = freshClone();
    tmp = mkdtempSync(join(tmpdir(), "journey-tmp-"));
    const scratch = mkdtempSync(join(tmpdir(), "journey-copy-"));
    const blocks = quickstartBlocks().map((b) => b.replaceAll(UPSTREAM, `file://${src}`).replaceAll("/tmp/cookbook", join(scratch, "cookbook")));
    const pick = (re: RegExp) => blocks.find((b) => re.test(b)) ?? "false";
    const [check, install, audit] = [pick(/process\.versions\.node/), pick(/git clone/), pick(/readiness\.ts audit /)];
    steps = [bash(check, repo, env()), bash(install, repo, env())];
    if (!existsSync(join(repo, ".cursor", "hooks.json"))) steps.push(readiness(repo, ["guard", "install"], env(), join(repo, SKILL_REL, "scripts", "readiness.ts")));
    beforeAudit = hookAllows(repo, "npm test");
    steps.push(bash(audit, repo, env()));
  });

  guard("the Quickstart runs in a fresh clone and seals a report", () => {
    for (const re of [/process\.versions\.node/, /git clone/, /readiness\.ts audit /]) assert.ok(quickstartBlocks().some((b) => re.test(b)), `no Quickstart step matches ${re}`);
    for (const s of steps) assert.equal(s.code, 0, s.out.slice(-2000));
    assert.ok(existsSync(join(repo, ".agent-readiness", "latest", "report.json")), "no sealed report");
  });

  guard("before any audit, the repo's own test command runs", () => {
    assert.ok(beforeAudit.allowed, `refused before any audit: ${beforeAudit.why}`);
  });

  guard("after the seal, the repo's own test command runs", () => {
    const after = hookAllows(repo, "npm test");
    assert.ok(after.allowed, `refused after the seal: ${after.why}`);
  });

  guard("after the audit, the tree is as it was found, apart from the copied skill and .agent-readiness/", () => {
    assert.equal(afterAudit(repo, { ignore: [`${SKILL_REL}/`] }).treeChanged, false, spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout);
  });

  guard("after the audit, no temp tree or container is left behind", () => {
    const id = JSON.parse(readFileSync(join(repo, ".agent-readiness", "latest", "report.json"), "utf8")).audit.id as string;
    assert.equal(afterAudit(repo, { tmp, containers: `readiness-${id}` }).leftovers, false, readdirSync(tmp).join(", "));
  });

  guard("guard uninstall puts .cursor/hooks.json and the exclude file back as they were", () => {
    const fresh = freshClone();
    cpSync(join(repo, SKILL_REL), join(fresh, SKILL_REL), { recursive: true });
    const own = { version: 1, hooks: { afterFileEdit: [{ command: "echo edited" }] } };
    mkdirSync(join(fresh, ".cursor"), { recursive: true });
    writeFileSync(join(fresh, ".cursor", "hooks.json"), JSON.stringify(own, null, 2) + "\n");
    const excludeBefore = readFileSync(join(fresh, ".git", "info", "exclude"), "utf8");
    const cli = join(fresh, SKILL_REL, "scripts", "readiness.ts");
    assert.equal(readiness(fresh, ["guard", "install"], env(), cli).code, 0);
    const r = readiness(fresh, ["guard", "uninstall"], env(), cli);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(readFileSync(join(fresh, ".cursor", "hooks.json"), "utf8")), own, "the user's own hooks.json isn't back as it was");
    assert.equal(readFileSync(join(fresh, ".git", "info", "exclude"), "utf8"), excludeBefore, "the exclude file isn't back as it was");
  });

  guard("guard install works in a git worktree", () => {
    const wt = join(mkdtempSync(join(tmpdir(), "journey-wt-")), "wt");
    execFileSync("git", ["worktree", "add", "-q", "--detach", wt], { cwd: repo });
    cpSync(join(repo, SKILL_REL), join(wt, SKILL_REL), { recursive: true });
    const r = readiness(wt, ["guard", "install"], env(), join(wt, SKILL_REL, "scripts", "readiness.ts"));
    assert.equal(r.code, 0, r.out);
    const exclude = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: wt, encoding: "utf8" }).trim();
    assert.ok(readFileSync(join(wt, exclude), "utf8").includes("/.cursor/hooks.json"), "the hook isn't kept out of git");
  });

  guard("init --force leaves no abandoned draft or temp tree behind", () => {
    const fresh = freshClone();
    const own = mkdtempSync(join(tmpdir(), "journey-force-"));
    const e = { ...env(), TMPDIR: own };
    for (const step of [["init", "--tier", "local-exec"], ["scan"], ["init", "--tier", "local-exec", "--force"], ["scan"], ["replay"], ["seal"]]) {
      const r = readiness(fresh, step, e);
      assert.equal(r.code, 0, `${step.join(" ")}: ${r.out.slice(-1500)}`);
    }
    const work = join(fresh, ".agent-readiness", "work");
    const drafts = existsSync(work) ? readdirSync(work).filter((n) => n.startsWith("aud-")) : [];
    assert.deepEqual(drafts, [], "a draft's work folder outlived the seal");
    assert.deepEqual(readdirSync(own).filter((n) => n.startsWith("readiness")), [], "a temp tree outlived the seal");
  });
});
