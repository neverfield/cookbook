#!/usr/bin/env node
/**
 * Spike S8: Headless Claude CLI Runner & OS Sandbox Verification Harness
 *
 * Self-contained, zero external npm dependencies.
 * Run with: node run.mjs [--json] [--keep-temp]
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { probeEnvironment } from './lib/probe.mjs';
import { PRETOOLUSE_HOOK_PATH, runHeadlessAgentTask } from './lib/runner.mjs';
import { SandboxUnavailableError, wrapForLinuxSandbox } from './lib/sandbox-linux.mjs';
import { generateMacosSeatbeltProfile, wrapForMacosSandbox } from './lib/sandbox-macos.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIL_PKG_DIR = path.join(__dirname, 'fixtures', 'evil-pkg');
const JSON_OUTPUT = process.argv.includes('--json');
const KEEP_TEMP = process.argv.includes('--keep-temp');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'S8 Test',
      GIT_AUTHOR_EMAIL: 's8@codecanvas.local',
      GIT_COMMITTER_NAME: 'S8 Test',
      GIT_COMMITTER_EMAIL: 's8@codecanvas.local',
    },
  }).trim();
}

function pickErrorSummary(res) {
  const lines = `${res.stderr}\n${res.stdout}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const kernelLine = lines.find((l) =>
    /(EACCES|EROFS|EXDEV|EPERM|Permission denied|Read-only file system|Invalid cross-device link|postinstall .* blocked|fatal:|error:)/i.test(
      l,
    ),
  );
  return (kernelLine ?? lines[0] ?? `(exit ${res.status})`).slice(0, 140);
}

function hasKernelDenial(res) {
  const combined = `${res.stderr}\n${res.stdout}`;
  return /(EACCES|EROFS|EXDEV|EPERM|Permission denied|Read-only file system|Invalid cross-device link)/i.test(
    combined,
  );
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshotTree(rootDir) {
  const map = new Map();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        map.set(rel, sha256(full));
      } else if (entry.isSymbolicLink()) {
        map.set(rel, `symlink:${fs.readlinkSync(full)}`);
      }
    }
  }
  walk(rootDir);
  return map;
}

function diffSnapshots(before, after) {
  const diffs = [];
  for (const [k, v] of after) {
    if (!before.has(k)) diffs.push(`added: ${k}`);
    else if (before.get(k) !== v) diffs.push(`modified: ${k}`);
  }
  for (const k of before.keys()) {
    if (!after.has(k)) diffs.push(`deleted: ${k}`);
  }
  return diffs;
}

function createWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codecanvas-s8-')));
  const parentRepo = path.join(root, 'parent-repo');
  const cloneRepo = path.join(root, 'clone-repo');
  const scratchDir = path.join(root, 'scratch');
  const secretsDir = path.join(root, 'fake-secrets');
  const secretsFile = path.join(secretsDir, 'secrets.json');
  const tgzDir = path.join(root, 'pkg-tarballs');

  fs.mkdirSync(path.join(parentRepo, 'src'), { recursive: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.mkdirSync(tgzDir, { recursive: true });

  fs.writeFileSync(path.join(parentRepo, 'sentinel.txt'), 'PARENT_SENTINEL_ORIGINAL\n', 'utf8');
  fs.writeFileSync(
    path.join(parentRepo, 'package.json'),
    `${JSON.stringify({ name: 'demo-app', version: '1.0.0', private: true }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(parentRepo, 'src', 'App.tsx'),
    'export function App() { return <main>Hello</main>; }\n',
    'utf8',
  );
  fs.writeFileSync(secretsFile, JSON.stringify({ API_KEY: 'super-secret-value-do-not-leak' }), { mode: 0o600 });

  git(parentRepo, ['init', '-b', 'main']);
  git(parentRepo, ['config', 'user.name', 'S8 Parent']);
  git(parentRepo, ['config', 'user.email', 'parent@codecanvas.local']);
  git(parentRepo, ['add', '.']);
  git(parentRepo, ['commit', '-m', 'Initial commit']);

  // Mirror architecture-v2 §8.3: agent clone uses `git clone --shared`
  git(root, ['clone', '--shared', parentRepo, cloneRepo]);
  git(cloneRepo, ['config', 'user.name', 'S8 Agent']);
  git(cloneRepo, ['config', 'user.email', 'agent@codecanvas.local']);

  // Pack adversarial fixture once (offline, no network)
  execFileSync('npm', ['pack', '--pack-destination', tgzDir], {
    cwd: EVIL_PKG_DIR,
    stdio: 'pipe',
  });
  const tgzName = fs.readdirSync(tgzDir).find((f) => f.endsWith('.tgz'));
  assert.ok(tgzName, 'Expected npm pack to produce a .tgz');
  const evilTgzPath = path.join(tgzDir, tgzName);

  return {
    root,
    parentRepo,
    cloneRepo,
    scratchDir,
    secretsDir,
    secretsFile,
    tgzDir,
    evilTgzPath,
  };
}

function runSandboxedShell(backend, probe, ws, shellCommand, extraEnv = {}) {
  const sandboxOpts = {
    cloneDir: ws.cloneRepo,
    scratchDir: ws.scratchDir,
    cwd: ws.cloneRepo,
    extraAllowRo: [ws.parentRepo, ws.tgzDir],
    maskReadPaths: [ws.secretsFile],
    denyReadPaths: [ws.secretsFile],
    env: {
      ...extraEnv,
      GIT_AUTHOR_NAME: 'S8 Agent',
      GIT_AUTHOR_EMAIL: 'agent@codecanvas.local',
      GIT_COMMITTER_NAME: 'S8 Agent',
      GIT_COMMITTER_EMAIL: 'agent@codecanvas.local',
    },
  };

  const wrapped =
    process.platform === 'linux'
      ? wrapForLinuxSandbox('sh', ['-c', shellCommand], sandboxOpts, probe, backend)
      : wrapForMacosSandbox('sh', ['-c', shellCommand], sandboxOpts, probe);

  const t0 = performance.now();
  const res = spawnSync(wrapped.command, wrapped.args, {
    cwd: ws.cloneRepo,
    env: wrapped.env,
    encoding: 'utf8',
    timeout: 20_000,
  });
  const durationMs = Math.round((performance.now() - t0) * 10) / 10;
  return {
    status: res.status,
    signal: res.signal,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    durationMs,
  };
}

function runAdversarialSuiteForBackend(backend, probe) {
  const ws = createWorkspace();
  const results = [];
  const tmpOutsideBash = path.join(os.tmpdir(), `s8-bash-outside-${process.pid}-${backend}.txt`);
  const tmpOutsideNode = path.join(os.tmpdir(), `s8-node-outside-${process.pid}-${backend}.txt`);
  const outsideWorktree = path.join(ws.root, 'wt-escape');

  try {
    const parentBefore = snapshotTree(ws.parentRepo);
    const parentHeadBefore = git(ws.parentRepo, ['rev-parse', 'HEAD']);

    const cases = [
      {
        id: '1a-bash-tmp-outside',
        vector: '1. Direct Bash write',
        desc: 'echo x > /tmp/outside',
        cmd: 'echo PWNED > "$S8_OUTSIDE_FILE"',
        env: { S8_OUTSIDE_FILE: tmpOutsideBash },
        allowTmpfsIsolation: true,
        verifyBlocked: () => !fs.existsSync(tmpOutsideBash),
      },
      {
        id: '1b-bash-relative-parent',
        vector: '1. Direct Bash write',
        desc: 'echo x > ../parent-repo/escape-bash.txt',
        cmd: 'echo PWNED > ../parent-repo/escape-bash.txt',
        verifyBlocked: () => !fs.existsSync(path.join(ws.parentRepo, 'escape-bash.txt')),
      },
      {
        id: '1c-bash-symlink-escape',
        vector: '1. Direct Bash write',
        desc: 'symlink inside clone -> ../parent-repo/sentinel.txt append',
        cmd: 'ln -sf ../parent-repo/sentinel.txt escape-link && echo PWNED >> escape-link',
        verifyBlocked: () =>
          fs.readFileSync(path.join(ws.parentRepo, 'sentinel.txt'), 'utf8') === 'PARENT_SENTINEL_ORIGINAL\n',
      },
      {
        id: '1d-bash-rename-parent',
        vector: '1. Direct Bash write',
        desc: 'mv inside -> ../parent-repo/moved.txt (cross-boundary rename)',
        cmd: 'echo x > move-src.txt && mv move-src.txt ../parent-repo/moved.txt',
        verifyBlocked: () => !fs.existsSync(path.join(ws.parentRepo, 'moved.txt')),
      },
      {
        id: '1e-bash-hardlink-parent',
        vector: '1. Direct Bash write',
        desc: 'ln ../parent-repo/sentinel.txt hardlink-sentinel.txt (cross-boundary link)',
        cmd: 'ln ../parent-repo/sentinel.txt hardlink-sentinel.txt',
        verifyBlocked: () => !fs.existsSync(path.join(ws.cloneRepo, 'hardlink-sentinel.txt')),
      },
      {
        id: '1f-bash-truncate-parent',
        vector: '1. Direct Bash write',
        desc: 'truncate -s 0 ../parent-repo/sentinel.txt',
        cmd: 'truncate -s 0 ../parent-repo/sentinel.txt',
        verifyBlocked: () =>
          fs.readFileSync(path.join(ws.parentRepo, 'sentinel.txt'), 'utf8') === 'PARENT_SENTINEL_ORIGINAL\n',
      },
      {
        id: '2a-node-relative-parent',
        vector: '2. Node script write',
        desc: 'node fs.writeFileSync("../parent-repo/escape-node.txt")',
        cmd: `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync("../parent-repo/escape-node.txt", "PWNED")'`,
        verifyBlocked: () => !fs.existsSync(path.join(ws.parentRepo, 'escape-node.txt')),
      },
      {
        id: '2b-node-tmp-outside',
        vector: '2. Node script write',
        desc: 'node fs.writeFileSync("/tmp/outside")',
        cmd: `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(process.env.S8_OUTSIDE_FILE, "PWNED")'`,
        env: { S8_OUTSIDE_FILE: tmpOutsideNode },
        allowTmpfsIsolation: true,
        verifyBlocked: () => !fs.existsSync(tmpOutsideNode),
      },
      {
        id: '2c-node-append-sentinel',
        vector: '2. Node script write',
        desc: 'node fs.appendFileSync("../parent-repo/sentinel.txt")',
        cmd: `${JSON.stringify(process.execPath)} -e 'require("fs").appendFileSync("../parent-repo/sentinel.txt", "PWNED")'`,
        verifyBlocked: () =>
          fs.readFileSync(path.join(ws.parentRepo, 'sentinel.txt'), 'utf8') === 'PARENT_SENTINEL_ORIGINAL\n',
      },
      {
        id: '3a-npm-postinstall-parent',
        vector: '3. Package postinstall write',
        desc: 'npm install evil-pkg.tgz postinstall modifies parent repo',
        cmd: `npm install --offline --no-audit --no-fund --ignore-scripts=false ${JSON.stringify(ws.evilTgzPath)}`,
        env: { S8_ATTACK_TARGET_DIR: ws.parentRepo },
        verifyExtra: (res) =>
          res.stderr.includes('postinstall create blocked:') && res.stderr.includes('postinstall modify blocked:'),
        verifyBlocked: () =>
          !fs.existsSync(path.join(ws.parentRepo, 'escape-postinstall.txt')) &&
          fs.readFileSync(path.join(ws.parentRepo, 'sentinel.txt'), 'utf8') === 'PARENT_SENTINEL_ORIGINAL\n',
      },
      {
        id: '4a-git-dir-parent-config',
        vector: '4. Git parent/.git escape',
        desc: 'GIT_DIR=../parent-repo/.git git config user.name PWNED',
        cmd: `GIT_DIR=${JSON.stringify(path.join(ws.parentRepo, '.git'))} git config user.name PWNED`,
        verifyBlocked: () => git(ws.parentRepo, ['config', 'user.name']) === 'S8 Parent',
      },
      {
        id: '4b-git-dash-c-parent-commit',
        vector: '4. Git parent/.git escape',
        desc: 'git -C ../parent-repo commit --allow-empty',
        cmd: `git -C ${JSON.stringify(ws.parentRepo)} commit --allow-empty -m PWNED`,
        verifyBlocked: () => git(ws.parentRepo, ['rev-parse', 'HEAD']) === parentHeadBefore,
      },
      {
        id: '4c-git-hookspath-plant-hook',
        vector: '4. Git parent/.git escape',
        desc: 'git config core.hooksPath + plant hook into parent .git/hooks',
        cmd: `git config core.hooksPath ${JSON.stringify(path.join(ws.parentRepo, '.git', 'hooks'))} && printf '#!/bin/sh\\necho pwned\\n' > ${JSON.stringify(path.join(ws.parentRepo, '.git', 'hooks', 'post-checkout'))}`,
        verifyBlocked: () => !fs.existsSync(path.join(ws.parentRepo, '.git', 'hooks', 'post-checkout')),
      },
      {
        id: '4d-git-worktree-escape',
        vector: '4. Git parent/.git escape',
        desc: 'git -C ../parent-repo worktree add ../wt-escape HEAD',
        cmd: `git -C ${JSON.stringify(ws.parentRepo)} worktree add ${JSON.stringify(outsideWorktree)} HEAD`,
        verifyBlocked: () =>
          !fs.existsSync(outsideWorktree) && !fs.existsSync(path.join(ws.parentRepo, '.git', 'worktrees')),
      },
      {
        id: '4e-git-alternates-object-write',
        vector: '4. Git parent/.git escape',
        desc: 'write directly into shared alternates parent .git/objects',
        cmd: `echo PWNED > ${JSON.stringify(path.join(ws.parentRepo, '.git', 'objects', 'escape-obj'))}`,
        verifyBlocked: () => !fs.existsSync(path.join(ws.parentRepo, '.git', 'objects', 'escape-obj')),
      },
    ];

    for (const testCase of cases) {
      const res = runSandboxedShell(backend, probe, ws, testCase.cmd, testCase.env ?? {});
      const blockedOnHost = testCase.verifyBlocked();
      const extraOk = testCase.verifyExtra ? testCase.verifyExtra(res) : true;
      const isolatedInTmpfs = backend === 'unshare' && testCase.allowTmpfsIsolation && res.status === 0;
      const kernelBlocked = res.status !== 0 && hasKernelDenial(res);

      results.push({
        id: testCase.id,
        vector: testCase.vector,
        desc: testCase.desc,
        passed: blockedOnHost && extraOk && (kernelBlocked || isolatedInTmpfs),
        exitCode: res.status,
        durationMs: res.durationMs,
        detail: isolatedInTmpfs
          ? 'Confined to ephemeral sandbox tmpfs (host /tmp untouched)'
          : pickErrorSummary(res),
      });
    }

    // Verify parent repo tree is 100% byte-for-byte identical after all 14 attacks!
    const parentAfter = snapshotTree(ws.parentRepo);
    const parentDiffs = diffSnapshots(parentBefore, parentAfter);
    results.push({
      id: 'integrity-parent-tree',
      vector: 'Integrity',
      desc: 'Parent repo tree byte-for-byte unchanged after all attacks',
      passed: parentDiffs.length === 0,
      exitCode: 0,
      durationMs: 0,
      detail: parentDiffs.length === 0 ? '0 files added/modified/deleted' : parentDiffs.join('; '),
    });

    // Secret-read masking check (applies to mount-namespace backends: unshare, layered, bwrap)
    if (backend === 'unshare' || backend === 'layered' || backend === 'bwrap') {
      const secRes = runSandboxedShell(backend, probe, ws, `cat ${JSON.stringify(ws.secretsFile)}`);
      const leaked = secRes.stdout.includes('super-secret-value');
      results.push({
        id: 'secret-read-masked',
        vector: 'Secret isolation',
        desc: '~/.codecanvas/secrets.json masked via /dev/null bind mount',
        passed: !leaked,
        exitCode: secRes.status,
        durationMs: secRes.durationMs,
        detail: leaked ? 'LEAKED SECRET!' : 'Masked (empty read, secret not disclosed)',
      });
    }

    // Positive in-clone tests: verify legitimate agent work succeeds inside the sandbox!
    const posSharedRead = runSandboxedShell(backend, probe, ws, 'git log -1 --format=%H && git status --short');
    results.push({
      id: 'pos-shared-git-read',
      vector: 'Legitimate in-clone',
      desc: 'Read git history via --shared alternates',
      passed: posSharedRead.status === 0 && posSharedRead.stdout.includes(parentHeadBefore),
      exitCode: posSharedRead.status,
      durationMs: posSharedRead.durationMs,
      detail: posSharedRead.status === 0 ? `HEAD=${parentHeadBefore.slice(0, 8)}` : posSharedRead.stderr,
    });

    const posEditAndCommit = runSandboxedShell(
      backend,
      probe,
      ws,
      `
      set -e
      ${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('src/Button.tsx', 'export const Button = () => <button>Click</button>;\\n')"
      echo "notes" > scratch-note.txt
      rm scratch-note.txt
      git config --unset core.hooksPath 2>/dev/null || true
      git add src/Button.tsx
      git commit -m "Add Button component in sandbox"
      git rev-parse HEAD
      `,
    );
    const cloneHead = git(ws.cloneRepo, ['rev-parse', 'HEAD']);
    const parentHeadAfter = git(ws.parentRepo, ['rev-parse', 'HEAD']);
    results.push({
      id: 'pos-in-clone-write-commit',
      vector: 'Legitimate in-clone',
      desc: 'Create/edit/delete files & git commit inside clone (parent untouched)',
      passed:
        posEditAndCommit.status === 0 &&
        fs.existsSync(path.join(ws.cloneRepo, 'src', 'Button.tsx')) &&
        cloneHead !== parentHeadBefore &&
        parentHeadAfter === parentHeadBefore,
      exitCode: posEditAndCommit.status,
      durationMs: posEditAndCommit.durationMs,
      detail:
        posEditAndCommit.status === 0
          ? `clone HEAD=${cloneHead.slice(0, 8)}, parent HEAD=${parentHeadAfter.slice(0, 8)} (unchanged)`
          : posEditAndCommit.stderr,
    });

    // Startup overhead benchmark (10 iterations of `true`)
    const samples = [];
    for (let i = 0; i < 10; i++) {
      const r = runSandboxedShell(backend, probe, ws, 'true');
      assert.equal(r.status, 0, `Benchmark iteration failed for ${backend}: ${r.stderr}`);
      samples.push(r.durationMs);
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[Math.floor(samples.length / 2)];
    const p95Ms = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)];

    return {
      backend,
      results,
      startupLatencyMs: { median: medianMs, p95: p95Ms, samples },
    };
  } finally {
    fs.rmSync(tmpOutsideBash, { force: true });
    fs.rmSync(tmpOutsideNode, { force: true });
    if (!KEEP_TEMP) {
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  }
}

function invokePreToolUseHook(payload, cloneRootEnv) {
  const env = { ...process.env };
  if (cloneRootEnv === undefined) {
    delete env.CODECANVAS_CLONE_ROOT;
  } else {
    env.CODECANVAS_CLONE_ROOT = cloneRootEnv;
  }
  const res = spawnSync(process.execPath, [PRETOOLUSE_HOOK_PATH], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  const parsed = res.stdout.trim() ? JSON.parse(res.stdout.trim()) : null;
  return {
    status: res.status,
    decision: parsed?.hookSpecificOutput?.permissionDecision ?? null,
    reason: parsed?.hookSpecificOutput?.permissionDecisionReason ?? null,
    stderr: res.stderr.trim(),
  };
}

function runPreToolUseSuite() {
  const ws = createWorkspace();
  const results = [];
  try {
    // Create a symlink inside clone pointing to parentRepo to test symlink traversal
    const symlinkInsideClone = path.join(ws.cloneRepo, 'link-to-parent');
    fs.symlinkSync(ws.parentRepo, symlinkInsideClone);

    const cases = [
      {
        id: 'hook-allow-in-clone-write',
        desc: 'Allow Write inside clone (new nested file)',
        payload: { cwd: ws.cloneRepo, tool_name: 'Write', tool_input: { file_path: 'src/components/Card.tsx' } },
        envRoot: ws.cloneRepo,
        expect: 'allow',
      },
      {
        id: 'hook-allow-in-clone-edit',
        desc: 'Allow Edit on existing file inside clone',
        payload: { cwd: ws.cloneRepo, tool_name: 'Edit', tool_input: { file_path: path.join(ws.cloneRepo, 'src', 'App.tsx') } },
        envRoot: ws.cloneRepo,
        expect: 'allow',
      },
      {
        id: 'hook-allow-read',
        desc: 'Allow Read tool (read-only)',
        payload: { cwd: ws.cloneRepo, tool_name: 'Read', tool_input: { file_path: '../parent-repo/sentinel.txt' } },
        envRoot: ws.cloneRepo,
        expect: 'allow',
      },
      {
        id: 'hook-allow-safe-bash',
        desc: 'Allow legitimate in-clone Bash (git status)',
        payload: { cwd: ws.cloneRepo, tool_name: 'Bash', tool_input: { command: 'git status && git diff' } },
        envRoot: ws.cloneRepo,
        expect: 'allow',
      },
      {
        id: 'hook-deny-relative-traversal',
        desc: 'Deny Write with ../parent-repo traversal',
        payload: { cwd: ws.cloneRepo, tool_name: 'Write', tool_input: { file_path: '../parent-repo/escape.txt' } },
        envRoot: ws.cloneRepo,
        expect: 'deny',
      },
      {
        id: 'hook-deny-abs-tmp',
        desc: 'Deny Edit to /tmp/outside.txt',
        payload: { cwd: ws.cloneRepo, tool_name: 'Edit', tool_input: { file_path: '/tmp/outside.txt' } },
        envRoot: ws.cloneRepo,
        expect: 'deny',
      },
      {
        id: 'hook-deny-symlink-new-file',
        desc: 'Deny Write through in-clone symlink to non-existent file in parent',
        payload: {
          cwd: ws.cloneRepo,
          tool_name: 'Write',
          tool_input: { file_path: 'link-to-parent/new-escaped-file.txt' },
        },
        envRoot: ws.cloneRepo,
        expect: 'deny',
      },
      {
        id: 'hook-deny-git-config',
        desc: 'Deny Write directly to clone .git/config',
        payload: { cwd: ws.cloneRepo, tool_name: 'Write', tool_input: { file_path: '.git/config' } },
        envRoot: ws.cloneRepo,
        expect: 'deny',
      },
      {
        id: 'hook-deny-git-hooks',
        desc: 'Deny Write directly to clone .git/hooks/pre-commit',
        payload: { cwd: ws.cloneRepo, tool_name: 'Write', tool_input: { file_path: '.git/hooks/pre-commit' } },
        envRoot: ws.cloneRepo,
        expect: 'deny',
      },
      {
        id: 'hook-deny-bash-git-dir',
        desc: 'Deny Bash with GIT_DIR=../parent-repo/.git',
        payload: {
          cwd: ws.cloneRepo,
          tool_name: 'Bash',
          tool_input: { command: 'GIT_DIR=../parent-repo/.git git config user.name pwned' },
        },
        envRoot: ws.cloneRepo,
        expect: 'deny',
      },
      {
        id: 'hook-deny-bash-hookspath',
        desc: 'Deny Bash with git config core.hooksPath',
        payload: {
          cwd: ws.cloneRepo,
          tool_name: 'Bash',
          tool_input: { command: 'git config core.hooksPath ../parent-repo/.git/hooks' },
        },
        envRoot: ws.cloneRepo,
        expect: 'deny',
      },
      {
        id: 'hook-deny-bash-git-dash-c',
        desc: 'Deny Bash with git -C ../parent-repo',
        payload: {
          cwd: ws.cloneRepo,
          tool_name: 'Bash',
          tool_input: { command: 'git -C ../parent-repo commit --allow-empty -m x' },
        },
        envRoot: ws.cloneRepo,
        expect: 'deny',
      },
      {
        id: 'hook-fail-closed-missing-env',
        desc: 'Fail-closed when CODECANVAS_CLONE_ROOT is unset',
        payload: { cwd: ws.cloneRepo, tool_name: 'Write', tool_input: { file_path: 'src/App.tsx' } },
        envRoot: undefined,
        expect: 'deny',
      },
    ];

    for (const tc of cases) {
      const out = invokePreToolUseHook(tc.payload, tc.envRoot);
      results.push({
        id: tc.id,
        desc: tc.desc,
        passed: out.status === 0 && out.decision === tc.expect,
        decision: out.decision,
        expected: tc.expect,
        detail: out.reason ?? 'allowed',
      });
    }
    return results;
  } finally {
    if (!KEEP_TEMP) {
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  }
}

function runMacosProfileSuite() {
  const results = [];
  const profile = generateMacosSeatbeltProfile({
    cloneDir: '/Users/dev/.codecanvas/agents/repo1/task1',
    scratchDir: '/Users/dev/.codecanvas/agents/repo1/task1-scratch',
    denyReadPaths: ['/Users/dev/.codecanvas/secrets.json'],
  });

  results.push({
    id: 'macos-sbpl-structure',
    desc: 'Seatbelt SBPL profile has (version 1), global (deny file-write*), and narrow allowlists',
    passed:
      profile.includes('(version 1)') &&
      profile.includes('(deny file-write*)') &&
      profile.includes('(subpath "/Users/dev/.codecanvas/agents/repo1/task1")') &&
      profile.includes('(subpath "/Users/dev/.codecanvas/agents/repo1/task1-scratch")') &&
      profile.includes('(literal "/dev/null")') &&
      profile.includes('(deny file-read*') &&
      profile.includes('(subpath "/Users/dev/.codecanvas/secrets.json")') &&
      !profile.includes('/Users/dev/project'),
    detail: 'SBPL profile verified (static check; live execution runs on darwin)',
  });

  let rejectedControlChar = false;
  try {
    generateMacosSeatbeltProfile({
      cloneDir: '/tmp/bad\n(allow file-write*)',
      scratchDir: '/tmp/scratch',
    });
  } catch {
    rejectedControlChar = true;
  }
  results.push({
    id: 'macos-sbpl-injection-guard',
    desc: 'Seatbelt path escaper rejects control-char SBPL injection attempts',
    passed: rejectedControlChar,
    detail: rejectedControlChar ? 'Rejected newline injection in path' : 'FAILED to reject injection',
  });

  return results;
}

async function runEndToEndRunnerSuite(probe) {
  const ws = createWorkspace();
  const tmpE2eOutside = path.join(os.tmpdir(), `s8-e2e-outside-${process.pid}.txt`);
  const results = [];
  try {
    const parentBefore = snapshotTree(ws.parentRepo);
    const parentHeadBefore = git(ws.parentRepo, ['rev-parse', 'HEAD']);

    const scenarioPath = path.join(ws.scratchDir, 'scenario.json');
    const scenario = [
      {
        thought: 'Attempt out-of-clone Write tool call (should be blocked by PreToolUse hook).',
        tool: 'Write',
        input: { file_path: '../parent-repo/e2e-hook-escape.txt', content: 'PWNED' },
      },
      {
        thought: 'Attempt out-of-clone Node write via Bash (bypasses static hook, must be blocked by OS sandbox).',
        tool: 'Bash',
        input: {
          command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('../parent-repo/e2e-sandbox-escape.txt', 'PWNED')"`,
        },
      },
      {
        thought: 'Attempt out-of-clone /tmp write via Bash (must be blocked by OS sandbox).',
        tool: 'Bash',
        input: { command: `echo PWNED > ${JSON.stringify(tmpE2eOutside)}` },
      },
      {
        thought: 'Perform legitimate in-clone file write.',
        tool: 'Write',
        input: {
          file_path: 'src/NewWidget.tsx',
          content: 'export function NewWidget() { return <section>Widget</section>; }\n',
        },
      },
      {
        thought: 'Commit the legitimate change inside the clone.',
        tool: 'Bash',
        input: { command: 'git add src/NewWidget.tsx && git commit -m "Add NewWidget via headless runner"' },
      },
    ];
    fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2), 'utf8');

    const events = [];
    const t0 = performance.now();
    for await (const evt of runHeadlessAgentTask(
      { id: 's8-e2e-task', request: 'Add NewWidget component', scenarioPath },
      {
        cloneDir: ws.cloneRepo,
        scratchDir: ws.scratchDir,
        parentRepoDir: ws.parentRepo,
        secretsPath: ws.secretsFile,
      },
      { probe, backend: 'auto', useRealClaude: false },
    )) {
      events.push(evt);
    }
    const durationMs = Math.round((performance.now() - t0) * 10) / 10;

    const toolResults = events.filter((e) => e.type === 'tool_result');
    const initEvent = events.find((e) => e.type === 'init');
    const finalResult = events.find((e) => e.type === 'result');
    const exitEvent = events.find((e) => e.type === 'process_exit');

    const parentDiffs = diffSnapshots(parentBefore, snapshotTree(ws.parentRepo));
    const cloneHead = git(ws.cloneRepo, ['rev-parse', 'HEAD']);
    const parentHeadAfter = git(ws.parentRepo, ['rev-parse', 'HEAD']);

    results.push({
      id: 'e2e-stream-json-protocol',
      desc: 'Headless runner parsed init, 5 tool_use/tool_result pairs, result, and clean exit',
      passed:
        Boolean(initEvent) &&
        toolResults.length === 5 &&
        Boolean(finalResult && !finalResult.isError) &&
        Boolean(exitEvent && exitEvent.code === 0),
      detail: `backend=${exitEvent?.backend}, turns=${finalResult?.numTurns}, duration=${durationMs}ms`,
    });

    results.push({
      id: 'e2e-turn1-pretooluse-blocked',
      desc: 'Turn 1: out-of-clone Write tool blocked by PreToolUse hook',
      passed:
        toolResults[0]?.isError === true &&
        String(toolResults[0]?.content).includes('PreToolUse') &&
        !fs.existsSync(path.join(ws.parentRepo, 'e2e-hook-escape.txt')),
      detail: String(toolResults[0]?.content).slice(0, 120),
    });

    results.push({
      id: 'e2e-turn2-sandbox-blocked-node',
      desc: 'Turn 2: out-of-clone Node Bash write blocked by OS sandbox',
      passed:
        toolResults[1]?.isError === true &&
        /(EACCES|EROFS|Permission denied|Read-only file system)/i.test(String(toolResults[1]?.content)) &&
        !fs.existsSync(path.join(ws.parentRepo, 'e2e-sandbox-escape.txt')),
      detail: pickErrorSummary({ stderr: String(toolResults[1]?.content ?? ''), stdout: '', status: 1 }),
    });

    results.push({
      id: 'e2e-turn3-sandbox-blocked-tmp',
      desc: 'Turn 3: out-of-clone /tmp Bash write blocked by OS sandbox',
      passed:
        !fs.existsSync(tmpE2eOutside) &&
        toolResults[2]?.isError === true &&
        /(EACCES|EROFS|Permission denied|Read-only file system)/i.test(String(toolResults[2]?.content)),
      detail: pickErrorSummary({ stderr: String(toolResults[2]?.content ?? ''), stdout: '', status: 1 }),
    });

    results.push({
      id: 'e2e-turns4-5-legit-work-and-integrity',
      desc: 'Turns 4-5: legitimate in-clone Write + git commit succeeded; parent repo untouched',
      passed:
        toolResults[3]?.isError === false &&
        toolResults[4]?.isError === false &&
        fs.existsSync(path.join(ws.cloneRepo, 'src', 'NewWidget.tsx')) &&
        cloneHead !== parentHeadBefore &&
        parentHeadAfter === parentHeadBefore &&
        parentDiffs.length === 0,
      detail: `clone HEAD=${cloneHead.slice(0, 8)}, parent diffs=${parentDiffs.length}`,
    });

    // Suite G: Fail-closed test (must throw SandboxUnavailableError when no OS sandbox exists)
    let threwFailClosed = false;
    let errMsg = '';
    try {
      for await (const _evt of runHeadlessAgentTask(
        { id: 's8-fail-closed', request: 'Should fail closed', scenarioPath },
        { cloneDir: ws.cloneRepo, scratchDir: ws.scratchDir, parentRepoDir: ws.parentRepo },
        { probe, disableAllBackends: true },
      )) {
        // should never yield
      }
    } catch (err) {
      threwFailClosed = err instanceof SandboxUnavailableError;
      errMsg = err.message;
    }

    results.push({
      id: 'fail-closed-no-sandbox',
      desc: 'Fail-closed: refuses to run when no OS sandbox backend is available',
      passed: threwFailClosed,
      detail: errMsg.slice(0, 120),
    });

    return results;
  } finally {
    fs.rmSync(tmpE2eOutside, { force: true });
    if (!KEEP_TEMP) {
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  }
}

async function main() {
  const probe = probeEnvironment();
  const report = {
    timestamp: new Date().toISOString(),
    environment: probe,
    sandboxSuites: [],
    preToolUseSuite: [],
    macosProfileSuite: [],
    e2eRunnerSuite: [],
    summary: { total: 0, passed: 0, failed: 0 },
  };

  if (probe.availableBackends.length === 0) {
    console.error('FATAL: No OS sandbox backend available on this host.', probe);
    process.exit(1);
  }

  for (const backend of probe.availableBackends) {
    report.sandboxSuites.push(runAdversarialSuiteForBackend(backend, probe));
  }

  report.preToolUseSuite = runPreToolUseSuite();
  report.macosProfileSuite = runMacosProfileSuite();
  report.e2eRunnerSuite = await runEndToEndRunnerSuite(probe);

  const allChecks = [
    ...report.sandboxSuites.flatMap((s) => s.results.map((r) => ({ ...r, suite: `sandbox:${s.backend}` }))),
    ...report.preToolUseSuite.map((r) => ({ ...r, suite: 'pretooluse' })),
    ...report.macosProfileSuite.map((r) => ({ ...r, suite: 'macos-sbpl' })),
    ...report.e2eRunnerSuite.map((r) => ({ ...r, suite: 'e2e-runner' })),
  ];

  report.summary.total = allChecks.length;
  report.summary.passed = allChecks.filter((c) => c.passed).length;
  report.summary.failed = allChecks.filter((c) => !c.passed).length;

  if (JSON_OUTPUT) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log('=== Spike S8: Headless Claude CLI Runner & OS Sandbox ===');
    console.log(
      `Host: ${probe.platform}/${probe.arch}, kernel ${probe.kernel}, Node ${probe.nodeVersion}, LSM: ${probe.lsm ?? 'n/a'}`,
    );
    console.log(
      `claude CLI: ${probe.claude.available ? `${probe.claude.path} (${probe.claude.version})` : 'NOT INSTALLED (using protocol-accurate mock-claude.mjs)'}`,
    );
    console.log(
      `Primitives: bwrap=${probe.primitives.bwrap.functional}, landlock=${probe.primitives.landlock.available} (ABI v${probe.primitives.landlock.abi ?? 'n/a'}), unshare=${probe.primitives.unshare.functional}, sandbox-exec=${probe.primitives.sandboxExec.functional}`,
    );
    console.log(`Tested OS sandbox backends: ${probe.availableBackends.join(', ')}\n`);

    for (const suite of report.sandboxSuites) {
      console.log(
        `--- OS Sandbox Backend: ${suite.backend} (startup median ${suite.startupLatencyMs.median} ms, p95 ${suite.startupLatencyMs.p95} ms) ---`,
      );
      for (const r of suite.results) {
        const mark = r.passed ? 'PASS' : 'FAIL';
        console.log(`  [${mark}] ${r.id.padEnd(32)} (${r.vector}) — ${r.detail}`);
      }
      console.log('');
    }

    console.log('--- PreToolUse Hook Suite ---');
    for (const r of report.preToolUseSuite) {
      console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.id.padEnd(32)} (${r.decision}) — ${r.desc}`);
    }
    console.log('');

    console.log('--- macOS Seatbelt (SBPL) Profile Suite ---');
    for (const r of report.macosProfileSuite) {
      console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.id.padEnd(32)} — ${r.desc}`);
    }
    console.log('');

    console.log('--- End-to-End Headless Runner & Fail-Closed Suite ---');
    for (const r of report.e2eRunnerSuite) {
      console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.id.padEnd(32)} — ${r.detail}`);
    }
    console.log('');

    console.log(`SUMMARY: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed.`);
  }

  process.exit(report.summary.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
