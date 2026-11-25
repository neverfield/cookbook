import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute } from "node:path";
import { IDLE_MARK, IDLE_OFFLINE, OOM_MARK } from "./diagnose.ts";
import { pinnedRef } from "./images.ts";
import { normalizedEnv } from "./proofenv.ts";
import { runCommand } from "./run.ts";
import type { RunOutcome } from "./run.ts";
import { onTeardown, ownerGone } from "./teardown.ts";
import { fail, randomHex, shellQuote } from "./util.ts";

export interface Runtime {
  bin: string;
}

// Only these runtimes: any other program given as --runtime would have its exit codes recorded as
// clean-container results. Podman isn't offered until a fixture run tests it, so auto never picks it
// and asking for it is refused rather than recorded as clean-container proof.
export const RUNTIMES = ["auto", "docker", "none"];
export const PODMAN_REFUSED = "Podman isn't supported yet: no fixture run has tested it, so its results can't count as clean-container proof. Use Docker (--runtime docker or auto), or --runtime none.";

export function detectRuntime(preference: string = "auto"): Runtime | null {
  if (preference === "podman") fail(PODMAN_REFUSED);
  if (!RUNTIMES.includes(preference)) fail(`--runtime takes ${RUNTIMES.join(", ")}; got ${preference}.`);
  if (preference === "none") return null;
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 20000 });
  return r.status === 0 ? { bin: "docker" } : null;
}

// Labels on every container an audit starts: the process that started it and the machine it ran on,
// so the next init or replay can remove one whose process was killed before it could.
export const OWNER_PID_LABEL = "sa.readiness.pid";
export const OWNER_HOST_LABEL = "sa.readiness.host";

// Containers whose starting process is gone, whatever their age: an audit stopped by a signal it
// couldn't catch. A container another audit is still using keeps running.
export function removeOrphanedContainers(): string[] {
  const runtime = detectRuntime("auto");
  if (!runtime) return [];
  const ps = spawnSync(runtime.bin, ["ps", "-a", "--filter", `label=${OWNER_PID_LABEL}`, "--format", `{{.Names}}\t{{.Label "${OWNER_PID_LABEL}"}}\t{{.Label "${OWNER_HOST_LABEL}"}}`], { encoding: "utf8", timeout: 30000 });
  if (ps.status !== 0) return [];
  const removed: string[] = [];
  for (const line of ps.stdout.split("\n").filter(Boolean)) {
    const [name, pid, host] = line.split("\t");
    if (!name?.startsWith("readiness-") || !ownerGone(Number(pid), host ?? "")) continue;
    if (spawnSync(runtime.bin, ["rm", "-f", name], { encoding: "utf8", timeout: 60000 }).status === 0) removed.push(`container ${name}`);
  }
  return removed;
}

// Containers an audit left behind: named for an audit, other than `keep`'s, and older than
// `olderThanMs`, so another repo's audit running on this machine now keeps its own. Removed, and
// their names returned.
export function removeLeftoverContainers(olderThanMs: number, keep: string | null, now = Date.now()): string[] {
  const runtime = detectRuntime("auto");
  if (!runtime) return [];
  const ps = spawnSync(runtime.bin, ["ps", "-a", "--filter", "name=readiness-aud-", "--format", "{{.Names}}"], { encoding: "utf8", timeout: 30000 });
  const names = ps.status === 0 ? ps.stdout.split("\n").map((n) => n.trim()).filter((n) => n.startsWith("readiness-aud-") && !(keep && n.startsWith(`readiness-${keep}-`))) : [];
  const removed: string[] = [];
  for (const name of names) {
    const created = Date.parse(spawnSync(runtime.bin, ["inspect", "-f", "{{.Created}}", name], { encoding: "utf8", timeout: 30000 }).stdout.trim());
    if (!(now - created > olderThanMs)) continue;
    if (spawnSync(runtime.bin, ["rm", "-f", name], { encoding: "utf8", timeout: 60000 }).status === 0) removed.push(`container ${name}`);
  }
  return removed;
}

