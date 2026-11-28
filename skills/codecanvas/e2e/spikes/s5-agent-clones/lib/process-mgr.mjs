import { spawn } from 'node:child_process';
import net from 'node:net';
import { performance } from 'node:perf_hooks';

const FORBIDDEN_PORT_START = 4400;
const FORBIDDEN_PORT_END = 4410;
const FORBIDDEN_SINGLE_PORT = 4600;

const allocatedPorts = new Set();
const activeProcessGroups = new Set();

export function isForbiddenPort(port) {
  return (
    (port >= FORBIDDEN_PORT_START && port <= FORBIDDEN_PORT_END) ||
    port === FORBIDDEN_SINGLE_PORT
  );
}

function tryBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

export async function allocatePort(start = 4720, end = 4899) {
  for (let port = start; port <= end; port += 1) {
    if (isForbiddenPort(port) || allocatedPorts.has(port)) {
      continue;
    }
    const available = await tryBindPort(port);
    if (available) {
      allocatedPorts.add(port);
      return port;
    }
  }
  throw new Error(`No available port found in range ${start}-${end}`);
}

export function releasePort(port) {
  allocatedPorts.delete(port);
}

function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if (err && err.code !== 'ESRCH') {
      try {
        process.kill(pid, signal);
      } catch {
        // Process already exited.
      }
    }
  }
}

export async function stopProcessGroup(child, graceMs = 5000) {
  if (!child || child.pid == null) {
    return;
  }
  const pid = child.pid;
  if (child.exitCode !== null || child.signalCode !== null) {
    activeProcessGroups.delete(pid);
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeProcessGroups.delete(pid);
      resolve();
    };

    child.once('exit', finish);
    child.once('close', finish);

    killProcessGroup(pid, 'SIGTERM');

    const timer = setTimeout(() => {
      killProcessGroup(pid, 'SIGKILL');
      setTimeout(finish, 1000);
    }, graceMs);
    timer.unref();
  });
}

export function cleanupAllProcessGroupsSync() {
  for (const pid of activeProcessGroups) {
    killProcessGroup(pid, 'SIGKILL');
  }
  activeProcessGroups.clear();
}

function buildSpawnSpec(cmd, args, cpuList) {
  if (cpuList) {
    return {
      command: 'taskset',
      commandArgs: ['-c', cpuList, cmd, ...args],
    };
  }
  return { command: cmd, commandArgs: args };
}

export function runCommand(cmd, args, options = {}) {
  const {
    cwd,
    env = process.env,
    input,
    timeoutMs = 300_000,
    cpuList = null,
    allowFailure = false,
  } = options;

  const { command, commandArgs } = buildSpawnSpec(cmd, args, cpuList);
  const startedAt = performance.now();

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (child.pid != null) {
      activeProcessGroups.add(child.pid);
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid != null) {
        killProcessGroup(child.pid, 'SIGKILL');
      }
    }, timeoutMs);
    timer.unref();

    child.once('error', (err) => {
      clearTimeout(timer);
      if (child.pid != null) activeProcessGroups.delete(child.pid);
      reject(err);
    });

    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (child.pid != null) activeProcessGroups.delete(child.pid);
      const elapsedMs = performance.now() - startedAt;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (timedOut) {
        reject(
          new Error(
            `Command timed out after ${timeoutMs}ms: ${command} ${commandArgs.join(' ')}\nstderr:\n${stderr.slice(-2000)}`,
          ),
        );
        return;
      }

      if (code !== 0 && !allowFailure) {
        reject(
          new Error(
            `Command failed (code=${code}, signal=${signal}): ${command} ${commandArgs.join(' ')}\nstdout:\n${stdout.slice(-2000)}\nstderr:\n${stderr.slice(-2000)}`,
          ),
        );
        return;
      }

      resolve({
        code,
        signal,
        stdout,
        stderr,
        elapsedMs,
      });
    });
  });
}

export function spawnServer(cmd, args, options = {}) {
  const { cwd, env = process.env, cpuList = null } = options;
  const { command, commandArgs } = buildSpawnSpec(cmd, args, cpuList);
  const startedAt = performance.now();

  const child = spawn(command, commandArgs, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (child.pid != null) {
    activeProcessGroups.add(child.pid);
  }

  let combinedOutput = '';
  let stdoutOutput = '';
  let stderrOutput = '';
  const listeners = new Set();

  const notify = () => {
    for (const fn of listeners) {
      fn();
    }
  };

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stdoutOutput += text;
    combinedOutput += text;
    notify();
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderrOutput += text;
    combinedOutput += text;
    notify();
  });

  function waitForLog(pattern, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const match = combinedOutput.match(pattern);
        if (match) {
          cleanup();
          resolve({
            elapsedMs: performance.now() - startedAt,
            match: match[0],
            stdout: stdoutOutput,
            stderr: stderrOutput,
            combined: combinedOutput,
          });
          return true;
        }
        return false;
      };

      const onExit = (code, signal) => {
        cleanup();
        reject(
          new Error(
            `Server exited before matching ${pattern} (code=${code}, signal=${signal}).\nOutput:\n${combinedOutput.slice(-3000)}`,
          ),
        );
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting ${timeoutMs}ms for log pattern ${pattern}.\nOutput:\n${combinedOutput.slice(-3000)}`,
          ),
        );
      }, timeoutMs);
      timer.unref();

      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(check);
        child.off('exit', onExit);
      };

      if (check()) return;
      listeners.add(check);
      child.once('exit', onExit);
    });
  }

  return {
    child,
    startedAt,
    getOutput: () => ({
      stdout: stdoutOutput,
      stderr: stderrOutput,
      combined: combinedOutput,
    }),
    waitForLog,
    stop: () => stopProcessGroup(child),
  };
}

export async function httpGet(url, timeoutMs = 60_000) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();

  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      body,
      elapsedMs: performance.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForHttpOk(url, timeoutMs = 60_000, intervalMs = 150) {
  const deadline = performance.now() + timeoutMs;
  let lastError = null;
  while (performance.now() < deadline) {
    try {
      const remaining = Math.max(1000, Math.floor(deadline - performance.now()));
      const res = await httpGet(url, remaining);
      if (res.status === 200) {
        return res;
      }
      lastError = new Error(`HTTP ${res.status} from ${url}: ${res.body.slice(0, 300)}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw lastError ?? new Error(`Timed out waiting for HTTP 200 at ${url}`);
}
