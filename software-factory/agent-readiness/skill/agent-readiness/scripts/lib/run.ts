import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "./util.ts";

export interface RunOutcome {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

const PASS_THROUGH = ["PATH", "LANG", "LC_ALL", "TERM", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

export interface EnvOptions {
  registryEnv?: string[];
  inheritEnv?: boolean;
  extra?: Record<string, string>;
}

export const SUDO_SHIM_MARK = "readiness: sudo refused on the host";

// A script the contract calls can still reach for sudo, so the host PATH answers it first.
function sudoShim(bin: string): void {
  writeFileSync(join(bin, "sudo"), `#!/usr/bin/env bash\necho "${SUDO_SHIM_MARK}: the audit only runs sudo inside a container" >&2\nexit 126\n`);
  chmodSync(join(bin, "sudo"), 0o755);
}

// Credentials that reach past the repo: a cloud account, GitHub through gh, an SSH agent. Even with
// --inherit-env they stay out of host runs unless --registry-env names one.
export const ACCOUNT_CREDENTIAL = /^(AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS$|CLOUDSDK_|GH_|GITHUB_TOKEN$|GITLAB_TOKEN$|SSH_AUTH_SOCK$|SSH_AGENT_PID$|KUBECONFIG$|DOCKER_CONFIG$|NPM_CONFIG_USERCONFIG$|npm_config_userconfig$|VAULT_TOKEN$|OP_SESSION_|CURSOR_API_KEY$)/;

export function scrubbedEnv(opts: EnvOptions = {}): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "readiness-home-"));
  if (opts.inheritEnv) {
    const all: Record<string, string> = {};
    const named = new Set(opts.registryEnv ?? []);
    // The audit's own settings, the seal key among them, never reach the repo's code.
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("SA_") && (named.has(k) || !ACCOUNT_CREDENTIAL.test(k))) all[k] = v;
    const bin = join(home, "bin");
    ensureDir(bin);
    sudoShim(bin);
    // A throwaway home, so ~/.ssh, ~/.aws, ~/.npmrc and gh's login aren't where the repo looks.
    ensureDir(join(home, "tmp"));
    return { ...all, ...homeEnv(home), PATH: `${bin}:${all.PATH ?? "/usr/bin:/bin"}`, ...(opts.extra ?? {}) };
  }
  const env: Record<string, string> = {};
  for (const key of PASS_THROUGH) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  for (const key of opts.registryEnv ?? []) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  ensureDir(join(home, "cache"));
  const bin = join(home, "bin");
  ensureDir(bin);
  for (const pm of ["pnpm", "yarn"]) {
    writeFileSync(join(bin, pm), `#!/usr/bin/env bash\nexec corepack ${pm} "$@"\n`);
    chmodSync(join(bin, pm), 0o755);
  }
  sudoShim(bin);
  env.PATH = `${bin}:${env.PATH ?? "/usr/bin:/bin"}`;
  Object.assign(env, homeEnv(home), { CI: "1" });
  ensureDir(env.TMPDIR);
  return { ...env, ...(opts.extra ?? {}) };
}

// Every cache in the throwaway home. pnpm's store goes there too: left to itself, pnpm puts it at
// the root of the work tree's filesystem when that differs from the home's.
function homeEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    TMPDIR: join(home, "tmp"),
    XDG_CACHE_HOME: join(home, "cache"),
    npm_config_cache: join(home, "cache", "npm"),
    npm_config_store_dir: join(home, "cache", "pnpm-store"),
    pnpm_config_store_dir: join(home, "cache", "pnpm-store"),
    npm_config_update_notifier: "false",
    PIP_CACHE_DIR: join(home, "cache", "pip"),
    COREPACK_HOME: join(home, "cache", "corepack"),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  };
}

const MAX_OUTPUT = 1024 * 1024;

export function runCommand(command: string, cwd: string, env: Record<string, string>, timeoutSec: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    // pipefail, as CI shells run, so `tests | tee` fails when the tests do.
    const child = spawn("bash", ["-o", "pipefail", "-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let timedOut = false;
    const onData = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutSec * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, timedOut, durationMs: Date.now() - started, output });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, timedOut: false, durationMs: Date.now() - started, output: output + String(err) });
    });
  });
}
