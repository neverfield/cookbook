#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createReelhouseFixture } from './lib/fixture.mjs';
import {
  runExperimentA,
  runExperimentB,
  runExperimentC,
  runExperimentD,
  runExperimentE,
} from './lib/experiments.mjs';
import { cleanupAllProcessGroupsSync, runCommand } from './lib/process-mgr.mjs';

function parseArgs(argv) {
  const args = {
    trials: 3,
    fourVcpuTrials: 2,
    keepTmp: false,
    outPath: null,
    jsonOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--trials' && argv[i + 1]) {
      args.trials = Number.parseInt(argv[i + 1], 10);
      i += 1;
    } else if (token === '--four-vcpu-trials' && argv[i + 1]) {
      args.fourVcpuTrials = Number.parseInt(argv[i + 1], 10);
      i += 1;
    } else if (token === '--keep-tmp') {
      args.keepTmp = true;
    } else if (token === '--out' && argv[i + 1]) {
      args.outPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (token === '--json') {
      args.jsonOnly = true;
    } else if (token === '--help' || token === '-h') {
      console.log(`Usage: node run.mjs [options]

Options:
  --trials <n>             Number of trials for repeated benchmarks (default: 3)
  --four-vcpu-trials <n>   Number of 4-vCPU pinned E2E trials (default: 2)
  --out <path>             Write machine-readable JSON results to <path>
  --json                   Print JSON only to stdout
  --keep-tmp               Do not remove temporary fixture/scratch directory on exit
`);
      process.exit(0);
    }
  }
  return args;
}

async function collectEnvironmentInfo() {
  const [pnpmRes, gitRes, storeRes] = await Promise.all([
    runCommand('pnpm', ['--version']),
    runCommand('git', ['--version']),
    runCommand('pnpm', ['store', 'path']),
  ]);
  return {
    timestampUtc: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    vcpuCount: os.cpus().length,
    totalMemGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    nodeVersion: process.version,
    pnpmVersion: pnpmRes.stdout.trim(),
    gitVersion: gitRes.stdout.trim(),
    pnpmStorePath: storeRes.stdout.trim(),
  };
}

