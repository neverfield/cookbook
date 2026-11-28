import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHandshakeDaemon } from './lib/daemon.mjs';
import { createNextMonorepoFixture, createViteMonorepoFixture } from './lib/fixtures.mjs';
import {
  allocatePort,
  buildNodeOptions,
  copyRuntimeToAppCache,
  gitStatusPorcelain,
  readAuditLog,
  readRssMb,
  RUNTIME_SRC_DIR,
  spawnManaged,
  waitForHttpReady
} from './lib/proc.mjs';

const RUN_ID = `run-${Date.now()}`;
const WORK_ROOT = path.join(os.tmpdir(), 'codecanvas-s1-preload', RUN_ID);
fs.mkdirSync(WORK_ROOT, { recursive: true });

const results = [];
let failures = 0;

function record(name, data) {
  const ok = Boolean(data.ok);
  if (!ok) failures++;
  results.push({ name, ...data });
  const badge = ok ? 'PASS' : 'FAIL';
  const summary = data.summary || '';
  console.log(`[${badge}] ${name}${summary ? ` — ${summary}` : ''}`);
  if (!ok && data.error) {
    console.error(`       Error: ${data.error}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * Helper to fetch Vite-served module graph for App.tsx, Button.tsx (workspace), and App.css.
 */
async function probeViteServer(baseUrl, wsDir) {
  const indexRes = await fetch(`${baseUrl}/`);
  assert(indexRes.status === 200, `GET / returned ${indexRes.status}`);

  const appRes = await fetch(`${baseUrl}/src/App.tsx`);
  assert(appRes.status === 200, `GET /src/App.tsx returned ${appRes.status}`);
  const appCode = await appRes.text();

  // Discover the resolved URL Vite emitted for @acme/ui inside App.tsx
  const uiImportMatch = /from\s+["']([^"']*packages\/ui\/[^"']+)["']/.exec(appCode);
  let buttonCode = '';
  let buttonUrl = null;
  if (uiImportMatch) {
    const uiEntryUrl = uiImportMatch[1].startsWith('http')
      ? uiImportMatch[1]
      : `${baseUrl}${uiImportMatch[1].startsWith('/') ? '' : '/'}${uiImportMatch[1]}`;
    const entryRes = await fetch(uiEntryUrl);
    const entryCode = await entryRes.text();
    const btnImportMatch = /from\s+["']([^"']*Button\.tsx[^"']*)["']/.exec(entryCode);
    if (btnImportMatch) {
      buttonUrl = new URL(btnImportMatch[1], uiEntryUrl).href;
    } else if (entryCode.includes('data-cc-src')) {
      buttonUrl = uiEntryUrl;
      buttonCode = entryCode;
    }
  }
  if (!buttonCode && !buttonUrl) {
    const absBtn = path.join(wsDir, 'packages', 'ui', 'src', 'Button.tsx');
    buttonUrl = `${baseUrl}/@fs${absBtn}`;
  }
  if (!buttonCode) {
    const btnRes = await fetch(buttonUrl);
    assert(btnRes.status === 200, `GET ${buttonUrl} returned ${btnRes.status}`);
    buttonCode = await btnRes.text();
  }

  const cssRes = await fetch(`${baseUrl}/src/App.css`);
  assert(cssRes.status === 200, `GET /src/App.css returned ${cssRes.status}`);
  const cssCode = await cssRes.text();

  return { appCode, buttonCode, cssCode };
}

async function runNextScenario({
  label,
  nextVersion,
  scriptName,
  configMode = 'ts',
  useWorkspaceFilter = false,
  sideBySideDevServer = false,
  measureWarm = false,
  withExistingAgentsMd = false,
  expectedBundler = null
}) {
  const wsDir = path.join(WORK_ROOT, label.replace(/[^a-z0-9-]/gi, '-').toLowerCase());
  const { appDir } = createNextMonorepoFixture(wsDir, { nextVersion, configMode, withExistingAgentsMd });

  let baseProc = null;
  let instProc = null;
  let daemon = null;
  const auditLog = path.join(wsDir, '.cc-audit.jsonl');

  try {
    // 1. Measure baseline (uninstrumented) cold boot
    const basePort = await allocatePort();
    const baseSpawnStart = performance.now();
    baseProc = spawnManaged('pnpm', ['run', scriptName, '-p', String(basePort), '-H', '127.0.0.1'], {
      cwd: appDir,
      env: { CI: '1', NEXT_TELEMETRY_DISABLED: '1' }
    });
    const baseReady = await waitForHttpReady(`http://127.0.0.1:${basePort}/`, {
      timeoutMs: 60000,
      proc: baseProc
    });
    const baseColdMs = Math.round(performance.now() - baseSpawnStart);
    assert(baseReady.status === 200, `Baseline returned ${baseReady.status}`);
    assert(!baseReady.body.includes('data-cc-src='), 'Baseline must not contain data-cc-src');

    // If NOT testing side-by-side coexistence, stop baseline server and clean .next + git reset
    // (uninstrumented Next may update next-env.d.ts, tsconfig.json, or Next 16.3+ AGENTS.md —
    // reset cleanly so we measure ONLY the preload-instrumented server's footprint!)
    let devLockExistsDuringRun = false;
    if (!sideBySideDevServer) {
      await baseProc.stop();
      baseProc = null;
      fs.rmSync(path.join(appDir, '.next'), { recursive: true, force: true });
      execFileSync('git', ['checkout', '--', '.'], { cwd: wsDir });
      execFileSync('git', ['clean', '-fd', '--', 'apps/web/AGENTS.md'], { cwd: wsDir });
    } else {
      devLockExistsDuringRun =
        fs.existsSync(path.join(appDir, '.next', 'dev', 'lock')) ||
        fs.existsSync(path.join(appDir, '.next'));
      // Note: baseline dev server is STILL RUNNING on basePort!
      // Clean files created/touched by uninstrumented baseline before checking instrumented footprint
      execFileSync('git', ['checkout', '--', '.'], { cwd: wsDir });
      execFileSync('git', ['clean', '-fd', '--', 'apps/web/AGENTS.md'], { cwd: wsDir });
    }

    const beforeStatus = gitStatusPorcelain(wsDir);
    assert(beforeStatus === '', `Expected clean git status before instrumented launch, got: ${beforeStatus}`);

    // 2. Copy runtime into <appRoot>/.codecanvas/cache/runtime/<version>/ + private tsconfig
    const copyStart = performance.now();
    const { ccDir, runtimeDir } = copyRuntimeToAppCache(appDir, { createTsconfig: true });
    const runtimeCopyMs = Math.round((performance.now() - copyStart) * 10) / 10;

    // 3. Start loopback handshake daemon
    daemon = await startHandshakeDaemon();

    // 4. Spawn app's OWN dev script with NODE_OPTIONS=--import=...
    const instPort = await allocatePort();
    const env = {
      CI: '1',
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_OPTIONS: buildNodeOptions(process.env.NODE_OPTIONS || ''),
      CC_TARGET_FRAMEWORK: 'next',
      CC_APP_ROOT: appDir,
      CC_WORKSPACE_ROOT: wsDir,
      CC_RUNTIME_DIR: runtimeDir,
      CC_DIST_DIR: '.codecanvas/cache/next',
      CC_TSCONFIG_PATH: '.codecanvas/cache/tsconfig.json',
      CC_TRANSPILE_PACKAGES: JSON.stringify(['@acme/ui']),
      CC_DAEMON_URL: daemon.url,
      CC_DAEMON_TOKEN: daemon.token,
      CC_AUDIT_LOG: auditLog
    };

    const cmdArgs = useWorkspaceFilter
      ? ['--filter', '@acme/web', 'run', scriptName, '-p', String(instPort), '-H', '127.0.0.1']
      : ['run', scriptName, '-p', String(instPort), '-H', '127.0.0.1'];

    const instSpawnStart = performance.now();
    instProc = spawnManaged('pnpm', cmdArgs, {
      cwd: useWorkspaceFilter ? wsDir : appDir,
      env
    });

    const handshake = await daemon.waitForHandshake(30000);
    const handshakeMs = Math.round(performance.now() - instSpawnStart);
    if (expectedBundler) {
      assert(
        handshake.bundler === expectedBundler,
        `Expected handshake.bundler=${expectedBundler}, got ${handshake.bundler}`
      );
    }

    const instReady = await waitForHttpReady(`http://127.0.0.1:${instPort}/`, {
      timeoutMs: 60000,
      proc: instProc
    });
    const instColdMs = Math.round(performance.now() - instSpawnStart);
    assert(instReady.status === 200, `Instrumented GET / returned ${instReady.status}`);

    // Verify SSR HTML has data-cc-src from app RSC, app client component, AND workspace @acme/ui!
    const html = instReady.body;
    const hasAppPageStamp = html.includes('data-cc-src="apps/web/app/page.tsx:');
    const hasClientCounterStamp = html.includes('data-cc-src="apps/web/app/components/Counter.tsx:');
    const hasWorkspaceUiStamp = html.includes('data-cc-src="packages/ui/src/Button.tsx:');
    assert(hasAppPageStamp, `Missing app/page.tsx data-cc-src stamp in HTML`);
    assert(hasClientCounterStamp, `Missing Counter.tsx data-cc-src stamp in HTML`);
    assert(hasWorkspaceUiStamp, `Missing workspace @acme/ui Button.tsx data-cc-src stamp in HTML`);

    // Verify Edge Runtime route works with __cc inline prelude (no ReferenceError)
    const edgeRes = await fetch(`http://127.0.0.1:${instPort}/api/edge`);
    assert(edgeRes.status === 200, `Edge route /api/edge returned ${edgeRes.status}`);
    const edgeJson = await edgeRes.json();
    assert(edgeJson.ok === true && edgeJson.badge === 'edge-ok', `Unexpected edge JSON: ${JSON.stringify(edgeJson)}`);

    // Verify side-by-side coexistence if enabled
    let sideBySideOk = null;
    if (sideBySideDevServer && baseProc) {
      const baseRes2 = await fetch(`http://127.0.0.1:${basePort}/`);
      const baseBody2 = await baseRes2.text();
      sideBySideOk = baseRes2.status === 200 && !baseBody2.includes('data-cc-src=');
      assert(sideBySideOk, 'Side-by-side uninstrumented dev server failed or got contaminated');
    }

    // Measure warm request latency + RSS
    const reqStart = performance.now();
    const warmReq = await fetch(`http://127.0.0.1:${instPort}/`);
    await warmReq.text();
    const warmSsrMs = Math.round((performance.now() - reqStart) * 10) / 10;
    const serverRssMb = readRssMb(handshake.pid);

    // Verify private distDir populated and next-env.d.ts + tsconfig.json UNTOUCHED
    const privateNextDir = path.join(appDir, '.codecanvas', 'cache', 'next');
    assert(fs.existsSync(privateNextDir), 'Private distDir .codecanvas/cache/next was not created');

    const statusWhileRunning = gitStatusPorcelain(wsDir)
      .split('\n')
      .filter((l) => l && !l.includes('.codecanvas/') && !l.includes('.cc-audit.jsonl'))
      .join('\n');
    assert(
      statusWhileRunning === '',
      `Dirty git status outside .codecanvas/ while running:\n${statusWhileRunning}`
    );

    // Optional warm restart measurement (reusing .codecanvas/cache/next)
    let instWarmBootMs = null;
    if (measureWarm) {
      await instProc.stop();
      instProc = null;
      daemon.handshakes.length = 0;
      const warmPort = await allocatePort();
      const warmStart = performance.now();
      instProc = spawnManaged('pnpm', cmdArgs.map((a) => (a === String(instPort) ? String(warmPort) : a)), {
        cwd: useWorkspaceFilter ? wsDir : appDir,
        env
      });
      await daemon.waitForHandshake(30000);
      const warmReady = await waitForHttpReady(`http://127.0.0.1:${warmPort}/`, {
        timeoutMs: 60000,
        proc: instProc
      });
      assert(warmReady.status === 200, `Warm restart returned ${warmReady.status}`);
      instWarmBootMs = Math.round(performance.now() - warmStart);
    }

    // Stop servers and verify uninstall (`rm -rf .codecanvas`) leaves git status 100% clean
    await instProc.stop();
    instProc = null;
    if (baseProc) {
      await baseProc.stop();
      baseProc = null;
    }

    const auditEntries = readAuditLog(auditLog);
    fs.rmSync(auditLog, { force: true });
    fs.rmSync(ccDir, { recursive: true, force: true });

    const finalStatus = gitStatusPorcelain(wsDir);
    assert(finalStatus === '', `Dirty git status after rm -rf .codecanvas:\n${finalStatus}`);

    const activeCount = auditEntries.filter((e) => e.active).length;
    const skippedCount = auditEntries.filter((e) => !e.active).length;
    const overheadMs = instColdMs - baseColdMs;
    const overheadPct = Math.round((overheadMs / Math.max(1, baseColdMs)) * 1000) / 10;

    record(label, {
      ok: true,
      framework: 'next',
      version: handshake.version,
      bundler: handshake.bundler,
      configMode,
      baseColdMs,
      instColdMs,
      instWarmBootMs,
      overheadMs,
      overheadPct,
      handshakeMs,
      runtimeCopyMs,
      warmSsrMs,
      serverRssMb,
      hasAppPageStamp,
      hasClientCounterStamp,
      hasWorkspaceUiStamp,
      edgeRouteOk: true,
      sideBySideOk,
      devLockExistsDuringRun,
      activeProcesses: activeCount,
      skippedProcesses: skippedCount,
      gitStatusClean: true,
      summary: `next@${handshake.version} (${handshake.bundler}): base=${baseColdMs}ms, inst=${instColdMs}ms (${overheadMs >= 0 ? '+' : ''}${overheadMs}ms / ${overheadPct}%), handshake=${handshakeMs}ms, warmSSR=${warmSsrMs}ms, RSS=${serverRssMb}MB, skipped=${skippedCount}, git=clean`
    });
  } catch (err) {
    record(label, {
      ok: false,
      error: err.message,
      stdout: instProc?.stdout?.slice(-1200),
      stderr: instProc?.stderr?.slice(-1200)
    });
  } finally {
    if (instProc) await instProc.stop();
    if (baseProc) await baseProc.stop();
    if (daemon) await daemon.close();
  }
}

