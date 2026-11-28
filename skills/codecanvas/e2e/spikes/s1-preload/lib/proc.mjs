import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SPIKE_DIR = path.resolve(__dirname, '..');
export const PRELOAD_PATH = path.join(SPIKE_DIR, 'preload.mjs');
export const RUNTIME_SRC_DIR = path.join(SPIKE_DIR, 'runtime');
export const RUNTIME_VERSION = '0.0.1';

const FORBIDDEN_PORTS = new Set([
  4400, 4401, 4402, 4403, 4404, 4405, 4406, 4407, 4408, 4409, 4410, 4600
]);

/**
 * Allocate an available loopback port strictly outside 4400-4410 and 4600.
 */
export async function allocatePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        srv.close(() => resolve(addr.port));
      });
    });
    if (!FORBIDDEN_PORTS.has(port)) {
      return port;
    }
  }
  throw new Error('Failed to allocate safe port');
}

/**
 * Copy spike runtime/loaders into <appRoot>/.codecanvas/cache/runtime/<version>/
 * so bundlers that only resolve inside project root (Turbopack) can load them (§3.1).
 */
export function copyRuntimeToAppCache(appRoot, { createTsconfig = false } = {}) {
  const ccDir = path.join(appRoot, '.codecanvas');
  const cacheDir = path.join(ccDir, 'cache');
  const runtimeDir = path.join(cacheDir, 'runtime', RUNTIME_VERSION);

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(ccDir, '.gitignore'), 'cache/\n');

  for (const file of fs.readdirSync(RUNTIME_SRC_DIR)) {
    fs.copyFileSync(path.join(RUNTIME_SRC_DIR, file), path.join(runtimeDir, file));
  }

  let tsconfigPath = null;
  if (createTsconfig) {
    tsconfigPath = path.join(cacheDir, 'tsconfig.json');
    const repoTsconfig = path.join(appRoot, 'tsconfig.json');
    const tsPayload = fs.existsSync(repoTsconfig)
      ? { extends: '../../tsconfig.json' }
      : { compilerOptions: { jsx: 'preserve', allowJs: true, noEmit: true } };
    fs.writeFileSync(tsconfigPath, JSON.stringify(tsPayload, null, 2) + '\n');
  }

  return { ccDir, cacheDir, runtimeDir, tsconfigPath };
}

/**
 * Build NODE_OPTIONS preserving any existing value while adding --import=file://.../preload.mjs.
 */
export function buildNodeOptions(existingNodeOptions = '') {
  const preloadUrl = pathToFileURL(PRELOAD_PATH).href;
  const flag = `--import=${preloadUrl}`;
  const trimmed = (existingNodeOptions || '').trim();
  return trimmed ? `${trimmed} ${flag}` : flag;
}

/**
 * Spawn a command in its own process group so teardown cleanly kills the entire tree
 * (npm/pnpm -> wrapper -> next/vite -> forked server & workers) without broad pkill.
 */
export function spawnManaged(command, args, { cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  let exited = false;
  let exitCode = null;
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      exitCode = code ?? signal;
      resolve({ code, signal });
    });
  });

  function groupAlive(pgid) {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (err) {
      return err && err.code === 'EPERM';
    }
  }

  async function waitForGroupExit(pgid, timeoutMs) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      if (!groupAlive(pgid)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return !groupAlive(pgid);
  }

  async function stop() {
    const pgid = child.pid;
    if (!pgid) return;
    if (!exited || groupAlive(pgid)) {
      try {
        process.kill(-pgid, 'SIGTERM');
      } catch {
        // Already exited
      }
      const clean = await waitForGroupExit(pgid, 4000);
      if (!clean) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          // Already exited
        }
        await waitForGroupExit(pgid, 2000);
      }
    }
    if (!exited) {
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 500))]);
    }
  }

  return {
    child,
    pid: child.pid,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    exitPromise,
    stop
  };
}

/**
 * Poll an HTTP endpoint until it returns status 200 (or any accepted status), measuring latency.
 */
export async function waitForHttpReady(url, { timeoutMs = 45000, proc = null } = {}) {
  const start = performance.now();
  let lastErr = null;
  while (performance.now() - start < timeoutMs) {
    if (proc && proc.exited) {
      throw new Error(
        `Process exited prematurely (code=${proc.exitCode}) before ${url} was ready.\nSTDOUT:\n${proc.stdout}\nSTDERR:\n${proc.stderr}`
      );
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (res.status >= 200 && res.status < 500) {
        const body = await res.text();
        return {
          status: res.status,
          body,
          headers: Object.fromEntries(res.headers.entries()),
          elapsedMs: Math.round(performance.now() - start)
        };
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `Timed out waiting for ${url} after ${timeoutMs}ms (lastErr=${lastErr?.message}).\nSTDOUT:\n${proc?.stdout || ''}\nSTDERR:\n${proc?.stderr || ''}`
  );
}

export function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'spike@codecanvas.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Spike S1'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial fixture'], { cwd: dir });
}

export function gitStatusPorcelain(dir) {
  return execFileSync('git', ['status', '--porcelain'], {
    cwd: dir,
    encoding: 'utf8'
  }).trim();
}

export function readRssMb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    return m ? Math.round((Number(m[1]) / 1024) * 10) / 10 : null;
  } catch {
    return null;
  }
}

export function readAuditLog(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
