import { join } from "node:path";
import { addContractCommand, commandKind } from "./contract.ts";
import type { CommandKind, ContractCommand, Profile } from "./types.ts";
import { exists, readText, sha256 } from "./util.ts";

// A maintainer names the right install, build, lint, type-check or test command for a component
// when the scan picked a wrong one. Read from the audited commit only, as the waivers are, so
// nothing written during an audit can change what it runs. A named command replaces every command
// the scan found of that kind for that component; the scan's own are dropped, not run.
export const CONFIG_FILE = ".agent-readiness/config.json";
export const CONFIG_SCHEMA = "agent-readiness/config@1";
const MAX_BYTES = 64 * 1024;
const KINDS: CommandKind[] = ["install", "build", "lint", "typecheck", "test"];

export interface ConfigCommand {
  component: string;
  kind: CommandKind;
  cmd: string;
  cwd: string;
  reason: string;
  by: string;
  line: number;
}

export interface CommandConfig {
  digest: string | null;
  entries: ConfigCommand[];
  rejected: { at: string; reason: string }[];
  ignored: string | null;
}

const none = (ignored: string, digest: string | null = null): CommandConfig => ({ digest, entries: [], rejected: [], ignored });

// workingCopy is the repo's own file, when it exists, so an uncommitted edit is named and ignored.
export function loadCommandConfig(tree: string, profile: Profile, workingCopy: string | null = null): CommandConfig | null {
  const path = join(tree, CONFIG_FILE);
  if (!exists(path)) return workingCopy !== null ? none(`${CONFIG_FILE} isn't in the audited commit, so it was ignored; commit it to use it`) : null;
  const text = readText(path);
  const digest = sha256(text);
  const changed = workingCopy !== null && workingCopy !== text ? `the working copy's ${CONFIG_FILE} differs from the audited commit, and only the committed one counts` : null;
  if (text.length > MAX_BYTES) return none(`${CONFIG_FILE} is over ${MAX_BYTES / 1024} KB, so it was ignored`, digest);
  let doc: { schema?: unknown; commands?: unknown };
  try {
    doc = JSON.parse(text);
  } catch {
    return none(`${CONFIG_FILE} isn't valid JSON, so it was ignored`, digest);
  }
  if (!doc || typeof doc !== "object" || doc.schema !== CONFIG_SCHEMA || !Array.isArray(doc.commands)) return none(`${CONFIG_FILE} needs "schema": "${CONFIG_SCHEMA}" and a "commands" list, so it was ignored`, digest);
  const lines = text.split("\n");
  const assessed = new Set(profile.components.filter((c) => c.assessed).map((c) => c.id));
  const out: CommandConfig = { digest, entries: [], rejected: [], ignored: changed };
  const seen = new Set<string>();
  (doc.commands as unknown[]).forEach((raw, i) => {
    const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const s = (k: string) => (typeof c[k] === "string" ? (c[k] as string).trim() : "");
    const at = `commands[${i}]`;
    const reject = (reason: string) => out.rejected.push({ at, reason });
    const unknown = Object.keys(c).filter((k) => !["component", "kind", "cmd", "cwd", "reason", "by"].includes(k));
    if (unknown.length) return reject(`unknown field ${unknown.join(", ")}`);
    const component = s("component");
    if (component !== "*" && !assessed.has(component)) return reject(`"component" must be "*" or a component the scan assessed, not ${JSON.stringify(component)}`);
    const kind = s("kind") as CommandKind;
    if (!KINDS.includes(kind)) return reject(`"kind" must be one of ${KINDS.join(", ")}`);
    if (!s("cmd")) return reject(`"cmd" must give the command`);
    if (s("reason").length < 10) return reject(`"reason" must say why the scan's command is wrong, in at least 10 characters`);
    if (!s("by")) return reject(`"by" must name the maintainer who reviewed it`);
    const key = `${component}\u0000${kind}\u0000${s("cmd")}`;
    if (seen.has(key)) return reject("another entry names the same command");
    seen.add(key);
    const quoted = JSON.stringify(s("cmd")).slice(1, -1);
    const line = lines.findIndex((l) => l.includes(quoted)) + 1 || 1;
    out.entries.push({ component, kind: commandKind(kind), cmd: s("cmd"), cwd: s("cwd") || (profile.components.find((p) => p.id === component)?.path ?? "."), reason: s("reason"), by: s("by"), line });
  });
  return out;
}

// Replaces the scan's commands with the maintainer's, by component and kind. Returns what it did,
// one line each, for the scan's log.
export function applyCommandConfig(contract: ContractCommand[], config: CommandConfig, profile: Profile): string[] {
  const log: string[] = [];
  const replaced = new Set<string>();
  for (const e of config.entries) {
    const key = `${e.component}\u0000${e.kind}`;
    if (!replaced.has(key)) {
      replaced.add(key);
      for (let i = contract.length - 1; i >= 0; i--) {
        const c = contract[i];
        if (c.component === e.component && c.kind === e.kind && !c.source.startsWith(CONFIG_FILE)) {
          log.push(`${CONFIG_FILE} replaces ${c.id} (\`${c.command}\`)`);
          contract.splice(i, 1);
        }
      }
    }
    try {
      const cmd = addContractCommand(contract, { kind: e.kind, component: e.component, cwd: e.cwd, command: e.cmd, source: `${CONFIG_FILE}:${e.line}`, reason: `${e.reason} (reviewed by ${e.by})` }, profile);
      log.push(`${CONFIG_FILE} adds ${cmd.id} (\`${cmd.command}\`), reviewed by ${e.by}`);
    } catch (err) {
      config.rejected.push({ at: `${CONFIG_FILE}:${e.line}`, reason: (err as Error).message });
    }
  }
  return log;
}

export function isConfigCommand(c: ContractCommand): boolean {
  return c.source.startsWith(`${CONFIG_FILE}:`);
}
