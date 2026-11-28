#!/usr/bin/env node
/**
 * Lightweight verification & smoke-check script for the Sprint 0 seed corpus.
 *
 * Checks per app:
 *   1. Generator determinism (`generate-corpus.mjs --check`)
 *   2. Dependency installation (when node_modules is missing or --install is passed)
 *   3. Production build (`vite build` / `next build`)
 *   4. TypeScript typecheck (`tsc --noEmit` where applicable)
 *   5. Live HTTP smoke check on an ephemeral loopback port (never 4400-4410 or 4600)
 *      with strict process-group cleanup.
 *
 * Usage:
 *   node skills/codecanvas/examples/corpus/verify-corpus.mjs
 *   node skills/codecanvas/examples/corpus/verify-corpus.mjs --install
 *   node skills/codecanvas/examples/corpus/verify-corpus.mjs --dev
 *   node skills/codecanvas/examples/corpus/verify-corpus.mjs --skip-smoke
 *   node skills/codecanvas/examples/corpus/verify-corpus.mjs --apps=vite-react18-js,next-tailwind
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORPUS_ROOT = __dirname;
const GENERATOR_SCRIPT = path.resolve(CORPUS_ROOT, '../../scripts/generate-corpus.mjs');

const APP_SPECS = [
  {
    name: 'vite-react18-js',
    hasTypecheck: false,
    startCommand: (port) => ['npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort']],
    smokeRoutes: [
      { path: '/', expectText: 'Release Studio' },
      { path: '/releases', expectText: 'Release Studio' },
      { path: '/src/App.jsx', expectText: 'React.createElement' },
    ],
  },
  {
    name: 'next-mui-emotion',
    hasTypecheck: true,
    startCommand: (port, useDev) => [
      'npx',
      ['next', useDev ? 'dev' : 'start', '-H', '127.0.0.1', '-p', String(port)],
    ],
    smokeRoutes: [
      { path: '/', expectText: 'Design System Surface', forbidText: '__next_error__' },
      { path: '/catalog', expectText: 'Component Catalog', forbidText: '__next_error__' },
      { path: '/catalog/hero-banner', expectText: 'Hero Banner', forbidText: '__next_error__' },
      { path: '/settings', expectText: 'Inspector Settings', forbidText: '__next_error__' },
    ],
  },
  {
    name: 'next-tailwind',
    hasTypecheck: true,
    startCommand: (port, useDev) => [
      'npx',
      ['next', useDev ? 'dev' : 'start', '-H', '127.0.0.1', '-p', String(port)],
    ],
    smokeRoutes: [
      { path: '/', expectText: 'Workspace Overview', forbidText: '__next_error__' },
      { path: '/projects', expectText: 'Projects Directory', forbidText: '__next_error__' },
      { path: '/projects/storefront-web', expectText: 'Storefront Web', forbidText: '__next_error__' },
      { path: '/settings', expectText: 'Workspace Settings', forbidText: '__next_error__' },
    ],
  },
];

const activeGroups = new Set();

function isForbiddenPort(port) {
  return (port >= 4400 && port <= 4410) || port === 4600;
}

async function allocateSafePort() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const selected = typeof address === 'object' && address ? address.port : 0;
        server.close((closeErr) => {
          if (closeErr) reject(closeErr);
          else resolve(selected);
        });
      });
    });
    if (port > 0 && !isForbiddenPort(port)) {
      return port;
    }
  }
  throw new Error('Could not allocate an ephemeral port outside 4400-4410 and 4600');
}

function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    throw err;
  }
}

async function stopProcessGroup(child) {
  if (!child || !child.pid) return;
  const pid = child.pid;
  activeGroups.delete(pid);

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  killProcessGroup(pid, 'SIGTERM');

  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exited) {
    killProcessGroup(pid, 'SIGKILL');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function cleanupAllGroupsSync() {
  for (const pid of activeGroups) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Process group already exited.
    }
  }
  activeGroups.clear();
}

process.on('SIGINT', () => {
  cleanupAllGroupsSync();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanupAllGroupsSync();
  process.exit(143);
});
process.on('exit', cleanupAllGroupsSync);

function runCommand(cmd, args, { cwd, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) activeGroups.add(child.pid);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (child.pid) activeGroups.delete(child.pid);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      if (child.pid) activeGroups.delete(child.pid);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(
          `Command failed (${cmd} ${args.join(' ')}) in ${cwd} with code=${code} signal=${signal}\n${stdout}\n${stderr}`
        );
        reject(error);
      }
    });
  });
}

async function waitForHttpReady(url, timeoutMs, isDead) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (isDead()) {
      throw new Error(`Server process exited before ${url} became ready`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status} from ${url}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError ? lastError.message : 'unknown error'}`);
}

async function runSmokeCheck(spec, appDir, useDev) {
  const port = await allocateSafePort();
  const [cmd, args] = spec.startCommand(port, useDev);
  const child = spawn(cmd, args, {
    cwd: appDir,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      CI: '1',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid) activeGroups.add(child.pid);

  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHttpReady(`${baseUrl}/`, 30000, () => child.exitCode !== null);

    for (const route of spec.smokeRoutes) {
      const response = await fetch(`${baseUrl}${route.path}`);
      if (response.status !== 200) {
        throw new Error(`Expected HTTP 200 for ${route.path}, got ${response.status}`);
      }
      const body = await response.text();
      if (!body.includes(route.expectText)) {
        throw new Error(
          `Expected "${route.expectText}" in response body for ${route.path} (len=${body.length})`
        );
      }
      if (route.forbidText && body.includes(route.forbidText)) {
        throw new Error(`Found forbidden marker "${route.forbidText}" in ${route.path}`);
      }
    }

    return { port, routesChecked: spec.smokeRoutes.length };
  } catch (err) {
    err.message = `${err.message}\n--- server output ---\n${logs}`;
    throw err;
  } finally {
    await stopProcessGroup(child);
  }
}

function parseArgs(argv) {
  const forceInstall = argv.includes('--install');
  const skipInstall = argv.includes('--skip-install');
  const skipSmoke = argv.includes('--skip-smoke');
  const useDev = argv.includes('--dev');
  const appsArg = argv.find((arg) => arg.startsWith('--apps='));
  const selectedApps = appsArg
    ? new Set(appsArg.slice('--apps='.length).split(',').filter(Boolean))
    : null;
  return { forceInstall, skipInstall, skipSmoke, useDev, selectedApps };
}

async function main() {
  const { forceInstall, skipInstall, skipSmoke, useDev, selectedApps } = parseArgs(process.argv.slice(2));

  console.log('[1/2] Checking generator determinism...');
  await runCommand(process.execPath, [GENERATOR_SCRIPT, '--check'], { cwd: CORPUS_ROOT });

  const specs = selectedApps
    ? APP_SPECS.filter((spec) => selectedApps.has(spec.name))
    : APP_SPECS;

  if (specs.length === 0) {
    throw new Error('No matching corpus apps selected');
  }

  console.log(`[2/2] Verifying ${specs.length} corpus app(s)...`);
  const summary = [];

  for (const spec of specs) {
    const appDir = path.join(CORPUS_ROOT, spec.name);
    const startMs = Date.now();
    const nodeModulesDir = path.join(appDir, 'node_modules');

    if (!skipInstall && (forceInstall || !fs.existsSync(nodeModulesDir))) {
      console.log(`  [${spec.name}] installing dependencies...`);
      await runCommand('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: appDir,
        env: { NEXT_TELEMETRY_DISABLED: '1' },
      });
    }

    console.log(`  [${spec.name}] building...`);
    await runCommand('npm', ['run', 'build'], {
      cwd: appDir,
      env: { NEXT_TELEMETRY_DISABLED: '1' },
    });

    if (spec.hasTypecheck) {
      console.log(`  [${spec.name}] typechecking...`);
      await runCommand('npm', ['run', 'typecheck'], {
        cwd: appDir,
        env: { NEXT_TELEMETRY_DISABLED: '1' },
      });
    }

    let smokeInfo = 'skipped';
    if (!skipSmoke) {
      console.log(`  [${spec.name}] running HTTP smoke check...`);
      const smoke = await runSmokeCheck(spec, appDir, useDev);
      smokeInfo = `${smoke.routesChecked} routes OK (port ${smoke.port})`;
    }

    const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
    summary.push({
      app: spec.name,
      build: 'ok',
      typecheck: spec.hasTypecheck ? 'ok' : 'n/a (js)',
      smoke: smokeInfo,
      elapsed: `${elapsedSec}s`,
    });
  }

  console.log('\nSeed corpus verification summary:');
  for (const row of summary) {
    console.log(
      `  - ${row.app}: build=${row.build}, typecheck=${row.typecheck}, smoke=${row.smoke} (${row.elapsed})`
    );
  }
}

main().catch((err) => {
  cleanupAllGroupsSync();
  console.error(err);
  process.exit(1);
});