/**
 * Negative proof (§3.1 ⚑S1): Verify what happens when Turbopack is given a loader path
 * OUTSIDE the workspace/project root (as opposed to copying runtime into .codecanvas/cache/runtime/).
 */
async function runNextExternalLoaderProbe(nextVersion, scriptName) {
  const label = `next${nextVersion.split('.')[0]}-turbopack-external-loader-probe`;
  const wsDir = path.join(WORK_ROOT, label);
  const { appDir } = createNextMonorepoFixture(wsDir, { nextVersion, configMode: 'ts' });

  // Copy loader completely OUTSIDE wsDir
  const externalDir = path.join(WORK_ROOT, `external-loader-outside-repo-${nextVersion}`);
  fs.mkdirSync(externalDir, { recursive: true });
  for (const file of fs.readdirSync(RUNTIME_SRC_DIR)) {
    fs.copyFileSync(path.join(RUNTIME_SRC_DIR, file), path.join(externalDir, file));
  }
  const externalLoaderPath = path.join(externalDir, 'next-loader.cjs');

  let proc = null;
  let daemon = null;
  try {
    copyRuntimeToAppCache(appDir, { createTsconfig: true });
    daemon = await startHandshakeDaemon();
    const port = await allocatePort();

    proc = spawnManaged('pnpm', ['run', scriptName, '-p', String(port), '-H', '127.0.0.1'], {
      cwd: appDir,
      env: {
        CI: '1',
        NEXT_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: buildNodeOptions(process.env.NODE_OPTIONS || ''),
        CC_TARGET_FRAMEWORK: 'next',
        CC_APP_ROOT: appDir,
        CC_WORKSPACE_ROOT: wsDir,
        CC_FORCE_LOADER_PATH: externalLoaderPath,
        CC_DIST_DIR: '.codecanvas/cache/next',
        CC_TSCONFIG_PATH: '.codecanvas/cache/tsconfig.json',
        CC_TRANSPILE_PACKAGES: JSON.stringify(['@acme/ui']),
        CC_DAEMON_URL: daemon.url,
        CC_DAEMON_TOKEN: daemon.token
      }
    });

    await daemon.waitForHandshake(25000);
    let readyRes = null;
    let errorMsg = null;
    try {
      readyRes = await waitForHttpReady(`http://127.0.0.1:${port}/`, {
        timeoutMs: 25000,
        proc
      });
    } catch (e) {
      errorMsg = e.message;
    }

    const combinedOutput = `${proc.stdout}\n${proc.stderr}`;
    const rejectedOutsideRoot =
      Boolean(errorMsg) ||
      (readyRes && readyRes.status >= 500) ||
      /outside|not found|Unable to resolve|Failed to resolve|Module not found/i.test(
        combinedOutput + (readyRes?.body || '')
      );
    const stamped = Boolean(readyRes?.body?.includes('data-cc-src='));

    record(label, {
      ok: true, // Informational probe — passes regardless, records exact Turbopack behavior!
      externalLoaderPath,
      httpStatus: readyRes?.status ?? null,
      stampedWithExternalPath: stamped,
      rejectedOutsideRoot,
      excerpt: (combinedOutput + (readyRes?.body || '')).slice(0, 500).replace(/\s+/g, ' '),
      summary: rejectedOutsideRoot
        ? `Turbopack rejected external loader path (status=${readyRes?.status ?? 'exit/timeout'}) — confirms .codecanvas/cache/runtime copy is REQUIRED`
        : `Turbopack loaded external path (status=${readyRes?.status}, stamped=${stamped}) — runtime copy still recommended for portability`
    });
  } catch (err) {
    record(label, { ok: false, error: err.message });
  } finally {
    if (proc) await proc.stop();
    if (daemon) await daemon.close();
  }
}

