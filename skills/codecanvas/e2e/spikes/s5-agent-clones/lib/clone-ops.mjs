import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { runCommand } from './process-mgr.mjs';

const ENV_TEMPLATE_NAMES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
]);
const MAX_ENV_FILE_BYTES = 1024 * 1024;

export async function measureDirStats(dirPath) {
  const [diskRes, apparentRes] = await Promise.all([
    runCommand('du', ['-sk', dirPath]),
    runCommand('du', ['-sk', '--apparent-size', dirPath]),
  ]);

  const diskKb = Number.parseInt(diskRes.stdout.trim().split(/\s+/)[0], 10);
  const apparentKb = Number.parseInt(apparentRes.stdout.trim().split(/\s+/)[0], 10);
  return {
    diskKb,
    apparentKb,
    diskMb: Number((diskKb / 1024).toFixed(2)),
    apparentMb: Number((apparentKb / 1024).toFixed(2)),
  };
}

export async function measureIncrementalDiskKb(baseDir, cloneDir) {
  const [baseRes, combinedRes] = await Promise.all([
    runCommand('du', ['-sk', baseDir]),
    runCommand('du', ['-sk', baseDir, cloneDir]),
  ]);

  const baseKb = Number.parseInt(baseRes.stdout.trim().split(/\s+/)[0], 10);
  const lines = combinedRes.stdout.trim().split('\n');
  // GNU du deduplicates inodes across arguments, so the second line is strictly
  // the blocks unique to cloneDir (not shared with baseDir).
  const incrementalKb = Number.parseInt(lines[1].trim().split(/\s+/)[0], 10);
  return {
    baseKb,
    incrementalKb,
    incrementalMb: Number((incrementalKb / 1024).toFixed(2)),
  };
}

export async function createSharedClone(parentDir, destDir, options = {}) {
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  const startedAt = performance.now();
  await runCommand('git', ['clone', '--shared', '--quiet', parentDir, destDir], {
    cpuList: options.cpuList ?? null,
  });
  const elapsedMs = performance.now() - startedAt;

  const gitEntry = await fs.lstat(path.join(destDir, '.git'));
  const alternatesPath = path.join(destDir, '.git', 'objects', 'info', 'alternates');
  const alternatesContent = (await fs.readFile(alternatesPath, 'utf8')).trim();

  return {
    elapsedMs,
    hasOwnGitDir: gitEntry.isDirectory(),
    alternatesContent,
  };
}

export async function createWorktree(parentDir, destDir, options = {}) {
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  const startedAt = performance.now();
  await runCommand('git', ['worktree', 'add', '--detach', '--quiet', destDir, 'HEAD'], {
    cwd: parentDir,
    cpuList: options.cpuList ?? null,
  });
  const elapsedMs = performance.now() - startedAt;

  const gitEntry = await fs.lstat(path.join(destDir, '.git'));
  const gitFileContent = gitEntry.isFile()
    ? (await fs.readFile(path.join(destDir, '.git'), 'utf8')).trim()
    : null;

  return {
    elapsedMs,
    hasOwnGitDir: gitEntry.isDirectory(),
    gitPointer: gitFileContent,
  };
}

export async function removeWorktree(parentDir, destDir) {
  await runCommand('git', ['worktree', 'remove', '--force', destDir], {
    cwd: parentDir,
    allowFailure: true,
  });
  await fs.rm(destDir, { recursive: true, force: true });
}

export async function createFullClone(parentDir, destDir, options = {}) {
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  const startedAt = performance.now();
  await runCommand('git', ['clone', '--no-hardlinks', '--quiet', parentDir, destDir], {
    cpuList: options.cpuList ?? null,
  });
  const elapsedMs = performance.now() - startedAt;

  const gitEntry = await fs.lstat(path.join(destDir, '.git'));
  return {
    elapsedMs,
    hasOwnGitDir: gitEntry.isDirectory(),
  };
}

