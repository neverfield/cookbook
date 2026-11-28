import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Whether a pull request needs the trials and the negative evals, from its diff against the base.
// Only a PR whose every changed file is on the docs allowlist skips them; any other path, a path
// outside the accelerator, an empty diff or any error means the full run. Nothing under skill/ is
// ever docs: the agent reads every file there at run time.
//
// CI runs the base's copy of this file, so a PR can't widen the list it is judged by, and this file
// is instrument (instrument-freeze.ts), so a scripts PR can't widen it for the next one either.
//
// node support/tools/ci-scope.ts --base <ref> [--head <ref>]   writes scope=docs-only|full to $GITHUB_OUTPUT

export type Scope = "docs-only" | "full";

const ACCELERATOR = "software-factory/agent-readiness/";

// Paths from the repo root.
export function isDocs(path: string): boolean {
  if (!path.startsWith(ACCELERATOR)) return false;
  const p = path.slice(ACCELERATOR.length);
  if (p === "README.md" || p === "CHANGELOG.md") return true;
  if (p.startsWith("docs/")) return true;
  return /^support\/[^/]+\.md$/.test(p);
}

export function scopeOf(changed: string[]): { scope: Scope; why: string } {
  if (!changed.length) return { scope: "full", why: "no changed files were found" };
  const other = changed.filter((p) => !isDocs(p));
  if (other.length) return { scope: "full", why: `${other.length} changed file(s) aren't docs, such as ${other.slice(0, 3).join(", ")}` };
  return { scope: "docs-only", why: `all ${changed.length} changed file(s) are docs: ${changed.slice(0, 8).join(", ")}${changed.length > 8 ? ", …" : ""}` };
}

function changedFiles(base: string, head: string): string[] {
  const r = spawnSync("git", ["diff", "--name-only", "--no-renames", `${base}...${head}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git diff ${base}...${head} failed: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
}

function main(argv: string[]): void {
  const arg = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  let result: { scope: Scope; why: string };
  try {
    const base = arg("base");
    if (!base) throw new Error("no --base");
    result = scopeOf(changedFiles(base, arg("head") ?? "HEAD"));
  } catch (e) {
    result = { scope: "full", why: `the scope couldn't be computed (${e instanceof Error ? e.message.split("\n")[0] : String(e)})` };
  }
  process.stdout.write(`${result.scope}: ${result.why}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scope=${result.scope}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
