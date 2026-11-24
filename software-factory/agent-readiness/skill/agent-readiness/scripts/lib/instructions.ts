import { dirname, join, normalize } from "node:path";
import { BUNDLE_GAP, diagnose } from "./diagnose.ts";
import { addEvidence } from "./evidence.ts";
import { redact, tail } from "./redact.ts";
import { charge, overBudget } from "./replay.ts";
import type { Budget, Executor } from "./replay.ts";
import { SUDO_SHIM_MARK } from "./run.ts";
import { makeRecipe } from "./static.ts";
import { CUT_OFF } from "./scope.ts";
import type { Audit, InstructionItem } from "./types.ts";
import { existsExact, sha256 } from "./util.ts";
import { applyWaivers } from "./waivers.ts";

export const INSTRUCTION_TIMEOUT_SEC = 300;

// Flags of the test runners below that take the next word as their value.
const VALUE_FLAGS = new Set(["-run", "-skip", "-timeout", "-tags", "-p", "-parallel", "-count", "-coverprofile", "-covermode", "-coverpkg", "-bench", "-benchtime", "-exec", "--package", "-p", "--features", "--target", "--manifest-path", "-k", "-m", "--project", "--configuration", "-c", "--filter", "--framework", "--format", "-f", "--require", "-r", "--tag", "-t", "--seed"]);