/**
 * Failure-mode proof (§3.4): When a root orchestrator (like `turbo dev` strict env) strips NODE_OPTIONS,
 * the daemon handshake MUST time out and fail loudly rather than silently running uninstrumented.
 */
async function runOrchestratorStrippedEnvTest() {
  const label = 'orchestrator-stripped-env-fail-loudly';
  const wsDir = path.join(WORK_ROOT, label);
  const { appDir } = createNextMonorepoFixture(wsDir, { nextVersion: '16.4.6', configMode: 'ts' });

  let proc = null;
  let daemon = null;
  try {
    const { runtimeDir } = copyRuntimeToAppCache(appDir, { createTsconfig: true });
    daemon = await startHandshakeDaemon();
    const port = await allocatePort();

    proc = spawnManaged('pnpm', ['run', 'dev:turbo-strict', '-p', String(port), '-H', '127.0.0.1'], {
      cwd: wsDir,
      env: {
        CI: '1',
        NEXT_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: buildNodeOptions(process.env.NODE_OPTIONS || ''),
        CC_TARGET_FRAMEWORK: 'next',
        CC_APP_ROOT: appDir,
        CC_WORKSPACE_ROOT: wsDir,
        CC_RUNTIME_DIR: runtimeDir,
        CC_DAEMON_URL: daemon.url,
        CC_DAEMON_TOKEN: daemon.token
      }
    });

    let caughtTimeout = false;
    let timeoutError = '';
    try {
      await daemon.waitForHandshake(4000);
    } catch (err) {
      caughtTimeout = err.message.includes('handshake timeout');
      timeoutError = err.message;
    }

    assert(caughtTimeout, 'Expected handshake timeout when orchestrator strips NODE_OPTIONS');
    assert(daemon.handshakes.length === 0, 'Expected 0 handshakes when NODE_OPTIONS was stripped');

    record(label, {
      ok: true,
      caughtTimeout,
      handshakesReceived: daemon.handshakes.length,
      timeoutError,
      summary: 'Orchestrator stripping NODE_OPTIONS failed loudly on handshake timeout (0 silent uninstrumented boots)'
    });
  } catch (err) {
    record(label, { ok: false, error: err.message });
  } finally {
    if (proc) await proc.stop();
    if (daemon) await daemon.close();
  }
}

