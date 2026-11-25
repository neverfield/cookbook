import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Executor } from "./replay.ts";
import type { Rubric } from "./rubric.ts";

// Where a level is proved, and the audit's proof that the place works. Before any repo command
// runs, a canary checks the environment itself: the work tree is there and writable, commands run
// as the user they should, and git has an identity. A canary that fails blocks every condition
// with the reason, so a broken environment never reads as a broken repo.

export type ProofKind = "container" | "disposable_vm" | "host";
export type CanaryId = "mount_visible" | "mount_writable" | "run_user" | "network_cut" | "git_identity";

export interface CanaryCheck {
  id: CanaryId;
  ok: boolean;
  detail: string;
}

export interface Canary {
  ok: boolean;
  checks: CanaryCheck[];
}

export interface ProofEnv {
  kind: ProofKind;
  // The runtime and image, or the kind of VM.
  id: string;
  imageSource: "audit" | "repo" | "override" | null;
  // For a disposable VM: what showed this machine is one.
  detectedBy?: string[];
  // Whether the test phase ran with the network cut; null until it runs.
  network: "cut" | "on" | null;
  canary: Canary;
  // Whether a pass here proves Level 1 under the audit's rubric.
  proves: boolean;
}

export interface VmDetection {
  kind: "cursor_cloud_agent";
  label: string;
  signals: string[];
}

// Turns detection off, so a run on a cloud VM reads as host mode. It can only take proof away,
// never give it: the test suite and the eval grader's re-audits set it, so a graded result is the
// same on every machine.
export const VM_DETECT_ENV = "SA_READINESS_VM_DETECT";

// A disposable cloud VM is detected, never declared: a flag or a variable the agent could set
// would let any laptop prove Level 1. A Cursor Cloud Agent runs on a Linux VM made for the run,
// with the agent's daemon at /exec-daemon and the run's secrets listed in CLOUD_AGENT_* variables;
// a desktop agent has neither. The report names the signals it saw.
export function detectDisposableVm(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, exists: (p: string) => boolean = existsSync): VmDetection | null {
  if (env[VM_DETECT_ENV] === "off" || platform !== "linux") return null;
  const vars = ["CLOUD_AGENT_INJECTED_SECRET_NAMES", "CLOUD_AGENT_ALL_SECRET_NAMES"].filter((k) => env[k] !== undefined);
  if (!exists("/exec-daemon") || vars.length === 0) return null;
  return { kind: "cursor_cloud_agent", label: "a Cursor Cloud Agent VM", signals: ["/exec-daemon", ...vars] };
}

// Which environments prove Level 1 is the rubric's: rubrics before proof.environments prove only
// in a container.
export function provesIn(rubric: Rubric, kind: ProofKind): boolean {
  return (rubric.proof?.environments ?? ["container"]).includes(kind);
}

// What the audit sets itself rather than inheriting: a git identity, so tests that commit work,
// and the time zone. The locale stays as it was (the image's default in a container, this
// machine's on the host): the diagnosis reads tool output in the plain quotes the C locale prints.
export const GIT_IDENTITY = { name: "Agent Readiness", email: "readiness@audit.invalid" };
export function normalizedEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: GIT_IDENTITY.email,
    TZ: "UTC",
  };
}

const MARK = "readiness-canary";
export function canaryScript(): string {
  return [
    `if [ -n "$(ls -A . 2>/dev/null)" ]; then echo "${MARK} mount_visible ok"; else echo "${MARK} mount_visible fail the work tree is empty"; fi`,
    `f=".${MARK}-$$"; if ( : > "$f" ) 2>/dev/null; then rm -f "$f"; echo "${MARK} mount_writable ok"; else echo "${MARK} mount_writable fail the work tree is read-only"; fi`,
    `echo "${MARK} run_user $(id -u)"`,
    `if ! command -v git >/dev/null 2>&1; then echo "${MARK} git_identity ok git isn't installed"; elif git var GIT_AUTHOR_IDENT >/dev/null 2>&1; then echo "${MARK} git_identity ok"; else echo "${MARK} git_identity fail git has no identity"; fi`,
  ].join("\n");
}

export function parseCanary(output: string, expectUid: string | null): Canary {
  const lines = new Map<string, string>();
  for (const m of output.matchAll(new RegExp(`^${MARK} (\\w+) ?(.*)$`, "gm"))) lines.set(m[1], m[2].trim());
  const status = (id: CanaryId, missing: string): CanaryCheck => {
    const v = lines.get(id);
    if (v === undefined) return { id, ok: false, detail: missing };
    const [word, ...rest] = v.split(" ");
    return { id, ok: word === "ok", detail: rest.join(" ") || (word === "ok" ? "ok" : "failed") };
  };
  const uid = lines.get("run_user");
  const user: CanaryCheck =
    uid === undefined || !/^\d+$/.test(uid)
      ? { id: "run_user", ok: false, detail: "the run user couldn't be read" }
      : expectUid !== null && uid !== expectUid
        ? { id: "run_user", ok: false, detail: `commands ran as uid ${uid}, not ${expectUid}` }
        : { id: "run_user", ok: true, detail: `uid ${uid}` };
  const noAnswer = "the environment didn't answer";
  const checks = [status("mount_visible", noAnswer), status("mount_writable", noAnswer), user, status("git_identity", noAnswer)];
  return { ok: checks.every((c) => c.ok), checks };
}

export async function runCanary(ex: Executor, expectUid: string | null): Promise<Canary> {
  if (ex.unavailable) return { ok: true, checks: [] };
  const out = await ex.exec(canaryScript(), ".", 60);
  return parseCanary(out.output, expectUid);
}

export function canaryFailure(c: Canary): string {
  return `the audit's environment failed its self-check (${c.checks.filter((k) => !k.ok).map((k) => `${k.id.replace(/_/g, " ")}: ${k.detail}`).join("; ")}), so nothing it ran could count for or against the repo`;
}

// On a VM the test phase runs with the network cut, in a network namespace of its own with only
// loopback up, as the same user and with no capabilities: the namespace's capabilities raise
// loopback and are dropped before the command starts, so a test that expects a permission error
// still gets one. Where the kernel or the tools don't allow it, the tests run with the network on,
// and the report says so.
const LOOPBACK_UP = "import fcntl,socket,struct;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);f=struct.unpack('16sH',fcntl.ioctl(s,0x8913,struct.pack('16sH',b'lo',0)))[1];fcntl.ioctl(s,0x8914,struct.pack('16sH',b'lo',f|1))";
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export function offlineCommand(command: string): string {
  const inner = `python3 -c ${quote(LOOPBACK_UP)} && exec setpriv --inh-caps=-all --ambient-caps=-all -- bash -o pipefail -c "$0"`;
  return `exec unshare -n --map-current-user --keep-caps -- bash -c ${quote(inner)} ${quote(command)}`;
}

export function canCutNetwork(platform: string = process.platform): boolean {
  if (platform !== "linux") return false;
  const probe = `python3 -c ${quote("import socket;s=socket.socket();s.bind(('127.0.0.1',0));s.listen();socket.create_connection(s.getsockname())")} && ! python3 -c ${quote("import socket;socket.create_connection(('1.1.1.1',53),2)")} 2>/dev/null`;
  const r = spawnSync("bash", ["-c", offlineCommand(probe)], { encoding: "utf8", timeout: 20000 });
  return r.status === 0;
}