// What a test run selects, without its flags: the tool and the packages or paths it names.
// `go test ./...` and `go test -count=1 -v ./...` are one run; so are `pytest` and
// `uv run pytest -q`, `./gradlew test` and `gradle test --no-daemon`.
function testRunKey(cmd: string): string | null {
  const words = cmd.trim().split(/\s+/).filter((w) => !/^[A-Za-z_]\w*=/.test(w));
  while (words.length > 1 && /^(uv|poetry|pipenv|hatch|pdm) run$|^bundle exec$/.test(`${words[0]} ${words[1]}`)) words.splice(0, 2);
  const tool = words[0]?.replace(/^\.\//, "").replace(/^.*\/(python3?|pytest|phpunit|rspec)$/, "$1");
  const positional = (from: number) => {
    const out: string[] = [];
    for (let i = from; i < words.length; i++) {
      const w = words[i];
      if (w === "--") break;
      if (w.startsWith("-")) {
        if (VALUE_FLAGS.has(w)) i++;
        continue;
      }
      out.push(w);
    }
    return out.sort().join(" ");
  };
  if (tool === "go" && words[1] === "test") return `go-test:${positional(2) || "."}`;
  if (tool === "cargo" && words[1] === "test") {
    // Which packages run is part of what the run selects.
    const picked = words.flatMap((w, i) => (w === "-p" || w === "--package" ? [`p=${words[i + 1]}`] : w.startsWith("--package=") ? [`p=${w.slice(10)}`] : w === "--workspace" || w === "--all" ? ["workspace"] : [])).sort().join(" ");
    return `cargo-test:${picked}|${positional(2)}`;
  }
  if (tool === "pytest") return `pytest:${positional(1)}`;
  if (/^python3?$/.test(tool ?? "") && words[1] === "-m" && words[2] === "pytest") return `pytest:${positional(3)}`;
  if (/^(mvn|mvnw)$/.test(tool ?? "")) return `maven:${positional(1)}`;
  if (/^(gradle|gradlew)$/.test(tool ?? "")) return `gradle:${positional(1)}`;
  if (tool === "dotnet" && words[1] === "test") return `dotnet-test:${positional(2)}`;
  if (tool === "phpunit") return `phpunit:${positional(1)}`;
  if (tool === "rspec") return `rspec:${positional(1)}`;
  if (tool === "rake" && words[1] === "test") return "rake:test";
  // `composer test`, `composer run test` and `composer run-script --timeout=0 test` run one script.
  if (tool === "composer") {
    const rest = words.slice(1).filter((w) => !w.startsWith("-"));
    const script = rest[0] === "run" || rest[0] === "run-script" ? rest[1] : rest[0];
    if (script && !["install", "update", "require", "remove", "dump-autoload", "validate", "create-project"].includes(script)) return `composer-script:${script}`;
  }
  return null;
}

// `npm test`, `npm run test` and `pnpm test` all run the test script; a test runner's command is
// keyed by what it selects; anything else compares as written.
function commandKey(cmd: string): string {
  const m = cmd.trim().match(/^(npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)\s*$/);
  if (m && !["install", "i", "ci", "add"].includes(m[2])) return `script:${m[2]}`;
  return testRunKey(cmd) ?? cmd.trim().replace(/\s+/g, " ");
}

// The key a documented command is compared with the contract's by, following a one-line Make target.
export function instructionKey(text: string, tree: string, cwd: string): string {
  return commandKey(throughMake(text, tree, cwd));
}

// `make test` whose recipe is one command is that command, so its result is the check's too.
function throughMake(text: string, tree: string, cwd: string): string {
  const target = text.trim().match(/^make\s+([\w.-]+)\s*$/)?.[1];
  if (!target) return text;
  const lines = makeRecipe(tree, cwd, target).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return lines.length === 1 ? lines[0] : text;
}

function sameAsCheck(audit: Audit, text: string, cwd: string, tree: string): { id: string; kind: string; result: string } | null {
  const key = instructionKey(text, tree, cwd);
  for (const k of audit.contract) {
    if (k.kind === "start" || k.kind === "doctor" || commandKey(k.declared ?? k.command) !== key || normalize(k.cwd) !== normalize(cwd)) continue;
    const ev = [...audit.evidence].reverse().find((e) => e.contractId === k.id && e.where !== "static");
    if (ev) return { id: ev.id, kind: k.kind === "typecheck" ? "type-check" : k.kind, result: ev.result };
  }
  return null;
}

// Documented commands run one by one in the replay copy, inside the audit's overall time budget:
// each gets what is left of it, and none starts once it is spent.
// What a tool prints when the folder it runs in has no manifest, and which manifest that is.
const NO_MANIFEST: [RegExp, string][] = [
  [/No `pyproject\.toml` found in current directory or any parent directory/, "pyproject.toml"],
  [/could not find `Cargo\.toml` in/, "Cargo.toml"],
  [/go\.mod file not found in current directory or any parent directory/, "go.mod"],
  [/Composer could not find a composer\.json file/, "composer.json"],
  [/Could not locate Gemfile/, "Gemfile"],
  [/there is no POM in this directory/, "pom.xml"],
  [/npm (?:error|ERR!) (?:code ENOENT|enoent)[\s\S]{0,400}?package\.json/, "package.json"],
];

// The packages a command that needs a manifest the working folder lacks could have meant.
export function packageCommand(output: string, audit: Audit, tree: string, cwd: string): { manifest: string; paths: string[] } | null {
  const manifest = NO_MANIFEST.find(([re]) => re.test(output))?.[1];
  if (!manifest || existsExact(tree, join(cwd, manifest))) return null;
  const paths = (audit.profile?.components ?? []).filter((c) => c.path !== cwd && c.manifest !== null && c.manifest.split("/").pop() === manifest).map((c) => c.path).sort();
  return paths.length ? { manifest, paths } : null;
}

// `executors`: one executor for every command, or a choice per command, so a command runs in the image
// of the component it targets.
export async function replayInstructions(audit: Audit, executors: Executor | ((cwd: string, command: string) => Executor), copyDir: string, budget: Budget, registryValues: string[], notInstalled: { blocked?: string } | null): Promise<void> {
  const ran = new Map<string, InstructionItem>();
  for (const item of audit.instructions.filter((i) => i.category === "replay" && i.staticResult === "pass")) {
    if (notInstalled) {
      item.result = "not_run";
      item.reason = notInstalled.blocked ? "not replayed because the install was blocked on this machine" : "not replayed because the install failed";
      item.blocked = notInstalled.blocked;
      item.rule = "replay-install";
      continue;
    }
    const leftSec = Math.floor((budget.totalMs - (Date.now() - budget.startedAt)) / 1000);
    if (overBudget(budget, "*") || leftSec < 1) {
      item.result = "not_run";
      item.reason = CUT_OFF;
      item.rule = "replay-budget";
      continue;
    }
    const wanted = item.cwd ?? (dirname(item.source) === "" ? "." : dirname(item.source));
    const cwd = existsExact(copyDir, wanted) ? wanted : ".";
    const ex = typeof executors === "function" ? executors(cwd, item.text) : executors;
    // The same command in the same folder and image runs once in this phase: a second document that
    // gives it shares the first one's result and evidence.
    const key = `${ex.image ?? ex.where}\u0000${cwd}\u0000${item.text}`;
    const earlier = ran.get(key);
    if (earlier) {
      Object.assign(item, { cwd, result: earlier.result, reason: earlier.reason, rule: earlier.rule, evidenceId: earlier.evidenceId, blocked: earlier.blocked, category: earlier.category });
      continue;
    }
    await replayOne(audit, item, ex, cwd, copyDir, budget, registryValues, leftSec);
    ran.set(key, item);
  }
  applyWaivers(audit);
}

// One documented command, run in the replay copy and judged; its result goes on the item.
async function replayOne(audit: Audit, item: InstructionItem, ex: Executor, cwd: string, copyDir: string, budget: Budget, registryValues: string[], leftSec: number): Promise<void> {
  // The same command a check already ran, such as `npm run test` next to the test check's
  // `npm test`: its result is that check's, counted once, there.
  const same = sameAsCheck(audit, item.text, cwd, copyDir);
  if (same) {
    item.cwd = cwd;
    if (same.result === "pass") {
      item.result = "pass";
      item.reason = `it runs the same command as the ${same.kind} check, which passed`;
      item.rule = "same-as-check";
      item.evidenceId = same.id;
    } else {
      item.category = "skipped";
      item.result = "not_run";
      item.reason = `not replayed again: it runs the same command as the ${same.kind} check, which ${same.result === "fail" ? "failed" : "didn't run"}; that result counts under the ${same.kind} check`;
      item.rule = "same-as-check";
    }
    return;
  }
  const limit = Math.min(INSTRUCTION_TIMEOUT_SEC, leftSec);
  const out = await ex.exec(item.text, cwd, limit);
  charge(budget, "*", out.durationMs);
  const ok = out.exitCode === 0 && !out.timedOut;
  const redacted = redact(out.output, registryValues);
  const why = ok ? null : diagnose(out.output, out.timedOut, "instruction");
  item.cwd = cwd;
  item.rule = "replay-environment";
  if (!ok && ex.where !== "container" && out.output.includes(SUDO_SHIM_MARK)) {
    item.result = "not_run";
    item.reason = "not replayed: it uses sudo, which the audit never runs on the host";
    item.blocked = "it uses sudo, which the audit never runs on the host";
    return;
  }
  // A per-package command written without its folder, such as "run `uv lock` in that server", fails
  // at the root for want of the package's manifest. It belongs to one of the packages that have one,
  // and the line doesn't say which, so it can't be replayed as written.
  const packages = ok ? null : packageCommand(out.output, audit, copyDir, cwd);
  if (packages) {
    item.category = "skipped";
    item.result = "not_run";
    item.reason = `not replayed: it runs in one of the packages that have a ${packages.manifest} (${packages.paths.join(", ")}), and the line doesn't say which`;
    item.rule = "per-package";
    return;
  }
  if (why?.cause === "missing_ref") {
    item.result = "not_run";
    item.reason = `not replayed to the end: ${why.detail}, an environment limit rather than a repo defect`;
    item.blocked = why.detail;
    return;
  }
  if (why?.cause === "interactive") {
    item.category = "skipped";
    item.result = "not_run";
    item.reason = `not replayed: ${why.detail}`;
    item.rule = "interactive";
    return;
  }
  if (why?.cause === "permission") {
    item.result = "not_run";
    item.reason = `not replayed: ${why.detail} on this machine, an environment limit rather than a repo defect`;
    item.blocked = `${why.detail} on this machine`;
    return;
  }
  if (why?.cause === "missing_tool" && (ex.where !== "container" || ex.imageSource !== "repo")) {
    const where = why.detail.endsWith(BUNDLE_GAP) ? "here" : ex.where === "container" ? `in the audit's image (${ex.image})` : "on this machine";
    item.result = "not_run";
    item.reason = `not replayed: ${why.detail} ${where}, an environment limit rather than a repo defect`;
    item.blocked = `${why.detail} ${where}`;
    return;
  }
  if (why && (why.cause === "credential" || why.cause === "network" || why.cause === "service" || why.cause === "registry")) {
    item.category = "needs_access";
    item.result = "not_run";
    item.reason = `not replayed: it ${why.cause === "network" ? "needs the network" : why.detail}, which the replay doesn't provide`;
    return;
  }
  // A timeout the budget forced is the audit's limit, not a slow instruction.
  if (out.timedOut && overBudget(budget, "*")) {
    item.result = "not_run";
    item.reason = CUT_OFF;
    item.rule = "replay-budget";
    return;
  }
  // On the host the copy isn't a clean environment: a failure there can come from this machine,
  // so it leaves the instruction unproven rather than wrong.
  if (!ok && ex.where !== "container") {
    item.result = "not_run";
    item.reason = `not proven: it failed in a fresh copy on this machine (${why!.detail}), and only a clean container can show an instruction is wrong`;
    item.blocked = "it ran on this machine, not in a clean container";
    return;
  }
  // A command that is still running at the limit, such as a full pre-push gate, isn't shown wrong.
  if (out.timedOut) {
    item.category = "long_running";
    item.result = "not_run";
    item.reason = `not replayed to the end: it was still running after ${limit} seconds, the limit for one instruction`;
    item.rule = "long-running";
    return;
  }
  const ev = addEvidence(audit, {
    checkId: "context.instructions_verified",
    condition: "instructions",
    strength: ex.strength,
    where: ex.where,
    result: ok ? "pass" : "fail",
    command: item.text,
    cwd,
    image: ex.image ?? undefined,
    exitCode: out.exitCode,
    timedOut: out.timedOut,
    durationMs: out.durationMs,
    outputTail: tail(redacted, 1500),
    outputDigest: sha256(redacted),
    summary: `${item.source}:${item.line} \`${item.text}\` ${ok ? "replays" : "fails: " + why!.detail}`,
  });
  item.result = ok ? "pass" : "fail";
  item.reason = ok ? undefined : why!.detail;
  item.rule = "replay";
  item.evidenceId = ev.id;
}