// The images built from a repo's declared environment, which only speed up the next audit.
export function removeEnvImages(): string[] {
  const runtime = detectRuntime("auto");
  if (!runtime) return [];
  const ls = spawnSync(runtime.bin, ["images", "--format", "{{.Repository}}:{{.Tag}}", "--filter", "reference=readiness-env-*"], { encoding: "utf8", timeout: 30000 });
  const refs = ls.status === 0 ? ls.stdout.split("\n").map((n) => n.trim()).filter((n) => n.startsWith("readiness-env-")) : [];
  return refs.filter((ref) => spawnSync(runtime.bin, ["rmi", ref], { encoding: "utf8", timeout: 60000 }).status === 0).map((ref) => `image ${ref}`);
}

export function buildImage(runtime: Runtime, contextDir: string, dockerfile: string, tag: string): { ok: boolean; output: string } {
  const r = spawnSync(runtime.bin, ["build", "-q", "-t", tag, "-f", dockerfile, contextDir], { encoding: "utf8", timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

export interface Limits {
  cpus: number | null;
  memoryMb: number;
  pids: number;
}

const GIB = 1024 * 1024 * 1024;

// What a replay may use: three quarters of the machine the runtime reports (Docker Desktop's VM on a
// Mac, not the Mac), between 2 and 16 GiB of memory with no swap on top, and 4096 processes. A CPU
// limit is set only when the runtime says how many it has, since asking for more fails the start.
export function limitsFor(ncpu: number | null, memBytes: number | null): Limits {
  const cpus = ncpu && ncpu > 0 ? Math.max(1, Math.min(ncpu, Math.floor(ncpu * 0.75) || 1)) : null;
  const mem = memBytes && memBytes > 0 ? Math.floor(memBytes * 0.75) : 8 * GIB;
  return { cpus, memoryMb: Math.round(Math.min(16 * GIB, Math.max(2 * GIB, mem)) / (1024 * 1024)), pids: 4096 };
}

// `readiness replay --memory MB` sets this, for a build or test suite that needs more than the
// default share of the runtime's memory.
export const MEMORY_ENV = "SA_READINESS_MEMORY_MB";

export function memoryOverride(env: Record<string, string | undefined> = process.env): number | null {
  const v = env[MEMORY_ENV];
  if (!v) return null;
  const mb = Number(v);
  if (!Number.isInteger(mb) || mb < 256) fail(`--memory takes a whole number of MB, at least 256; got ${v}.`);
  return mb;
}

export function probeLimits(runtime: Runtime): Limits {
  const r = spawnSync(runtime.bin, ["info", "--format", "{{.NCPU}} {{.MemTotal}}"], { encoding: "utf8", timeout: 20000 });
  const [ncpu, mem] = r.status === 0 ? r.stdout.trim().split(/\s+/).map(Number) : [NaN, NaN];
  const limits = limitsFor(Number.isFinite(ncpu) ? ncpu : null, Number.isFinite(mem) ? mem : null);
  const asked = memoryOverride();
  return asked ? { ...limits, memoryMb: asked } : limits;
}

// Behind a proxy or TLS inspection, installs need the same settings the host has. A CA variable
// names a host path, so that file is mounted read-only at the same path.
export const NETWORK_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
export const CA_ENV = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "PIP_CERT"];

// Every capability is dropped, then the few the audit's own setup needs as root are added back:
// installing packages (apt drops to its own user, dpkg sets owners and modes) and killing a
// timed-out command. The repo's commands run as an ordinary user with no-new-privileges, so they
// hold none of them.
export const CAPS_ADDED = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID"];

// The pnpm store lives in the container's home: on its own pnpm would put it at the root of the
// bind-mounted work tree, where lint and the snapshot of the tree would see it. pnpm 11 reads only
// pnpm_config_*, older pnpm only npm_config_*, so both are set.
export const PNPM_STORE = "/tmp/home/.pnpm-store";

// How long a container may live: past it, its `sleep` ends and --rm removes it, so one an audit
// couldn't stop still goes away on its own.
export const DEFAULT_LIFETIME_SEC = 4 * 3600;

export function startArgs(name: string, image: string, hostDir: string, limits: Limits | null = null, env: Record<string, string | undefined> = process.env, pathExists: (p: string) => boolean = existsSync, lifetimeSec = DEFAULT_LIFETIME_SEC): string[] {
  const args = ["run", "-d", "--rm", "--name", name, "--label", `${OWNER_PID_LABEL}=${process.pid}`, "--label", `${OWNER_HOST_LABEL}=${hostname()}`, "-v", `${hostDir}:/work`, "-w", "/work", "-e", "CI=1", "-e", `HOME=${HOME_DIR}`, "-e", `npm_config_store_dir=${PNPM_STORE}`, "-e", `pnpm_config_store_dir=${PNPM_STORE}`];
  args.push("--cap-drop=ALL", ...CAPS_ADDED.map((c) => `--cap-add=${c}`), "--security-opt", "no-new-privileges");
  // An init as PID 1 reaps orphaned processes. Without it a killed child stays a zombie, and a test
  // that checks its process tree was stopped (kill -0) sees it as still running.
  args.push("--init");
  for (const [k, v] of Object.entries(normalizedEnv())) args.push("-e", `${k}=${v}`);
  if (limits) {
    if (limits.cpus) args.push("--cpus", String(limits.cpus));
    args.push("--memory", `${limits.memoryMb}m`, "--memory-swap", `${limits.memoryMb}m`, "--pids-limit", String(limits.pids));
  }
  for (const key of NETWORK_ENV) if (env[key]) args.push("-e", key);
  for (const key of CA_ENV) {
    const path = env[key];
    if (!path || !isAbsolute(path) || !pathExists(path)) continue;
    args.push("-e", key, "-v", `${path}:${path}:ro`);
  }
  args.push(pinnedRef(image), "sleep", String(Math.max(60, Math.round(lifetimeSec))));
  return args;
}

// Every command carries an id in its environment, which its children inherit, so a command that
// times out is killed inside the container and not just its docker exec client on the host.
export const EXEC_ID = "SA_READINESS_EXEC";

// The image's PATH, saved before the login profile runs: Debian's /etc/profile resets PATH for a
// login shell, which drops what the image's ENV PATH added, such as /usr/local/go/bin,
// /usr/local/cargo/bin or the JDK's bin. The login shell still runs, for what profile.d sets up;
// the image's PATH just goes back in front.
export const IMAGE_PATH_VAR = "SA_READINESS_IMAGE_PATH";

export function loginShell(command: string, pipefail: boolean): string[] {
  const inner = `export PATH="$${IMAGE_PATH_VAR}:$PATH"; unset ${IMAGE_PATH_VAR}; ${command}`;
  return ["bash", "-c", `${IMAGE_PATH_VAR}="$PATH" exec bash${pipefail ? " -o pipefail" : ""} -lc ${shellQuote(inner)}`];
}

export function execArgs(name: string, command: string, cwd: string, user: string | null = null, env: string[] = [], execId: string | null = null): string[] {
  const dir = cwd === "." || cwd === "" ? "/work" : `/work/${cwd}`;
  const vars = [...env.flatMap((k) => ["-e", k]), ...(execId ? ["-e", `${EXEC_ID}=${execId}`] : [])];
  return ["exec", ...(user ? ["-u", user] : []), "-w", dir, ...vars, name, ...loginShell(command, true)];
}

// Prints "idle" when the command's processes used no CPU over two seconds, "busy" otherwise: user
// plus system ticks from /proc/<pid>/stat, summed over every process carrying the command's id.
export function idleCommand(execId: string): string {
  const ticks = `t=0; for p in /proc/[0-9]*; do tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx '${EXEC_ID}=${execId}' || continue; s=$(sed 's/^.*) //' "$p/stat" 2>/dev/null) || continue; set -- $s; t=$((t + \${12:-0} + \${13:-0})); done; echo $t`;
  return `a=$(${ticks}); sleep 2; b=$(${ticks}); [ "$a" = "$b" ] && echo idle || echo busy`;
}

// Run as the same user as the command, which may read its processes' environment.
export function killCommand(execId: string): string {
  return `for p in /proc/[0-9]*; do tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx '${EXEC_ID}=${execId}' && kill -9 "\${p#/proc/}" 2>/dev/null; done; true`;
}

// CI runs the repo's commands as an ordinary user, and tests that check file permissions only
// pass there. Root on the host means no ordinary user to borrow, so commands run as the image's.
export function hostUser(): string | null {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || uid === 0 ? null : `${uid}:${gid}`;
}

// The home every command shares, and the one the audit's own setup uses as the image's user, so
// pip, npm and the rest leave their caches there instead of root-owned files in the shared one.
export const HOME_DIR = "/tmp/home";
export const SETUP_HOME = "/tmp/readiness-setup-home";

export function imageUserArgs(name: string, command: string, env: string[] = []): string[] {
  return ["exec", "-e", `HOME=${SETUP_HOME}`, ...env.flatMap((k) => ["-e", k]), name, ...loginShell(`mkdir -p ${SETUP_HOME} && ${command}`, false)];
}

// Hands what root left under these folders to the ordinary user: only root's files, one at a time,
// never following a link and never leaving the folder's filesystem. Not `chown -R`, which as root
// would also act on whatever a link in the repo points to.
export function reclaimCommand(user: string, dirs: string[]): string {
  return `find ${dirs.join(" ")} -xdev -uid 0 -exec chown -h ${user} {} + 2>/dev/null; true`;
}

export function homeCommand(user: string | null): string {
  return `mkdir -p ${HOME_DIR} && chmod 1777 ${HOME_DIR}${user ? ` && ${reclaimCommand(user, [HOME_DIR])}` : ""}`;
}

// The ordinary user is the host's uid, which the image usually has no /etc/passwd line for (1001 on
// GitHub's runners, 501 on a Mac). Tools that look up their own user fail without one, such as the
// .NET SDK's NuGet migrations. So the audit adds one, as OpenShift does for arbitrary uids, and a
// group line when the gid has none. An image whose user can't write /etc/passwd keeps it as it is:
// prints "present", "added" or "missing".
export function userEntryCommand(user: string): string {
  const [uid, gid] = user.split(":");
  const has = (file: string, id: string) => `{ getent ${file === "/etc/passwd" ? "passwd" : "group"} ${id} >/dev/null 2>&1 || grep -q '^[^:]*:[^:]*:${id}:' ${file} 2>/dev/null; }`;
  const group = `if ! ${has("/etc/group", gid)}; then echo 'readiness:x:${gid}:' >> /etc/group 2>/dev/null || echo group-missing; fi`;
  return `if ${has("/etc/passwd", uid)}; then echo present; elif echo 'readiness:x:${uid}:${gid}:readiness:${HOME_DIR}:/bin/sh' >> /etc/passwd 2>/dev/null; then echo added; else echo missing; fi; ${group}`;
}

export type UserEntry = "present" | "added" | "missing";

export function parseUserEntry(ok: boolean, output: string): UserEntry {
  if (!ok || /\bmissing\b/.test(output)) return "missing";
  return /\badded\b/.test(output) ? "added" : "present";
}

// Streams a folder out of a created (never started) container of another image into a staging
// folder of the audit's container, as a tar through the runtime's `cp`, so nothing in either image runs.
export function copyPipeline(bin: string, source: string, from: string, target: string, stage: string): string {
  return `${shellQuote(bin)} cp ${shellQuote(`${source}:${from}`)} - | ${shellQuote(bin)} cp - ${shellQuote(`${target}:${stage}`)}`;
}

export function disconnectArgs(name: string, network = "bridge"): string[] {
  return ["network", "disconnect", network, name];
}

export function networksArgs(name: string): string[] {
  return ["inspect", "-f", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}", name];
}

export class ContainerSession {
  runtime: Runtime;
  name: string;
  image: string;
  hostDir: string;
  // Passed to the setup steps only: the doctor, the installs and the audit's tool setup.
  registryEnv: string[];
  user: string | null;
  limits: Limits | null;
  // Whether the ordinary user has an /etc/passwd line in the container; null when commands run as
  // the image's own user.
  userEntry: UserEntry | null = null;
  // Set once disconnectNetwork() has cut every network.
  offline = false;
  // The networks disconnectNetwork() cut, so reconnectNetwork() can attach them again.
  cutFrom: string[] = [];
  lifetimeSec: number;
  // Processes the kernel stopped at the memory limit so far, from the container's cgroup.
  oomKills = 0;
  private dropTeardown: (() => void) | null = null;

  constructor(runtime: Runtime, name: string, image: string, hostDir: string, registryEnv: string[], user: string | null = hostUser(), limits: Limits | null = null, lifetimeSec = DEFAULT_LIFETIME_SEC) {
    this.runtime = runtime;
    this.name = name;
    this.image = image;
    this.hostDir = hostDir;
    this.registryEnv = registryEnv;
    this.user = user;
    this.limits = limits;
    this.lifetimeSec = lifetimeSec;
  }

  start(): { ok: boolean; output: string } {
    const env = { ...process.env } as Record<string, string>;
    this.dropTeardown = onTeardown(() => this.stop(60000));
    const r = spawnSync(this.runtime.bin, startArgs(this.name, this.image, this.hostDir, this.limits, process.env, existsSync, this.lifetimeSec), { encoding: "utf8", env, timeout: 300000 });
    if (r.status === 0) {
      if (this.user) {
        const entry = this.asImageUser(userEntryCommand(this.user), 30000);
        this.userEntry = parseUserEntry(entry.ok, entry.output);
      }
      this.reclaimHome();
    }
    return { ok: r.status === 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  // The repo's own declared setup runs as its image's user; everything else as the ordinary user.
  async exec(command: string, cwd: string, timeoutSec: number, opts: { imageUser?: boolean; registry?: boolean; env?: Record<string, string> } = {}): Promise<RunOutcome> {
    const user = opts.imageUser ? null : this.user;
    const execId = randomHex(6);
    const env = [...(opts.registry ? this.registryEnv : []), ...Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`)];
    const argv = [this.runtime.bin, ...execArgs(this.name, command, cwd, user, env, execId)].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    let out = await runCommand(argv, process.cwd(), process.env as Record<string, string>, timeoutSec);
    if (out.timedOut) {
      const idle = spawnSync(this.runtime.bin, ["exec", ...(user ? ["-u", user] : []), this.name, "bash", "-c", idleCommand(execId)], { encoding: "utf8", timeout: 15000 });
      if ((idle.stdout ?? "").trim() === "idle") out = { ...out, output: `${out.output}\n${IDLE_MARK}: no CPU in its last 2 seconds${this.offline ? `, ${IDLE_OFFLINE}` : ""}\n` };
      spawnSync(this.runtime.bin, ["exec", ...(user ? ["-u", user] : []), this.name, "bash", "-c", killCommand(execId)], { encoding: "utf8", timeout: 30000 });
    } else if (out.exitCode !== 0) {
      const kills = this.readOomKills();
      if (kills !== null && kills > this.oomKills) {
        out = { ...out, output: `${out.output}\n${oomNote(this.limits?.memoryMb ?? null, kills - this.oomKills)}\n` };
        this.oomKills = kills;
      }
    }
    if (opts.imageUser && this.user) {
      this.asImageUser(reclaimCommand(this.user, ["/work"]));
      this.reclaimHome();
    }
    return out;
  }

  asImageUser(command: string, timeoutMs = 300000, opts: { registry?: boolean } = {}): { ok: boolean; output: string } {
    const r = spawnSync(this.runtime.bin, imageUserArgs(this.name, command, opts.registry ? this.registryEnv : []), { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { ok: r.status === 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  // Copies a folder of another pinned image into this container, with the network still on for the pull.
  copyFromImage(image: string, from: string, to: string, timeoutMs = 900000): { ok: boolean; output: string } {
    const created = spawnSync(this.runtime.bin, ["create", "--name", `${this.name}-src-${randomHex(3)}`, "--label", `${OWNER_PID_LABEL}=${process.pid}`, "--label", `${OWNER_HOST_LABEL}=${hostname()}`, pinnedRef(image)], { encoding: "utf8", timeout: timeoutMs });
    if (created.status !== 0) return { ok: false, output: (created.stdout ?? "") + (created.stderr ?? "") };
    const source = created.stdout.trim().split("\n").pop()!;
    const stage = `/tmp/readiness-copy-${randomHex(3)}`;
    const drop = onTeardown(() => spawnSync(this.runtime.bin, ["rm", "-f", source], { encoding: "utf8" }));
    try {
      const mk = this.asImageUser(`mkdir -p ${stage}`, 30000);
      if (!mk.ok) return mk;
      const piped = spawnSync("bash", ["-o", "pipefail", "-c", copyPipeline(this.runtime.bin, source, from, this.name, stage)], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
      if (piped.status !== 0) return { ok: false, output: (piped.stdout ?? "") + (piped.stderr ?? "") };
      return this.asImageUser(`mkdir -p ${shellQuote(dirname(to))} && rm -rf ${shellQuote(to)} && mv ${shellQuote(`${stage}/${basename(from)}`)} ${shellQuote(to)} && rm -rf ${stage}`, 120000);
    } finally {
      drop();
      spawnSync(this.runtime.bin, ["rm", "-f", source], { encoding: "utf8" });
    }
  }

  // Gives the shared home, and the caches a setup step left in it, back to the ordinary user.
  reclaimHome(): void {
    this.asImageUser(homeCommand(this.user));
  }

  enableCorepack(): void {
    this.asImageUser("command -v corepack >/dev/null && corepack enable >/dev/null 2>&1 || true", 60000);
  }

  // Podman attaches to "podman" rather than "bridge", and rootless networking lists no network at
  // all, so every attached network is cut and the container itself must show every interface but
  // loopback down. Kernels add tunnel devices such as tunl0 that are always down.
  disconnectNetwork(): boolean {
    const r = spawnSync(this.runtime.bin, networksArgs(this.name), { encoding: "utf8" });
    if (r.status !== 0) return false;
    const nets = r.stdout.trim().split(/\s+/).filter(Boolean);
    if (nets.length) this.cutFrom = nets;
    for (const net of nets) spawnSync(this.runtime.bin, disconnectArgs(this.name, net), { encoding: "utf8" });
    const probe = this.asImageUser('for i in /sys/class/net/*; do [ -f "$i/operstate" ] && echo "$(basename "$i") $(cat "$i/operstate")"; done; true', 30000);
    this.offline = probe.ok && probe.output.trim().split("\n").every((l) => l.startsWith("lo ") || l.endsWith(" down"));
    return this.offline;
  }

  // Attaches the networks disconnectNetwork() cut, for one rerun with the network on.
  reconnectNetwork(): boolean {
    if (!this.cutFrom.length) return false;
    const ok = this.cutFrom.every((net) => spawnSync(this.runtime.bin, ["network", "connect", net, this.name], { encoding: "utf8" }).status === 0);
    if (ok) this.offline = false;
    return ok;
  }

  // The kernel's count of processes it stopped at this container's memory limit: cgroup v2's
  // memory.events, or v1's memory.oom_control. Null when neither can be read.
  readOomKills(): number | null {
    const r = spawnSync(this.runtime.bin, ["exec", this.name, "cat", "/sys/fs/cgroup/memory.events"], { encoding: "utf8", timeout: 15000 });
    const v1 = r.status === 0 ? null : spawnSync(this.runtime.bin, ["exec", this.name, "cat", "/sys/fs/cgroup/memory/memory.oom_control"], { encoding: "utf8", timeout: 15000 });
    return parseOomKills(r.status === 0 ? r.stdout : v1?.status === 0 ? v1.stdout : "");
  }

  // The work tree is the audit's throwaway copy, so what root left in it is deleted from inside the
  // container rather than handed back with a chown, and the host can then remove the folder.
  stop(timeoutMs = 300000): void {
    spawnSync(this.runtime.bin, ["exec", this.name, "find", "/work", "-mindepth", "1", "-maxdepth", "1", "-exec", "rm", "-rf", "{}", "+"], { encoding: "utf8", timeout: timeoutMs });
    this.remove();
  }

  // Removes the container and leaves the work tree as it is.
  remove(): void {
    this.dropTeardown?.();
    this.dropTeardown = null;
    spawnSync(this.runtime.bin, ["rm", "-f", this.name], { encoding: "utf8" });
  }
}

export function parseOomKills(text: string): number | null {
  const m = text.match(/^oom_kill (\d+)$/m);
  return m ? Number(m[1]) : null;
}

// What the audit appends to a failed command's output when the kernel stopped a process at the
// container's memory limit while it ran. diagnose() reads it back as the audit's limit.
export function oomNote(memoryMb: number | null, kills: number): string {
  return `${OOM_MARK}: the kernel stopped ${kills === 1 ? "a process" : `${kills} processes`} at the container's ${memoryMb ? `${memoryMb} MB ` : ""}memory limit`;
}