async function runViteScenario({
  label,
  viteVersion,
  pluginReactVersion,
  reactVersion = '19.3.1',
  configMode = 'ts-object',
  scriptName = 'dev',
  useWorkspaceFilter = false,
  sideBySideDevServer = false
}) {
  const wsDir = path.join(WORK_ROOT, label.replace(/[^a-z0-9-]/gi, '-').toLowerCase());
  const { appDir } = createViteMonorepoFixture(wsDir, {
    viteVersion,
    pluginReactVersion,
    reactVersion,
    configMode
  });

  let baseProc = null;
  let instProc = null;
  let daemon = null;
  const auditLog = path.join(wsDir, '.cc-audit.jsonl');

  try {
    // 1. Baseline uninstrumented Vite boot
    const basePort = await allocatePort();
    const baseSpawnStart = performance.now();
    baseProc = spawnManaged('pnpm', ['run', scriptName, '--port', String(basePort), '--host', '127.0.0.1', '--strictPort'], {
      cwd: appDir,
      env: { CI: '1' }
    });
    const baseReady = await waitForHttpReady(`http://127.0.0.1:${basePort}/`, {
      timeoutMs: 30000,
      proc: baseProc
    });
    const baseColdMs = Math.round(performance.now() - baseSpawnStart);
    assert(baseReady.status === 200, `Baseline Vite returned ${baseReady.status}`);

    const baseProbe = await probeViteServer(`http://127.0.0.1:${basePort}`, wsDir);
    assert(!baseProbe.appCode.includes('data-cc-src'), 'Baseline Vite App.tsx must not contain data-cc-src');

    if (!sideBySideDevServer) {
      await baseProc.stop();
      baseProc = null;
      fs.rmSync(path.join(appDir, 'node_modules', '.vite'), { recursive: true, force: true });
      fs.rmSync(path.join(wsDir, 'node_modules', '.vite'), { recursive: true, force: true });
    }

    const beforeStatus = gitStatusPorcelain(wsDir);
    assert(beforeStatus === '', `Expected clean git status before Vite instrumented launch, got: ${beforeStatus}`);

    // 2. Copy runtime into <appRoot>/.codecanvas/cache/runtime/<version>/
    const { ccDir, runtimeDir } = copyRuntimeToAppCache(appDir, { createTsconfig: false });
    const privateCacheDir = path.join(appDir, '.codecanvas', 'cache', 'vite');

    // 3. Start handshake daemon
    daemon = await startHandshakeDaemon();

    // 4. Launch app's OWN dev script with NODE_OPTIONS=--import=...
    const instPort = await allocatePort();
    const env = {
      CI: '1',
      NODE_OPTIONS: buildNodeOptions(process.env.NODE_OPTIONS || ''),
      CC_TARGET_FRAMEWORK: 'vite',
      CC_APP_ROOT: appDir,
      CC_WORKSPACE_ROOT: wsDir,
      CC_RUNTIME_DIR: runtimeDir,
      CC_CACHE_DIR: privateCacheDir,
      CC_DAEMON_URL: daemon.url,
      CC_DAEMON_TOKEN: daemon.token,
      CC_AUDIT_LOG: auditLog
    };

    const cmdArgs = useWorkspaceFilter
      ? ['--filter', '@acme/vite-web', 'run', scriptName, '--port', String(instPort), '--host', '127.0.0.1', '--strictPort']
      : ['run', scriptName, '--port', String(instPort), '--host', '127.0.0.1', '--strictPort'];

    const instSpawnStart = performance.now();
    instProc = spawnManaged('pnpm', cmdArgs, {
      cwd: useWorkspaceFilter ? wsDir : appDir,
      env
    });

    const handshake = await daemon.waitForHandshake(25000);
    const handshakeMs = Math.round(performance.now() - instSpawnStart);

    const instReady = await waitForHttpReady(`http://127.0.0.1:${instPort}/`, {
      timeoutMs: 30000,
      proc: instProc
    });
    const instColdMs = Math.round(performance.now() - instSpawnStart);
    assert(instReady.status === 200, `Instrumented Vite GET / returned ${instReady.status}`);

    // Probe transformed modules + CSS devSourcemap
    const instProbe = await probeViteServer(`http://127.0.0.1:${instPort}`, wsDir);

    const hasAppStamp =
      instProbe.appCode.includes('data-cc-src') &&
      instProbe.appCode.includes('apps/web/src/App.tsx:') &&
      instProbe.appCode.includes('__ccNoop');
    const hasWorkspaceStamp =
      instProbe.buttonCode.includes('data-cc-src') &&
      instProbe.buttonCode.includes('packages/ui/src/Button.tsx:') &&
      instProbe.buttonCode.includes('__ccNoop');
    const hasCssSourcemap =
      handshake.devSourcemap === true &&
      instProbe.cssCode.includes('sourceMappingURL=data:application/json;base64,');

    assert(hasAppStamp, `Missing App.tsx data-cc-src or __cc prelude in Vite transform:\n${instProbe.appCode.slice(0, 600)}`);
    assert(hasWorkspaceStamp, `Missing workspace Button.tsx data-cc-src in Vite transform:\n${instProbe.buttonCode.slice(0, 600)}`);
    assert(hasCssSourcemap, `Missing inline CSS devSourcemap in App.css:\n${instProbe.cssCode.slice(0, 600)}`);

    // Verify private cacheDir was populated and default node_modules/.vite was NOT created (when not side-by-side)
    assert(fs.existsSync(privateCacheDir), `Private cacheDir ${privateCacheDir} not created`);
    const defaultViteCacheCreated = !sideBySideDevServer && fs.existsSync(path.join(appDir, 'node_modules', '.vite'));
    assert(!defaultViteCacheCreated, 'Default node_modules/.vite was created despite private cacheDir!');

    // Side-by-side check (proves Vite 8 commandLockPlugin lock isolation!)
    let sideBySideOk = null;
    if (sideBySideDevServer && baseProc) {
      const baseRes2 = await fetch(`http://127.0.0.1:${basePort}/src/App.tsx`);
      const baseCode2 = await baseRes2.text();
      sideBySideOk = baseRes2.status === 200 && !baseCode2.includes('data-cc-src');
      assert(sideBySideOk, 'Side-by-side developer Vite server failed or got contaminated');
    }

    const serverRssMb = readRssMb(handshake.pid);

    // Stop servers and verify clean git status after rm -rf .codecanvas
    await instProc.stop();
    instProc = null;
    if (baseProc) {
      await baseProc.stop();
      baseProc = null;
    }

    const auditEntries = readAuditLog(auditLog);
    fs.rmSync(auditLog, { force: true });
    fs.rmSync(ccDir, { recursive: true, force: true });

    const finalStatus = gitStatusPorcelain(wsDir);
    assert(finalStatus === '', `Dirty git status after Vite teardown:\n${finalStatus}`);

    const activeCount = auditEntries.filter((e) => e.active).length;
    const skippedCount = auditEntries.filter((e) => !e.active).length;
    const overheadMs = instColdMs - baseColdMs;
    const overheadPct = Math.round((overheadMs / Math.max(1, baseColdMs)) * 1000) / 10;

    record(label, {
      ok: true,
      framework: 'vite',
      version: handshake.version,
      configMode,
      hookMode: handshake.hookMode,
      baseColdMs,
      instColdMs,
      overheadMs,
      overheadPct,
      handshakeMs,
      serverRssMb,
      hasAppStamp,
      hasWorkspaceStamp,
      hasCssSourcemap,
      privateCachePopulated: true,
      defaultViteCacheUntouched: !defaultViteCacheCreated,
      sideBySideOk,
      activeProcesses: activeCount,
      skippedProcesses: skippedCount,
      gitStatusClean: true,
      summary: `vite@${handshake.version} (${configMode}/${handshake.hookMode}): base=${baseColdMs}ms, inst=${instColdMs}ms (${overheadMs >= 0 ? '+' : ''}${overheadMs}ms / ${overheadPct}%), handshake=${handshakeMs}ms, cssMap=ok, RSS=${serverRssMb}MB, skipped=${skippedCount}, git=clean`
    });
  } catch (err) {
    record(label, {
      ok: false,
      error: err.message,
      stdout: instProc?.stdout?.slice(-1200),
      stderr: instProc?.stderr?.slice(-1200)
    });
  } finally {
    if (instProc) await instProc.stop();
    if (baseProc) await baseProc.stop();
    if (daemon) await daemon.close();
  }
}

