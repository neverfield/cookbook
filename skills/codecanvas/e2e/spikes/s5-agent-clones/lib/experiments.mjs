import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  applyPatchInClone,
  copyEnvFilesSafely,
  createFullClone,
  createSharedClone,
  createWorktree,
  getGitStatusPorcelain,
  measureDirStats,
  measureIncrementalDiskKb,
  removeWorktree,
} from './clone-ops.mjs';
import {
  allocatePort,
  httpGet,
  releasePort,
  runCommand,
  spawnServer,
  waitForHttpOk,
} from './process-mgr.mjs';

function summarizeNumbers(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return {
    min: Number(sorted[0].toFixed(1)),
    median: Number(median.toFixed(1)),
    mean: Number(mean.toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1)),
    samples: sorted.map((v) => Number(v.toFixed(1))),
  };
}

function makeChangeSetPatch(markerValue) {
  return `diff --git a/apps/web/src/lib/marker.ts b/apps/web/src/lib/marker.ts
index 1111111..2222222 100644
--- a/apps/web/src/lib/marker.ts
+++ b/apps/web/src/lib/marker.ts
@@ -1 +1 @@
-export const APP_MARKER = 'PARENT_ORIGIN';
+export const APP_MARKER = '${markerValue}';
`;
}

async function replaceInFile(filePath, searchValue, replacementValue) {
  const before = await fs.readFile(filePath, 'utf8');
  if (!before.includes(searchValue)) {
    throw new Error(`Expected "${searchValue}" in ${filePath}`);
  }
  await fs.writeFile(filePath, before.replaceAll(searchValue, replacementValue), 'utf8');
}

async function setCloneSentinels(cloneDir, label) {
  await Promise.all([
    replaceInFile(
      path.join(cloneDir, 'packages/ui/src/Sentinel.tsx'),
      'PARENT_ORIGIN',
      label,
    ),
    replaceInFile(
      path.join(cloneDir, 'packages/shared/src/catalog.ts'),
      'PARENT_ORIGIN',
      label,
    ),
    replaceInFile(
      path.join(cloneDir, 'apps/web/src/lib/marker.ts'),
      'PARENT_ORIGIN',
      label,
    ),
  ]);
}

function extractLockfileWarnings(output) {
  const lines = output.split('\n');
  const warnings = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/lockfile|inferred your workspace root|turbopack\.root|root directory/i.test(lines[i])) {
      let start = i;
      while (start > 0 && lines[start - 1].trim() !== '' && !/^(▲|✓|- )/.test(lines[start - 1].trim())) {
        start -= 1;
      }
      let end = i;
      while (end + 1 < lines.length && lines[end + 1].trim() !== '') {
        end += 1;
      }
      const block = lines
        .slice(start, end + 1)
        .map((l) => l.trimEnd())
        .join('\n')
        .trim();
      if (block && !warnings.includes(block)) {
        warnings.push(block);
      }
      i = end;
    }
  }
  return warnings;
}

async function startNextDevServer(cloneDir, options = {}) {
  const {
    turbopackRoot = null,
    distDir = null,
    cpuList = null,
    port: providedPort = null,
  } = options;

  const port = providedPort ?? (await allocatePort());
  const appDir = path.join(cloneDir, 'apps/web');
  const nextBin = path.join(appDir, 'node_modules/.bin/next');

  const env = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    PORT: String(port),
  };
  if (turbopackRoot) {
    env.CC_TURBOPACK_ROOT = turbopackRoot;
  } else {
    delete env.CC_TURBOPACK_ROOT;
  }
  if (distDir) {
    env.CC_DIST_DIR = distDir;
  } else {
    delete env.CC_DIST_DIR;
  }

  const server = spawnServer(
    nextBin,
    ['dev', '--turbopack', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: appDir,
      env,
      cpuList,
    },
  );

  try {
    const ready = await server.waitForLog(/Ready in\s+[^\n]+/i, 90_000);
    return {
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      server,
      readyMs: ready.elapsedMs,
      readyLine: ready.match,
      stop: async () => {
        await server.stop();
        if (!providedPort) releasePort(port);
      },
    };
  } catch (err) {
    await server.stop();
    if (!providedPort) releasePort(port);
    throw err;
  }
}

