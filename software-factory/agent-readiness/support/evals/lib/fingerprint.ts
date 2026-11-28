import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { historyLines, sealedAudits } from "./grade.ts";
import type { GateResult, Workspace } from "./types.ts";

// What a run of an arm with no agent left behind, as one digest: the latest report in every format,
// every gate's name, result and detail, and the run's error. Two runs of one case match only when
// these are byte-identical once each run's own identity is replaced: the ids of the audits and
// rechecks it recorded (and the random suffix gate details quote), the commits in its workspace
// (a fixture commit carries the time it was made), its workspace path, the harness's temp
// directories and how long each command took. Everything else, the audit date included, must
// match byte for byte.
export const REPORT_FILES = ["report.json", "report.md", "report.html"];

// The harness's own temp directories (mkdtemp under the OS temp dir: an attack's script, the
// grader's re-audit copy) are named afresh per run.
const TEMP_DIR = new RegExp(`${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([a-z][a-z-]*-)[A-Za-z0-9]{6}(?![A-Za-z0-9])`, "g");

function commits(dir: string): string[] {
  try {
    return execFileSync("git", ["-C", dir, "rev-list", "--all", "--topo-order", "--reverse"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function identities(ws: Workspace): [string, string][] {
  const out: [string, string][] = [];
  const ids = [...new Set([...historyLines(ws).map((h) => h.id), ...sealedAudits(ws).map((a) => a.id)].filter((x): x is string => typeof x === "string" && x.length > 0))];
  ids.forEach((id, i) => {
    out.push([id, `<record-${i + 1}>`]);
    const suffix = /-([0-9a-f]{4})$/.exec(id)?.[1];
    if (suffix) out.push([suffix, `<record-${i + 1}-suffix>`]);
  });
  // Reports print a commit as its first 7 characters.
  commits(ws.dir).forEach((c, i) => out.push([c, `<commit-${i + 1}>`], [c.slice(0, 7), `<commit-${i + 1}>`]));
  out.push([dirname(ws.dir), "<workspace-root>"]);
  // Longest first, so a short commit or suffix inside an id is never replaced before the id.
  return out.sort((a, b) => b[0].length - a[0].length);
}

// How long each command took: report.json's durationMs and the `, <fmtDuration()>` the renderers
// append to an evidence line. A time that changed what the audit did (a budget cut, a timeout)
// still shows in the rest of the report.
const DURATION_JSON = /"durationMs": \d+/g;
const DURATION_TEXT = /, (?:under 1 s|\d+ min \d+ s|\d+ s)(?![\w])/g;

export function normalize(text: string, ids: [string, string][]): string {
  let s = text;
  for (const [from, to] of ids) s = s.split(from).join(to);
  return s.replace(TEMP_DIR, "<tmp>/$1XXXXXX").replace(DURATION_JSON, '"durationMs": <ms>').replace(DURATION_TEXT, ", <duration>");
}

export function runFingerprint(ws: Workspace, gates: GateResult[], error: string | null): string {
  const ids = identities(ws);
  const h = createHash("sha256");
  for (const f of REPORT_FILES) {
    const p = join(ws.dir, ".agent-readiness/latest", f);
    h.update(`${f}\0${existsSync(p) ? normalize(readFileSync(p, "utf8"), ids) : "<absent>"}\0`);
  }
  for (const g of gates) h.update(`gate\0${g.name}\0${g.pass}\0${normalize(g.detail, ids)}\0`);
  h.update(`error\0${error === null ? "<none>" : normalize(error, ids)}\0`);
  return h.digest("hex");
}
