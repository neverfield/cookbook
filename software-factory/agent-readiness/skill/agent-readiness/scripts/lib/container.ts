import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pinnedRef } from "./images.ts";
import { runCommand } from "./run.ts";
import type { RunOutcome } from "./run.ts";
import { fail, randomHex } from "./util.ts";

export interface Runtime {
  bin: string;
}

// Only these runtimes: any other program given as --runtime would have its exit codes recorded as
// clean-container results.
export const RUNTIMES = ["auto", "docker", "podman", "none"];

export function detectRuntime(preference: string = "auto"): Runtime | null {
  if (!RUNTIMES.includes(preference)) fail(`--runtime takes ${RUNTIMES.join(", ")}; got ${preference}.`);
  if (preference === "none") return null;
  const candidates = preference === "auto" ? ["docker", "podman"] : [preference];
  for (const bin of candidates) {
    const r = spawnSync(bin, ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 20000 });
    if (r.status === 0) return { bin };
  }
  return null;
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

export function probeLimits(runtime: Runtime): Limits {
  const r = spawnSync(runtime.bin, ["info", "--format", "{{.NCPU}} {{.MemTotal}}"], { encoding: "utf8", timeout: 20000 });
  const [ncpu, mem] = r.status === 0 ? r.stdout.trim().split(/\s+/).map(Number) : [NaN, NaN];
  return limitsFor(Number.isFinite(ncpu) ? ncpu : null, Number.isFinite(mem) ? mem : null);
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
// bind-mounted work tree, where lint and the snapshot of the tree would see it.
export const PNPM_STORE = "/tmp/home/.pnpm-store";

export function startArgs(name: string, image: string, hostDir: string, limits: Limits | null = null, env: Record<string, string | undefined> = process.env, pathExists: (p: string) => boolean = existsSync): string[] {
  const args = ["run", "-d", "--name", name, "-v", `${hostDir}:/work`, "-w", "/work", "-e", "CI=1", "-e", `HOME=${HOME_DIR}`, "-e", `npm_config_store_dir=${PNPM_STORE}`];
  args.push("--cap-drop=ALL", ...CAPS_ADDED.map((c) => `--cap-add=${c}`), "--security-opt", "no-new-privileges");
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
  args.push(pinnedRef(image), "sleep", "infinity");
  return args;
}

// Every command carries an id in its environment, which its children inherit, so a command that
// times out is killed inside the container and not just its docker exec client on the host.
export const EXEC_ID = "SA_READINESS_EXEC";

export function execArgs(name: string, command: string, cwd: string, user: string | null = null, env: string[] = [], execId: string | null = null): string[] {
  const dir = cwd === "." || cwd === "" ? "/work" : `/work/${cwd}`;
  const vars = [...env.flatMap((k) => ["-e", k]), ...(execId ? ["-e", `${EXEC_ID}=${execId}`] : [])];
  return ["exec", ...(user ? ["-u", user] : []), "-w", dir, ...vars, name, "bash", "-o", "pipefail", "-lc", command];
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
  return ["exec", "-e", `HOME=${SETUP_HOME}`, ...env.flatMap((k) => ["-e", k]), name, "bash", "-lc", `mkdir -p ${SETUP_HOME} && ${command}`];
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

  constructor(runtime: Runtime, name: string, image: string, hostDir: string, registryEnv: string[], user: string | null = hostUser(), limits: Limits | null = null) {
    this.runtime = runtime;
    this.name = name;
    this.image = image;
    this.hostDir = hostDir;
    this.registryEnv = registryEnv;
    this.user = user;
    this.limits = limits;
  }

  start(): { ok: boolean; output: string } {
    const env = { ...process.env } as Record<string, string>;
    const r = spawnSync(this.runtime.bin, startArgs(this.name, this.image, this.hostDir, this.limits), { encoding: "utf8", env, timeout: 300000 });
    if (r.status === 0) this.reclaimHome();
    return { ok: r.status === 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  // The repo's own declared setup runs as its image's user; everything else as the ordinary user.
  async exec(command: string, cwd: string, timeoutSec: number, opts: { imageUser?: boolean; registry?: boolean } = {}): Promise<RunOutcome> {
    const user = opts.imageUser ? null : this.user;
    const execId = randomHex(6);
    const argv = [this.runtime.bin, ...execArgs(this.name, command, cwd, user, opts.registry ? this.registryEnv : [], execId)].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    const out = await runCommand(argv, process.cwd(), process.env as Record<string, string>, timeoutSec);
    if (out.timedOut) spawnSync(this.runtime.bin, ["exec", ...(user ? ["-u", user] : []), this.name, "bash", "-c", killCommand(execId)], { encoding: "utf8", timeout: 30000 });
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
    for (const net of r.stdout.trim().split(/\s+/).filter(Boolean)) spawnSync(this.runtime.bin, disconnectArgs(this.name, net), { encoding: "utf8" });
    const probe = this.asImageUser('for i in /sys/class/net/*; do [ -f "$i/operstate" ] && echo "$(basename "$i") $(cat "$i/operstate")"; done; true', 30000);
    return probe.ok && probe.output.trim().split("\n").every((l) => l.startsWith("lo ") || l.endsWith(" down"));
  }

  // The work tree is the audit's throwaway copy, so what root left in it is deleted from inside the
  // container rather than handed back with a chown, and the host can then remove the folder.
  stop(): void {
    spawnSync(this.runtime.bin, ["exec", this.name, "find", "/work", "-mindepth", "1", "-maxdepth", "1", "-exec", "rm", "-rf", "{}", "+"], { encoding: "utf8", timeout: 300000 });
    this.remove();
  }

  // Removes the container and leaves the work tree as it is.
  remove(): void {
    spawnSync(this.runtime.bin, ["rm", "-f", this.name], { encoding: "utf8" });
  }
}