function logStep(jsonOnly, message) {
  if (!jsonOnly) {
    process.stderr.write(`[s5] ${message}\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = performance.now();
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'codecanvas-s5-'));
  const fixtureDir = path.join(tmpBase, 'reelhouse-fixture');
  const scratchRoot = path.join(tmpBase, 'scratch');

  const cleanupSync = () => {
    cleanupAllProcessGroupsSync();
  };
  process.on('SIGINT', () => {
    cleanupSync();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanupSync();
    process.exit(143);
  });
  process.on('exit', cleanupSync);

  try {
    await fs.mkdir(scratchRoot, { recursive: true });

    logStep(args.jsonOnly, `Temp workspace: ${tmpBase}`);
    const environment = await collectEnvironmentInfo();

    logStep(args.jsonOnly, 'Generating realistic multi-page Next.js + pnpm workspace fixture (cold install)...');
    const fixture = await createReelhouseFixture(fixtureDir);
    logStep(
      args.jsonOnly,
      `Fixture ready in ${(fixture.fixtureSetupMs / 1000).toFixed(1)}s (cold pnpm install ${(fixture.coldInstallMs / 1000).toFixed(1)}s, ~${fixture.approxPackageCount} locked entries)`,
    );

    logStep(args.jsonOnly, 'Running Experiment A: git clone --shared vs git worktree vs full clone...');
    const experimentA = await runExperimentA(fixtureDir, scratchRoot, args.trials);

    logStep(args.jsonOnly, 'Running Experiment B: dependency install strategies (warm store vs hardlink/symlink)...');
    const experimentB = await runExperimentB(fixtureDir, scratchRoot, args.trials);

    logStep(args.jsonOnly, 'Running Experiment C: safe .env* copy & security assertions...');
    const experimentC = await runExperimentC(fixtureDir, scratchRoot);

    logStep(args.jsonOnly, 'Running Experiment D: Next.js Turbopack root resolution (nested vs external + concurrent)...');
    const experimentD = await runExperimentD(fixtureDir, scratchRoot);

    logStep(args.jsonOnly, 'Running Experiment E: end-to-end cold & warm agent-host startup (8 vCPU & 4 vCPU)...');
    const experimentE = await runExperimentE(fixtureDir, scratchRoot, {
      nativeTrials: args.trials,
      fourVcpuTrials: args.fourVcpuTrials,
    });

    const totalRunMs = Number((performance.now() - startedAt).toFixed(1));

    const checks = {
      cloneHasOwnGitAndCleanParent:
        experimentA.sharedClone.hasOwnGitDir &&
        experimentA.sharedClone.alternatesPointsToParent &&
        experimentA.sharedClone.parentCleanAfterPatch &&
        experimentA.sharedClone.parentCleanWithNestedClone,
      pnpmWorkspaceIsolated:
        experimentB.pnpmStrategies['pnpm-prefer-offline'].workspaceUiRealpathIsolated &&
        experimentB.pnpmStrategies['pnpm-offline'].workspaceUiRealpathIsolated,
      envSecurityAllPassed: Object.values(experimentC.assertions).every(Boolean),
      nestedWithExplicitRootIsolated:
        experimentD.d1bNestedWithExplicitRoot.cwdInsideClone &&
        experimentD.d1bNestedWithExplicitRoot.uiSentinel === 'NESTED_EXPLICIT' &&
        experimentD.d1bNestedWithExplicitRoot.sharedMarker === 'NESTED_EXPLICIT' &&
        experimentD.d1bNestedWithExplicitRoot.appMarker === 'NESTED_EXPLICIT' &&
        experimentD.d1bNestedWithExplicitRoot.settingsLoadedSecretAndLocal &&
        experimentD.d1bNestedWithExplicitRoot.cloneWorkspaceHmrUpdated &&
        experimentD.d1bNestedWithExplicitRoot.isolatedFromParentEdit &&
        experimentD.d1bNestedWithExplicitRoot.lockfileOrRootWarnings.length === 0,
      externalCloneIsolated:
        experimentD.d2ExternalClone.withExplicitRoot.uiSentinel === 'EXTERNAL_CLONE' &&
        experimentD.d2ExternalClone.withExplicitRoot.cwdInsideClone &&
        experimentD.d2ExternalClone.withExplicitRoot.lockfileOrRootWarnings.length === 0,
      concurrentParentAndCloneIsolated: experimentD.d3ConcurrentParentAndClone.fullyIsolated,
      nativeWithinBudget:
        experimentE.nativePreferOffline.summary.totalColdToFirstPageMs.max <= experimentE.budgetMs,
      fourVcpuWithinBudget:
        experimentE.fourVcpuPreferOffline.summary.totalColdToFirstPageMs.max <= experimentE.budgetMs &&
        experimentE.fourVcpuOffline.totalColdToFirstPageMs <= experimentE.budgetMs,
    };

    const verdict = Object.values(checks).every(Boolean) ? 'GO' : 'NO-GO';

    const report = {
      spike: 'S5',
      verdict,
      checks,
      totalRunMs,
      environment,
      fixture,
      experimentA,
      experimentB,
      experimentC,
      experimentD,
      experimentE,
    };

    if (args.outPath) {
      await fs.mkdir(path.dirname(args.outPath), { recursive: true });
      await fs.writeFile(args.outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
      logStep(args.jsonOnly, `Wrote JSON results to ${args.outPath}`);
    }

    if (args.jsonOnly) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('\n================ SPIKE S5 SUMMARY ================');
      console.log(`Verdict: ${verdict}`);
      console.log(`Environment: Node ${environment.nodeVersion}, pnpm ${environment.pnpmVersion}, ${environment.vcpuCount} vCPU, ${environment.totalMemGb} GiB RAM`);
      console.log(`Fixture: Next 16.4.6 + React 19.3.1 + Tailwind v4 + pnpm workspace (~${fixture.approxPackageCount} locked entries, cold install ${(fixture.coldInstallMs / 1000).toFixed(2)}s)`);
      console.log(`Exp A (git clone --shared): median ${experimentA.sharedClone.timingMs.median} ms | incremental disk ${experimentA.sharedClone.incremental.incrementalMb} MB (vs full clone ${experimentA.fullClone.incremental.incrementalMb} MB)`);
      console.log(`Exp B (pnpm --prefer-offline): median ${(experimentB.pnpmStrategies['pnpm-prefer-offline'].timingMs.median / 1000).toFixed(2)}s | incremental disk ${experimentB.pnpmStrategies['pnpm-prefer-offline'].incrementalDiskRelativeToParent.incrementalMb} MB (apparent ${experimentB.pnpmStrategies['pnpm-prefer-offline'].cloneDiskStats.apparentMb} MB)`);
      console.log(`Exp B (pnpm --offline): median ${(experimentB.pnpmStrategies['pnpm-offline'].timingMs.median / 1000).toFixed(2)}s`);
      console.log(`Exp C (safe .env* copy): ${experimentC.elapsedMs} ms | all security checks passed: ${checks.envSecurityAllPassed}`);
      console.log(`Exp D (nested naive warnings): ${experimentD.d1aNestedWithoutExplicitRoot.lockfileOrRootWarnings.length} | escapedToParent: ${experimentD.d1aNestedWithoutExplicitRoot.escapedToParent}`);
      console.log(`Exp D (nested explicit root): isolated=${checks.nestedWithExplicitRootIsolated}, HMR=${experimentD.d1bNestedWithExplicitRoot.cloneWorkspaceHmrMs} ms`);
      console.log(`Exp D (concurrent parent+clone): isolated=${checks.concurrentParentAndCloneIsolated}`);
      console.log(`Exp E (E2E cold, 8 vCPU, --prefer-offline): median ${(experimentE.nativePreferOffline.summary.totalColdToFirstPageMs.median / 1000).toFixed(2)}s / max ${(experimentE.nativePreferOffline.summary.totalColdToFirstPageMs.max / 1000).toFixed(2)}s (budget <= 90s)`);
      console.log(`Exp E (E2E cold, 4 vCPU, --prefer-offline): median ${(experimentE.fourVcpuPreferOffline.summary.totalColdToFirstPageMs.median / 1000).toFixed(2)}s / max ${(experimentE.fourVcpuPreferOffline.summary.totalColdToFirstPageMs.max / 1000).toFixed(2)}s (budget <= 90s)`);
      console.log(`Exp E (E2E cold, 4 vCPU, --offline): ${(experimentE.fourVcpuOffline.totalColdToFirstPageMs / 1000).toFixed(2)}s`);
      console.log(`Exp E (E2E warm restart, 4 vCPU): median ${(experimentE.fourVcpuPreferOffline.summary.totalWarmRestartMs.median / 1000).toFixed(2)}s`);
      console.log('Checks:', checks);
      console.log('==================================================\n');
    }

    if (verdict !== 'GO') {
      process.exitCode = 1;
    }
  } finally {
    cleanupAllProcessGroupsSync();
    if (!args.keepTmp) {
      await fs.rm(tmpBase, { recursive: true, force: true });
      logStep(args.jsonOnly, `Cleaned up temp workspace ${tmpBase}`);
    } else {
      logStep(args.jsonOnly, `Kept temp workspace at ${tmpBase}`);
    }
  }
}

main().catch((err) => {
  cleanupAllProcessGroupsSync();
  console.error(err);
  process.exit(1);
});