export async function applyPatchInClone(cloneDir, patchText) {
  const startedAt = performance.now();
  await runCommand('git', ['apply', '--whitespace=nowarn', '-'], {
    cwd: cloneDir,
    input: patchText,
  });
  return { elapsedMs: performance.now() - startedAt };
}

export async function getGitStatusPorcelain(repoDir) {
  const res = await runCommand('git', ['status', '--porcelain'], { cwd: repoDir });
  return res.stdout.trim();
}

function isContainedInside(rootRealPath, candidatePath) {
  const rel = path.relative(rootRealPath, candidatePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Safely copies .env* files from allowlisted subdirectories of parentDir into cloneDir.
 * - Rejects symlinks (prevents symlink escape attacks)
 * - Rejects path traversal outside parentDir/cloneDir
 * - Skips template files (.env.example, etc.) and already-identical tracked defaults if desired
 * - Enforces 0600 permissions on copied .local / secret env files
 */
export async function copyEnvFilesSafely(parentDir, cloneDir, options = {}) {
  const { searchDirs = ['.', 'apps/web'], extraCandidatePaths = [] } = options;
  const startedAt = performance.now();

  const parentReal = await fs.realpath(parentDir);
  const cloneReal = await fs.realpath(cloneDir);

  const candidates = new Set();

  for (const relDir of searchDirs) {
    const absDir = path.resolve(parentReal, relDir);
    if (absDir !== parentReal && !isContainedInside(parentReal, absDir)) {
      continue;
    }
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.env' || entry.name.startsWith('.env.')) {
        const relPath = path.posix.join(
          relDir === '.' ? '' : relDir.split(path.sep).join('/'),
          entry.name,
        );
        candidates.add(relPath);
      }
    }
  }

  for (const extra of extraCandidatePaths) {
    candidates.add(extra);
  }

  const copied = [];
  const skipped = [];
  const rejected = [];

  for (const relPath of [...candidates].sort()) {
    const baseName = path.basename(relPath);
    if (ENV_TEMPLATE_NAMES.has(baseName)) {
      skipped.push({ path: relPath, reason: 'template-file' });
      continue;
    }

    const srcAbs = path.resolve(parentReal, relPath);
    if (!isContainedInside(parentReal, srcAbs)) {
      rejected.push({ path: relPath, reason: 'path-traversal-outside-parent' });
      continue;
    }

    let lstat;
    try {
      lstat = await fs.lstat(srcAbs);
    } catch {
      skipped.push({ path: relPath, reason: 'not-found' });
      continue;
    }

    if (lstat.isSymbolicLink()) {
      rejected.push({ path: relPath, reason: 'symlink-not-allowed' });
      continue;
    }

    if (!lstat.isFile()) {
      rejected.push({ path: relPath, reason: 'non-regular-file' });
      continue;
    }

    if (lstat.size > MAX_ENV_FILE_BYTES) {
      rejected.push({ path: relPath, reason: 'exceeds-size-limit' });
      continue;
    }

    const srcReal = await fs.realpath(srcAbs);
    if (!isContainedInside(parentReal, srcReal)) {
      rejected.push({ path: relPath, reason: 'realpath-outside-parent' });
      continue;
    }

    const dstAbs = path.resolve(cloneReal, relPath);
    if (!isContainedInside(cloneReal, dstAbs)) {
      rejected.push({ path: relPath, reason: 'dest-outside-clone' });
      continue;
    }

    await fs.mkdir(path.dirname(dstAbs), { recursive: true });
    await fs.copyFile(srcReal, dstAbs);

    const isSecretLocal = baseName.endsWith('.local') || baseName === '.env';
    if (isSecretLocal) {
      await fs.chmod(dstAbs, 0o600);
    }

    const dstStat = await fs.stat(dstAbs);
    copied.push({
      path: relPath,
      bytes: lstat.size,
      mode: `0${(dstStat.mode & 0o777).toString(8)}`,
    });
  }

  return {
    elapsedMs: performance.now() - startedAt,
    copied,
    skipped,
    rejected,
  };
}