export async function runExperimentA(parentDir, scratchRoot, trials = 3) {
  const parentGitStats = await measureDirStats(path.join(parentDir, '.git'));
  const parentTotalStats = await measureDirStats(parentDir);

  const sharedTimes = [];
  let sharedSampleStats = null;
  let sharedGitStats = null;
  let sharedIncremental = null;
  let sharedInfo = null;
  let patchApplyMs = null;
  let parentCleanAfterPatch = false;

  for (let i = 0; i < trials; i += 1) {
    const dest = path.join(scratchRoot, `expA-shared-${i}`);
    try {
      const info = await createSharedClone(parentDir, dest);
      sharedTimes.push(info.elapsedMs);
      if (i === 0) {
        sharedInfo = info;
        sharedSampleStats = await measureDirStats(dest);
        sharedGitStats = await measureDirStats(path.join(dest, '.git'));
        sharedIncremental = await measureIncrementalDiskKb(parentDir, dest);
        const patchRes = await applyPatchInClone(dest, makeChangeSetPatch('PATCHED_IN_CLONE'));
        patchApplyMs = patchRes.elapsedMs;
        const parentStatus = await getGitStatusPorcelain(parentDir);
        parentCleanAfterPatch = parentStatus === '';
      }
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  }

  // Nested shared clone inside .codecanvas/cache/clones/ — verify parent git status remains clean
  const nestedDest = path.join(parentDir, '.codecanvas/cache/clones/expA-nested');
  let nestedElapsedMs = 0;
  let parentCleanWithNestedClone = false;
  try {
    const nestedInfo = await createSharedClone(parentDir, nestedDest);
    nestedElapsedMs = nestedInfo.elapsedMs;
    const parentStatus = await getGitStatusPorcelain(parentDir);
    parentCleanWithNestedClone = parentStatus === '';
  } finally {
    await fs.rm(nestedDest, { recursive: true, force: true });
  }

  // Git worktree comparison
  const worktreeTimes = [];
  let worktreeSampleStats = null;
  let worktreeInfo = null;
  for (let i = 0; i < trials; i += 1) {
    const dest = path.join(scratchRoot, `expA-worktree-${i}`);
    try {
      const info = await createWorktree(parentDir, dest);
      worktreeTimes.push(info.elapsedMs);
      if (i === 0) {
        worktreeInfo = info;
        worktreeSampleStats = await measureDirStats(dest);
      }
    } finally {
      await removeWorktree(parentDir, dest);
    }
  }

  // Full clone (--no-hardlinks) baseline
  const fullDest = path.join(scratchRoot, 'expA-full-clone');
  let fullCloneResult = null;
  try {
    const info = await createFullClone(parentDir, fullDest);
    const totalStats = await measureDirStats(fullDest);
    const gitStats = await measureDirStats(path.join(fullDest, '.git'));
    const incremental = await measureIncrementalDiskKb(parentDir, fullDest);
    fullCloneResult = {
      elapsedMs: Number(info.elapsedMs.toFixed(1)),
      hasOwnGitDir: info.hasOwnGitDir,
      totalStats,
      gitStats,
      incremental,
    };
  } finally {
    await fs.rm(fullDest, { recursive: true, force: true });
  }

  return {
    parentGitStats,
    parentTotalStats,
    sharedClone: {
      timingMs: summarizeNumbers(sharedTimes),
      hasOwnGitDir: sharedInfo.hasOwnGitDir,
      alternatesPointsToParent: sharedInfo.alternatesContent.includes(path.join(parentDir, '.git/objects')),
      totalStats: sharedSampleStats,
      gitStats: sharedGitStats,
      incremental: sharedIncremental,
      patchApplyMs: Number(patchApplyMs.toFixed(1)),
      parentCleanAfterPatch,
      nestedElapsedMs: Number(nestedElapsedMs.toFixed(1)),
      parentCleanWithNestedClone,
    },
    worktree: {
      timingMs: summarizeNumbers(worktreeTimes),
      hasOwnGitDir: worktreeInfo.hasOwnGitDir,
      gitPointer: worktreeInfo.gitPointer,
      totalStats: worktreeSampleStats,
    },
    fullClone: fullCloneResult,
  };
}

export async function runExperimentB(parentDir, scratchRoot, trials = 3) {
  const pnpmStrategies = [
    {
      id: 'pnpm-prefer-offline',
      args: ['install', '--frozen-lockfile', '--prefer-offline'],
    },
    {
      id: 'pnpm-offline',
      args: ['install', '--frozen-lockfile', '--offline'],
    },
    {
      id: 'pnpm-offline-ignore-scripts',
      args: ['install', '--frozen-lockfile', '--offline', '--ignore-scripts'],
    },
  ];

  const results = {};

  for (const strategy of pnpmStrategies) {
    const durations = [];
    let diskStats = null;
    let incremental = null;
    let workspaceUiRealpathIsolated = false;

    for (let i = 0; i < trials; i += 1) {
      const dest = path.join(scratchRoot, `expB-${strategy.id}-${i}`);
      try {
        await createSharedClone(parentDir, dest);
        const res = await runCommand('pnpm', strategy.args, { cwd: dest });
        durations.push(res.elapsedMs);

        if (i === 0) {
          diskStats = await measureDirStats(dest);
          incremental = await measureIncrementalDiskKb(parentDir, dest);
          const uiLink = path.join(dest, 'apps/web/node_modules/@fixture/ui');
          const resolvedUi = await fs.realpath(uiLink);
          const cloneReal = await fs.realpath(dest);
          workspaceUiRealpathIsolated = resolvedUi.startsWith(cloneReal + path.sep);
        }
      } finally {
        await fs.rm(dest, { recursive: true, force: true });
      }
    }

    results[strategy.id] = {
      command: `pnpm ${strategy.args.join(' ')}`,
      timingMs: summarizeNumbers(durations),
      cloneDiskStats: diskStats,
      incrementalDiskRelativeToParent: incremental,
      workspaceUiRealpathIsolated,
    };
  }

  // Strategy 4: cp -al (hardlink copy of node_modules) + isolation check + reflink capability check
  const cpAlDest = path.join(scratchRoot, 'expB-cp-al');
  let cpAlResult = null;
  try {
    await createSharedClone(parentDir, cpAlDest);
    const nodeModulesLocations = [
      'node_modules',
      'apps/web/node_modules',
      'packages/ui/node_modules',
      'packages/shared/node_modules',
    ];
    const startedAt = performance.now();
    for (const rel of nodeModulesLocations) {
      const src = path.join(parentDir, rel);
      const dst = path.join(cpAlDest, rel);
      await runCommand('cp', ['-al', src, dst]);
    }
    const elapsedMs = performance.now() - startedAt;

    // Prove why raw hardlink copy of parent node_modules breaks isolation:
    // check inode equality of a file inside node_modules
    const parentNextPkg = await fs.stat(path.join(parentDir, 'apps/web/node_modules/next/package.json'));
    const cloneNextPkg = await fs.stat(path.join(cpAlDest, 'apps/web/node_modules/next/package.json'));
    const sharesInodeWithParent = parentNextPkg.ino === cloneNextPkg.ino;

    // Check if filesystem supports CoW reflinks (cp --reflink=always)
    const reflinkProbeSrc = path.join(scratchRoot, 'reflink-probe-src');
    const reflinkProbeDst = path.join(scratchRoot, 'reflink-probe-dst');
    await fs.writeFile(reflinkProbeSrc, 'probe', 'utf8');
    const reflinkRes = await runCommand(
      'cp',
      ['--reflink=always', reflinkProbeSrc, reflinkProbeDst],
      { allowFailure: true },
    );
    await Promise.all([
      fs.rm(reflinkProbeSrc, { force: true }),
      fs.rm(reflinkProbeDst, { force: true }),
    ]);

    cpAlResult = {
      elapsedMs: Number(elapsedMs.toFixed(1)),
      sharesInodeWithParent,
      filesystemSupportsReflink: reflinkRes.code === 0,
      isolationSafe: !sharesInodeWithParent,
      reason: sharesInodeWithParent
        ? 'Hardlinked files share inodes directly with parent node_modules; in-place writes corrupt parent'
        : 'Copy-on-write isolated',
    };
  } finally {
    await fs.rm(cpAlDest, { recursive: true, force: true });
  }

  // Strategy 5: Symlink node_modules -> parent (demonstrates why §8.3 forbids linking)
  const symlinkDest = path.join(scratchRoot, 'expB-symlink');
  let symlinkResult = null;
  try {
    await createSharedClone(parentDir, symlinkDest);
    const startedAt = performance.now();
    await fs.symlink(path.join(parentDir, 'node_modules'), path.join(symlinkDest, 'node_modules'));
    await fs.symlink(
      path.join(parentDir, 'apps/web/node_modules'),
      path.join(symlinkDest, 'apps/web/node_modules'),
    );
    const elapsedMs = performance.now() - startedAt;

    const resolvedUi = await fs.realpath(path.join(symlinkDest, 'apps/web/node_modules/@fixture/ui'));
    const parentReal = await fs.realpath(parentDir);
    const escapesToParent = resolvedUi.startsWith(parentReal + path.sep);

    symlinkResult = {
      elapsedMs: Number(elapsedMs.toFixed(2)),
      resolvedWorkspaceUiPath: resolvedUi,
      escapesToParent,
      isolationSafe: false,
      reason:
        'Symlinked node_modules causes workspace packages (@fixture/ui) to resolve into parent repo and lets agent package edits mutate parent',
    };
  } finally {
    await fs.rm(symlinkDest, { recursive: true, force: true });
  }

  return {
    pnpmStrategies: results,
    cpHardlinkCopy: cpAlResult,
    symlinkNodeModules: symlinkResult,
  };
}

export async function runExperimentC(parentDir, scratchRoot) {
  const cloneDir = path.join(scratchRoot, 'expC-env-clone');
  const outsideSecretPath = path.join(scratchRoot, 'outside-secret.env');
  const maliciousSymlinkPath = path.join(parentDir, '.env.escape.local');

  await fs.writeFile(outsideSecretPath, 'OUTSIDE_SECRET=must-never-be-copied\n', 'utf8');
  await fs.symlink(outsideSecretPath, maliciousSymlinkPath);

  try {
    await createSharedClone(parentDir, cloneDir);
    const copyRes = await copyEnvFilesSafely(parentDir, cloneDir, {
      searchDirs: ['.', 'apps/web'],
      extraCandidatePaths: ['../outside-secret.env'],
    });

    const cloneStatusAfterCopy = await getGitStatusPorcelain(cloneDir);
    let escapedFileExists = false;
    try {
      await fs.lstat(path.join(cloneDir, '.env.escape.local'));
      escapedFileExists = true;
    } catch {
      escapedFileExists = false;
    }

    const copiedPaths = copyRes.copied.map((item) => item.path);
    const rejectedMap = Object.fromEntries(copyRes.rejected.map((item) => [item.path, item.reason]));
    const skippedMap = Object.fromEntries(copyRes.skipped.map((item) => [item.path, item.reason]));

    const allSecretFilesHave0600 = copyRes.copied
      .filter((item) => item.path.endsWith('.local') || path.basename(item.path) === '.env')
      .every((item) => item.mode === '0600');

    return {
      elapsedMs: Number(copyRes.elapsedMs.toFixed(2)),
      copied: copyRes.copied,
      skipped: skippedMap,
      rejected: rejectedMap,
      assertions: {
        copiedExpectedLocalFiles:
          copiedPaths.includes('.env.local') &&
          copiedPaths.includes('apps/web/.env.local') &&
          copiedPaths.includes('apps/web/.env.development.local'),
        skippedTemplates:
          skippedMap['.env.example'] === 'template-file' &&
          skippedMap['apps/web/.env.example'] === 'template-file',
        rejectedSymlinkEscape:
          rejectedMap['.env.escape.local'] === 'symlink-not-allowed' && !escapedFileExists,
        rejectedPathTraversal:
          rejectedMap['../outside-secret.env'] === 'path-traversal-outside-parent',
        allSecretFilesHave0600,
        cloneGitStatusClean: cloneStatusAfterCopy === '',
      },
    };
  } finally {
    await fs.rm(maliciousSymlinkPath, { force: true });
    await fs.rm(outsideSecretPath, { force: true });
    await fs.rm(cloneDir, { recursive: true, force: true });
  }
}

async function waitForHealthSentinel(baseUrl, expectedSentinel, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  let lastPayload = null;
  while (performance.now() < deadline) {
    const res = await httpGet(`${baseUrl}/api/health`, 10_000);
    if (res.status === 200) {
      lastPayload = JSON.parse(res.body);
      if (lastPayload.uiSentinel === expectedSentinel) {
        return { matched: true, payload: lastPayload };
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { matched: false, payload: lastPayload };
}

export async function runExperimentD(parentDir, scratchRoot) {
  const results = {};

  // D1a: Nested clone under <parent>/.codecanvas/cache/clones/ WITHOUT explicit turbopack.root
  const nestedNaiveDir = path.join(parentDir, '.codecanvas/cache/clones/d1a-naive');
  try {
    await createSharedClone(parentDir, nestedNaiveDir);
    await runCommand('pnpm', ['install', '--frozen-lockfile', '--offline'], { cwd: nestedNaiveDir });
    await copyEnvFilesSafely(parentDir, nestedNaiveDir);
    await setCloneSentinels(nestedNaiveDir, 'NESTED_NAIVE');

    const srv = await startNextDevServer(nestedNaiveDir, {
      turbopackRoot: null,
      distDir: '.codecanvas/cache/next',
    });
    try {
      const healthRes = await waitForHttpOk(`${srv.baseUrl}/api/health`, 45_000);
      const homeRes = await httpGet(`${srv.baseUrl}/`, 45_000);
      const health = JSON.parse(healthRes.body);
      const output = srv.server.getOutput().combined;
      const warnings = extractLockfileWarnings(output);
      const cloneReal = await fs.realpath(nestedNaiveDir);

      results.d1aNestedWithoutExplicitRoot = {
        cloneDir: nestedNaiveDir,
        readyMs: Number(srv.readyMs.toFixed(1)),
        healthStatus: healthRes.status,
        homeStatus: homeRes.status,
        cwdInsideClone: health.cwd.startsWith(cloneReal),
        uiSentinel: health.uiSentinel,
        sharedMarker: health.sharedMarker,
        appMarker: health.appMarker,
        escapedToParent:
          health.uiSentinel !== 'NESTED_NAIVE' ||
          health.sharedMarker !== 'NESTED_NAIVE' ||
          health.appMarker !== 'NESTED_NAIVE',
        homeContainsCloneSentinel: homeRes.body.includes('ui-sentinel:NESTED_NAIVE'),
        env: health.env,
        lockfileOrRootWarnings: warnings,
      };
    } finally {
      await srv.stop();
    }
  } finally {
    await fs.rm(nestedNaiveDir, { recursive: true, force: true });
  }

  // D1b: Nested clone under <parent>/.codecanvas/cache/clones/ WITH explicit turbopack.root
  const nestedExplicitDir = path.join(parentDir, '.codecanvas/cache/clones/d1b-explicit');
  const parentSentinelFile = path.join(parentDir, 'packages/ui/src/Sentinel.tsx');
  const originalParentSentinel = await fs.readFile(parentSentinelFile, 'utf8');
  try {
    await createSharedClone(parentDir, nestedExplicitDir);
    await runCommand('pnpm', ['install', '--frozen-lockfile', '--offline'], { cwd: nestedExplicitDir });
    await copyEnvFilesSafely(parentDir, nestedExplicitDir);
    await setCloneSentinels(nestedExplicitDir, 'NESTED_EXPLICIT');

    const cloneReal = await fs.realpath(nestedExplicitDir);
    const srv = await startNextDevServer(nestedExplicitDir, {
      turbopackRoot: cloneReal,
      distDir: '.codecanvas/cache/next',
    });
    try {
      const healthRes = await waitForHttpOk(`${srv.baseUrl}/api/health`, 45_000);
      const homeRes = await httpGet(`${srv.baseUrl}/`, 45_000);
      const settingsRes = await httpGet(`${srv.baseUrl}/settings`, 45_000);
      const health = JSON.parse(healthRes.body);
      const warnings = extractLockfileWarnings(srv.server.getOutput().combined);

      // Cross-contamination test 1: mutate clone's @fixture/ui and confirm clone updates via HMR
      const hmrStartedAt = performance.now();
      await replaceInFile(
        path.join(nestedExplicitDir, 'packages/ui/src/Sentinel.tsx'),
        'NESTED_EXPLICIT',
        'NESTED_EXPLICIT_HMR',
      );
      const hmrCheck = await waitForHealthSentinel(srv.baseUrl, 'NESTED_EXPLICIT_HMR', 20_000);
      const hmrElapsedMs = performance.now() - hmrStartedAt;

      // Cross-contamination test 2: mutate parent's @fixture/ui temporarily and confirm clone does NOT change
      await replaceInFile(parentSentinelFile, 'PARENT_ORIGIN', 'PARENT_TEMP_MUTATION');
      await new Promise((r) => setTimeout(r, 1200));
      const postParentEditHealth = JSON.parse((await httpGet(`${srv.baseUrl}/api/health`)).body);
      const isolatedFromParentEdit = postParentEditHealth.uiSentinel === 'NESTED_EXPLICIT_HMR';

      results.d1bNestedWithExplicitRoot = {
        cloneDir: nestedExplicitDir,
        turbopackRoot: cloneReal,
        readyMs: Number(srv.readyMs.toFixed(1)),
        cwdInsideClone: health.cwd.startsWith(cloneReal),
        uiSentinel: health.uiSentinel,
        sharedMarker: health.sharedMarker,
        appMarker: health.appMarker,
        homeContainsCloneSentinel: homeRes.body.includes('ui-sentinel:NESTED_EXPLICIT'),
        settingsLoadedSecretAndLocal:
          settingsRes.body.includes('FIXTURE_SERVER_SECRET_SET=true') &&
          settingsRes.body.includes('APP_LOCAL_ENV_MARKER=web-app-local-loaded') &&
          settingsRes.body.includes('FIXTURE_DEV_OVERRIDE=dev-local-active'),
        env: health.env,
        lockfileOrRootWarnings: warnings,
        cloneWorkspaceHmrUpdated: hmrCheck.matched,
        cloneWorkspaceHmrMs: Number(hmrElapsedMs.toFixed(1)),
        isolatedFromParentEdit,
      };
    } finally {
      await fs.writeFile(parentSentinelFile, originalParentSentinel, 'utf8');
      await srv.stop();
    }
  } finally {
    await fs.writeFile(parentSentinelFile, originalParentSentinel, 'utf8');
    await fs.rm(nestedExplicitDir, { recursive: true, force: true });
  }

  // D2: External clone (~/.codecanvas/agents/<repoId>/<task>/) WITHOUT & WITH explicit turbopack.root
  const externalCloneDir = path.join(scratchRoot, 'sim-home/.codecanvas/agents/reelhouse/d2-external');
  try {
    await createSharedClone(parentDir, externalCloneDir);
    await runCommand('pnpm', ['install', '--frozen-lockfile', '--offline'], { cwd: externalCloneDir });
    await copyEnvFilesSafely(parentDir, externalCloneDir);
    await setCloneSentinels(externalCloneDir, 'EXTERNAL_CLONE');
    const cloneReal = await fs.realpath(externalCloneDir);

    // Without explicit turbopack.root
    const srvNaive = await startNextDevServer(externalCloneDir, {
      turbopackRoot: null,
      distDir: '.codecanvas/cache/next',
    });
    let externalWithoutRoot = null;
    try {
      const healthRes = await waitForHttpOk(`${srvNaive.baseUrl}/api/health`, 45_000);
      const health = JSON.parse(healthRes.body);
      externalWithoutRoot = {
        readyMs: Number(srvNaive.readyMs.toFixed(1)),
        uiSentinel: health.uiSentinel,
        sharedMarker: health.sharedMarker,
        appMarker: health.appMarker,
        cwdInsideClone: health.cwd.startsWith(cloneReal),
        lockfileOrRootWarnings: extractLockfileWarnings(srvNaive.server.getOutput().combined),
      };
    } finally {
      await srvNaive.stop();
    }

    // With explicit turbopack.root
    const srvExplicit = await startNextDevServer(externalCloneDir, {
      turbopackRoot: cloneReal,
      distDir: '.codecanvas/cache/next',
    });
    let externalWithRoot = null;
    try {
      const healthRes = await waitForHttpOk(`${srvExplicit.baseUrl}/api/health`, 45_000);
      const health = JSON.parse(healthRes.body);
      externalWithRoot = {
        readyMs: Number(srvExplicit.readyMs.toFixed(1)),
        uiSentinel: health.uiSentinel,
        sharedMarker: health.sharedMarker,
        appMarker: health.appMarker,
        cwdInsideClone: health.cwd.startsWith(cloneReal),
        lockfileOrRootWarnings: extractLockfileWarnings(srvExplicit.server.getOutput().combined),
      };
    } finally {
      await srvExplicit.stop();
    }

    results.d2ExternalClone = {
      withoutExplicitRoot: externalWithoutRoot,
      withExplicitRoot: externalWithRoot,
    };

    // D3: Concurrent Parent Dev Server + External Agent Host Dev Server
    const parentSrv = await startNextDevServer(parentDir, {
      turbopackRoot: await fs.realpath(parentDir),
      distDir: null,
    });
    const cloneSrv = await startNextDevServer(externalCloneDir, {
      turbopackRoot: cloneReal,
      distDir: '.codecanvas/cache/next',
    });
    try {
      const [parentHealthRes, cloneHealthRes, parentHomeRes, cloneHomeRes] = await Promise.all([
        waitForHttpOk(`${parentSrv.baseUrl}/api/health`, 45_000),
        waitForHttpOk(`${cloneSrv.baseUrl}/api/health`, 45_000),
        waitForHttpOk(`${parentSrv.baseUrl}/`, 45_000),
        waitForHttpOk(`${cloneSrv.baseUrl}/`, 45_000),
      ]);
      const parentHealth = JSON.parse(parentHealthRes.body);
      const cloneHealth = JSON.parse(cloneHealthRes.body);

      results.d3ConcurrentParentAndClone = {
        parentPort: parentSrv.port,
        clonePort: cloneSrv.port,
        parentUiSentinel: parentHealth.uiSentinel,
        cloneUiSentinel: cloneHealth.uiSentinel,
        parentHomeStatus: parentHomeRes.status,
        cloneHomeStatus: cloneHomeRes.status,
        fullyIsolated:
          parentHealth.uiSentinel === 'PARENT_ORIGIN' &&
          cloneHealth.uiSentinel === 'EXTERNAL_CLONE' &&
          parentHealth.cwd !== cloneHealth.cwd,
      };
    } finally {
      await Promise.all([parentSrv.stop(), cloneSrv.stop()]);
    }
  } finally {
    await fs.rm(externalCloneDir, { recursive: true, force: true });
    await fs.rm(path.join(parentDir, 'apps/web/.next'), { recursive: true, force: true });
  }

  return results;
}

async function runSingleE2ETrial(parentDir, cloneDir, options) {
  const { installMode, cpuList, label } = options;
  const e2eStartedAt = performance.now();

  try {
    const cloneInfo = await createSharedClone(parentDir, cloneDir, { cpuList });
    const patchInfo = await applyPatchInClone(cloneDir, makeChangeSetPatch(label));

    const pnpmArgs =
      installMode === 'offline'
        ? ['install', '--frozen-lockfile', '--offline']
        : ['install', '--frozen-lockfile', '--prefer-offline'];
    const installRes = await runCommand('pnpm', pnpmArgs, {
      cwd: cloneDir,
      cpuList,
    });

    const envCopyRes = await copyEnvFilesSafely(parentDir, cloneDir);
    const cloneReal = await fs.realpath(cloneDir);

    // Cold agent-host startup
    const coldSrv = await startNextDevServer(cloneDir, {
      turbopackRoot: cloneReal,
      distDir: '.codecanvas/cache/next',
      cpuList,
    });

    let firstRouteRes;
    let routeTimings = {};
    let healthPayload;
    try {
      firstRouteRes = await httpGet(`${coldSrv.baseUrl}/`, 60_000);
      if (firstRouteRes.status !== 200 || !firstRouteRes.body.includes(`app:${label}`)) {
        throw new Error(`Cold "/" failed or missing patched marker (${firstRouteRes.status})`);
      }
      const totalColdToFirstPageMs = performance.now() - e2eStartedAt;
      const warmInProcessRes = await httpGet(`${coldSrv.baseUrl}/`, 60_000);

      const secondaryRoutes = ['/catalog', '/title/1', '/watchlist', '/analytics', '/settings', '/api/health'];
      for (const route of secondaryRoutes) {
        const res = await httpGet(`${coldSrv.baseUrl}${route}`, 60_000);
        if (res.status !== 200) {
          throw new Error(
            `Route ${route} returned HTTP ${res.status}\nserver output:\n${coldSrv.server.getOutput().combined.slice(-1500)}`,
          );
        }
        routeTimings[route] = Number(res.elapsedMs.toFixed(1));
        if (route === '/api/health') {
          healthPayload = JSON.parse(res.body);
        }
      }

      await coldSrv.stop();

      // Warm agent-host restart (existing clone + warm .codecanvas/cache/next)
      const warmStartedAt = performance.now();
      const warmSrv = await startNextDevServer(cloneDir, {
        turbopackRoot: cloneReal,
        distDir: '.codecanvas/cache/next',
        cpuList,
      });
      let warmFirstRouteRes;
      try {
        warmFirstRouteRes = await httpGet(`${warmSrv.baseUrl}/`, 60_000);
        if (warmFirstRouteRes.status !== 200) {
          throw new Error(`Warm "/" returned HTTP ${warmFirstRouteRes.status}`);
        }
      } finally {
        await warmSrv.stop();
      }
      const totalWarmRestartMs = performance.now() - warmStartedAt;

      return {
        label,
        installMode,
        cpuList: cpuList ?? 'all',
        cloneMs: Number(cloneInfo.elapsedMs.toFixed(1)),
        patchMs: Number(patchInfo.elapsedMs.toFixed(1)),
        installMs: Number(installRes.elapsedMs.toFixed(1)),
        envCopyMs: Number(envCopyRes.elapsedMs.toFixed(1)),
        devReadyMs: Number(coldSrv.readyMs.toFixed(1)),
        firstRouteMs: Number(firstRouteRes.elapsedMs.toFixed(1)),
        warmInProcessRouteMs: Number(warmInProcessRes.elapsedMs.toFixed(1)),
        totalColdToFirstPageMs: Number(totalColdToFirstPageMs.toFixed(1)),
        secondaryRoutesMs: routeTimings,
        warmRestartReadyMs: Number(warmSrv.readyMs.toFixed(1)),
        warmFirstRouteMs: Number(warmFirstRouteRes.elapsedMs.toFixed(1)),
        totalWarmRestartMs: Number(totalWarmRestartMs.toFixed(1)),
        verifiedPatchedMarker: healthPayload?.appMarker === label,
        verifiedEnvSecretLoaded: healthPayload?.env?.hasServerSecret === true,
      };
    } catch (err) {
      await coldSrv.stop();
      throw err;
    }
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true });
  }
}

export async function runExperimentE(parentDir, scratchRoot, options = {}) {
  const { nativeTrials = 3, fourVcpuTrials = 2 } = options;

  const nativePreferOffline = [];
  for (let i = 0; i < nativeTrials; i += 1) {
    const cloneDir = path.join(scratchRoot, `sim-home/.codecanvas/agents/reelhouse/e2e-native-${i}`);
    nativePreferOffline.push(
      await runSingleE2ETrial(parentDir, cloneDir, {
        installMode: 'prefer-offline',
        cpuList: null,
        label: `E2E_NATIVE_${i}`,
      }),
    );
  }

  const fourVcpuPreferOffline = [];
  for (let i = 0; i < fourVcpuTrials; i += 1) {
    const cloneDir = path.join(scratchRoot, `sim-home/.codecanvas/agents/reelhouse/e2e-4vcpu-${i}`);
    fourVcpuPreferOffline.push(
      await runSingleE2ETrial(parentDir, cloneDir, {
        installMode: 'prefer-offline',
        cpuList: '0-3',
        label: `E2E_4VCPU_${i}`,
      }),
    );
  }

  const fourVcpuOfflineClone = path.join(
    scratchRoot,
    'sim-home/.codecanvas/agents/reelhouse/e2e-4vcpu-offline',
  );
  const fourVcpuOffline = await runSingleE2ETrial(parentDir, fourVcpuOfflineClone, {
    installMode: 'offline',
    cpuList: '0-3',
    label: 'E2E_4VCPU_OFFLINE',
  });

  const summarizeE2E = (runs) => ({
    cloneMs: summarizeNumbers(runs.map((r) => r.cloneMs)),
    patchMs: summarizeNumbers(runs.map((r) => r.patchMs)),
    installMs: summarizeNumbers(runs.map((r) => r.installMs)),
    envCopyMs: summarizeNumbers(runs.map((r) => r.envCopyMs)),
    devReadyMs: summarizeNumbers(runs.map((r) => r.devReadyMs)),
    firstRouteMs: summarizeNumbers(runs.map((r) => r.firstRouteMs)),
    warmInProcessRouteMs: summarizeNumbers(runs.map((r) => r.warmInProcessRouteMs)),
    totalColdToFirstPageMs: summarizeNumbers(runs.map((r) => r.totalColdToFirstPageMs)),
    warmRestartReadyMs: summarizeNumbers(runs.map((r) => r.warmRestartReadyMs)),
    warmFirstRouteMs: summarizeNumbers(runs.map((r) => r.warmFirstRouteMs)),
    totalWarmRestartMs: summarizeNumbers(runs.map((r) => r.totalWarmRestartMs)),
  });

  return {
    budgetMs: 90_000,
    nativePreferOffline: {
      runs: nativePreferOffline,
      summary: summarizeE2E(nativePreferOffline),
    },
    fourVcpuPreferOffline: {
      runs: fourVcpuPreferOffline,
      summary: summarizeE2E(fourVcpuPreferOffline),
    },
    fourVcpuOffline,
  };
}
