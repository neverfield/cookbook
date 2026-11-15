import { dirname, join, normalize } from "node:path";
import { diagnose } from "./diagnose.ts";
import { addEvidence } from "./evidence.ts";
import { redact, tail } from "./redact.ts";
import { charge, overBudget } from "./replay.ts";
import type { Budget, Executor } from "./replay.ts";
import { SUDO_SHIM_MARK } from "./run.ts";
import { CUT_OFF } from "./scope.ts";
import type { Audit } from "./types.ts";
import { exists, sha256 } from "./util.ts";
import { applyWaivers } from "./waivers.ts";

export const INSTRUCTION_TIMEOUT_SEC = 300;

// `npm test`, `npm run test` and `pnpm test` all run the test script; anything else compares as written.
function commandKey(cmd: string): string {
  const m = cmd.trim().match(/^(npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)\s*$/);
  return m && !["install", "i", "ci", "add"].includes(m[2]) ? `script:${m[2]}` : cmd.trim().replace(/\s+/g, " ");
}

function sameAsCheck(audit: Audit, text: string, cwd: string): { id: string; kind: string; result: string } | null {
  const key = commandKey(text);
  for (const k of audit.contract) {
    if (k.kind === "start" || k.kind === "doctor" || commandKey(k.declared ?? k.command) !== key || normalize(k.cwd) !== normalize(cwd)) continue;
    const ev = [...audit.evidence].reverse().find((e) => e.contractId === k.id && e.where !== "static");
    if (ev) return { id: ev.id, kind: k.kind === "typecheck" ? "type-check" : k.kind, result: ev.result };
  }
  return null;
}

// Documented commands run one by one in the replay copy, inside the audit's overall time budget:
// each gets what is left of it, and none starts once it is spent.
export async function replayInstructions(audit: Audit, ex: Executor, copyDir: string, budget: Budget, registryValues: string[], notInstalled: { blocked?: string } | null): Promise<void> {
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
    const cwd = exists(join(copyDir, wanted)) ? wanted : ".";
    // The same command a check already ran, such as `npm run test` next to the test check's
    // `npm test`: its result is that check's, counted once, there.
    const same = sameAsCheck(audit, item.text, cwd);
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
      continue;
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
      continue;
    }
    if (why?.cause === "permission") {
      item.result = "not_run";
      item.reason = `not replayed: ${why.detail} on this machine, an environment limit rather than a repo defect`;
      item.blocked = `${why.detail} on this machine`;
      continue;
    }
    if (why?.cause === "missing_tool" && (ex.where !== "container" || ex.imageSource !== "repo")) {
      const where = ex.where === "container" ? `in the audit's image (${ex.image})` : "on this machine";
      item.result = "not_run";
      item.reason = `not replayed: ${why.detail} ${where}, an environment limit rather than a repo defect`;
      item.blocked = `${why.detail} ${where}`;
      continue;
    }
    if (why && (why.cause === "credential" || why.cause === "network" || why.cause === "service" || why.cause === "registry")) {
      item.category = "needs_access";
      item.result = "not_run";
      item.reason = `not replayed: it ${why.cause === "network" ? "needs the network" : why.detail}, which the replay doesn't provide`;
      continue;
    }
    // A timeout the budget forced is the audit's limit, not a slow instruction.
    if (out.timedOut && overBudget(budget, "*")) {
      item.result = "not_run";
      item.reason = CUT_OFF;
      item.rule = "replay-budget";
      continue;
    }
    // A command that is still running at the limit, such as a full pre-push gate, isn't shown wrong.
    if (out.timedOut) {
      item.category = "long_running";
      item.result = "not_run";
      item.reason = `not replayed to the end: it was still running after ${limit} seconds, the limit for one instruction`;
      item.rule = "long-running";
      continue;
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
  applyWaivers(audit);
}