async function main() {
  console.log(`=== Spike S1: Preload Instrumentation Harness (${RUN_ID}) ===`);
  console.log(`Node ${process.version}, platform ${process.platform}/${process.arch}, workdir ${WORK_ROOT}\n`);

  // --- Next.js 15 & 16 matrix ---
  await runNextScenario({
    label: 'next15-webpack-monorepo',
    nextVersion: '15.5.29',
    scriptName: 'dev',
    configMode: 'ts',
    useWorkspaceFilter: true,
    expectedBundler: 'webpack'
  });

  await runNextScenario({
    label: 'next15-turbopack-monorepo',
    nextVersion: '15.5.29',
    scriptName: 'dev:turbopack',
    configMode: 'ts',
    useWorkspaceFilter: true,
    expectedBundler: 'turbopack'
  });

  await runNextScenario({
    label: 'next16-turbopack-monorepo-side-by-side',
    nextVersion: '16.4.6',
    scriptName: 'dev',
    configMode: 'ts',
    useWorkspaceFilter: true,
    sideBySideDevServer: true,
    measureWarm: true,
    expectedBundler: 'turbopack'
  });

  await runNextScenario({
    label: 'next16-webpack-monorepo',
    nextVersion: '16.4.6',
    scriptName: 'dev:webpack',
    configMode: 'ts',
    useWorkspaceFilter: true,
    expectedBundler: 'webpack'
  });

  await runNextScenario({
    label: 'next16-async-mjs-config-wrapped-script',
    nextVersion: '16.4.6',
    scriptName: 'dev:wrapped',
    configMode: 'mjs-async-fn',
    useWorkspaceFilter: false,
    withExistingAgentsMd: true,
    expectedBundler: 'turbopack'
  });

  await runNextScenario({
    label: 'next16-no-config-file',
    nextVersion: '16.4.6',
    scriptName: 'dev',
    configMode: 'none',
    useWorkspaceFilter: false,
    expectedBundler: 'turbopack'
  });

  await runNextExternalLoaderProbe('15.5.29', 'dev:turbopack');
  await runNextExternalLoaderProbe('16.4.6', 'dev');
  await runOrchestratorStrippedEnvTest();

  // --- Vite 5, 6, 7, 8 matrix ---
  await runViteScenario({
    label: 'vite5-ts-object-monorepo',
    viteVersion: '5.4.21',
    pluginReactVersion: '4.7.0',
    reactVersion: '18.3.1',
    configMode: 'ts-object',
    useWorkspaceFilter: true
  });

  await runViteScenario({
    label: 'vite6-ts-object-monorepo',
    viteVersion: '6.4.6',
    pluginReactVersion: '4.7.0',
    reactVersion: '19.3.1',
    configMode: 'ts-object',
    useWorkspaceFilter: true
  });

  await runViteScenario({
    label: 'vite7-ts-fn-monorepo',
    viteVersion: '7.3.8',
    pluginReactVersion: '5.2.0',
    reactVersion: '19.3.1',
    configMode: 'ts-fn',
    useWorkspaceFilter: true
  });

  await runViteScenario({
    label: 'vite8-ts-object-side-by-side',
    viteVersion: '8.4.0',
    pluginReactVersion: '6.3.0',
    reactVersion: '19.3.1',
    configMode: 'ts-object',
    useWorkspaceFilter: true,
    sideBySideDevServer: true
  });

  await runViteScenario({
    label: 'vite8-wrapped-script-async-fn',
    viteVersion: '8.4.0',
    pluginReactVersion: '6.3.0',
    reactVersion: '19.3.1',
    configMode: 'ts-fn',
    scriptName: 'dev:wrapped',
    useWorkspaceFilter: false
  });

  await runViteScenario({
    label: 'vite8-no-config-file',
    viteVersion: '8.4.0',
    pluginReactVersion: '6.3.0',
    reactVersion: '19.3.1',
    configMode: 'none',
    useWorkspaceFilter: false
  });

  const outJsonPath = path.join(WORK_ROOT, 'results.json');
  fs.writeFileSync(outJsonPath, JSON.stringify({ runId: RUN_ID, node: process.version, results }, null, 2));

  console.log(`\n=== Summary: ${results.length - failures}/${results.length} passed ===`);
  console.log(`Raw results written to: ${outJsonPath}`);

  if (process.env.S1_KEEP_TMP !== '1') {
    // Clean fixture directories (keep results.json if requested via --json-out)
    if (process.argv.includes('--json-out')) {
      const idx = process.argv.indexOf('--json-out');
      const dest = process.argv[idx + 1];
      if (dest) fs.copyFileSync(outJsonPath, dest);
    }
    fs.rmSync(WORK_ROOT, { recursive: true, force: true });
  }

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal runner error:', err);
  process.exit(1);
});
