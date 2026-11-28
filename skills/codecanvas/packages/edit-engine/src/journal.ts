import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  EditTransactionFileResult,
  JournalFileEntry,
  JournalRecord,
  JournalRecoveryError,
  JournalRecoveryReport,
  ResolvedWriteTarget,
  WriteContainmentPolicy,
} from '@codecanvas/protocol';
import { checkPathContainment, isPathInside } from './containment.js';

export const CODECANVAS_DIR = '.codecanvas';
export const CACHE_SUBDIR = 'cache';
export const TMP_SUBDIR = 'tmp';
export const JOURNAL_SUBDIR = 'journal';
export const BLOBS_SUBDIR = 'blobs';

const VALID_TXN_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

export interface CachePaths {
  workspaceReal: string;
  cacheDir: string;
  tmpDir: string;
  journalDir: string;
  blobsDir: string;
}

export interface StagedFileInput {
  target: ResolvedWriteTarget;
  content: string;
}

export interface JournalFsHooks {
  /**
   * Override for target file rename during Phase 2 commit (for deterministic
   * fault injection in tests).
   */
  commitRename?: (from: string, to: string) => Promise<void>;
  /** Called right before committing each entry in Phase 2. */
  onBeforeCommitEntry?: (
    entry: JournalFileEntry,
    index: number,
  ) => Promise<void> | void;
  /** Called right after committing each entry in Phase 2. */
  onAfterCommitEntry?: (
    entry: JournalFileEntry,
    index: number,
  ) => Promise<void> | void;
  /** Called right after the durable `pending` journal is written on disk. */
  onAfterPendingJournal?: (
    record: JournalRecord,
    journalPath: string,
  ) => Promise<void> | void;
}

export interface JournalWriteOutcome {
  ok: true;
  txnId: string;
  journalPath: string;
  files: EditTransactionFileResult[];
}

export interface JournalWriteFailure {
  ok: false;
  txnId: string;
  stage: 'prepare' | 'commit';
  message: string;
  rolledBack: boolean;
  rollbackErrors: string[];
}

export type JournalCommitResult = JournalWriteOutcome | JournalWriteFailure;

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function sha256Hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function generateTxnId(): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(6).toString('hex');
  return `txn-${ts}-${rand}`;
}

export function assertValidTxnId(txnId: string): void {
  if (!VALID_TXN_ID_RE.test(txnId) || txnId === '.' || txnId === '..') {
    throw new Error(
      `Invalid transaction id "${txnId}": must match ${VALID_TXN_ID_RE.source}.`,
    );
  }
}

export function getCachePaths(workspaceReal: string): CachePaths {
  const cacheDir = path.join(workspaceReal, CODECANVAS_DIR, CACHE_SUBDIR);
  const tmpDir = path.join(cacheDir, TMP_SUBDIR);
  const journalDir = path.join(cacheDir, JOURNAL_SUBDIR);
  const blobsDir = path.join(journalDir, BLOBS_SUBDIR);
  return {
    workspaceReal,
    cacheDir,
    tmpDir,
    journalDir,
    blobsDir,
  };
}

export function getJournalFilePath(paths: CachePaths, txnId: string): string {
  assertValidTxnId(txnId);
  return path.join(paths.journalDir, `${txnId}.json`);
}

async function writeBufferWithFsync(
  filePath: string,
  data: Buffer,
  mode?: number,
): Promise<void> {
  const handle = await fs.open(filePath, 'w', mode ?? 0o666);
  try {
    await handle.writeFile(data);
    if (mode !== undefined) {
      await handle.chmod(mode);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(dirPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dirPath, 'r');
    await handle.sync();
  } catch (error) {
    const code = getErrnoCode(error);
    if (
      code === 'EINVAL' ||
      code === 'EBADF' ||
      code === 'EPERM' ||
      code === 'EISDIR' ||
      code === 'ENOSYS' ||
      code === 'ENOENT'
    ) {
      return;
    }
    throw error;
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
  }
}

async function unlinkIfExists(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function writeJournalRecordAtomic(
  paths: CachePaths,
  record: JournalRecord,
): Promise<string> {
  await fs.mkdir(paths.tmpDir, { recursive: true });
  await fs.mkdir(paths.journalDir, { recursive: true });

  const journalPath = getJournalFilePath(paths, record.txnId);
  const tmpJournalPath = path.join(paths.tmpDir, `${record.txnId}.journal.tmp`);
  const payload = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');

  await writeBufferWithFsync(tmpJournalPath, payload);
  await fs.rename(tmpJournalPath, journalPath);
  await fsyncDirectory(paths.journalDir);
  return journalPath;
}

async function computeMissingParentDirs(
  canonicalFilePath: string,
  workspaceReal: string,
): Promise<string[]> {
  const missing: string[] = [];
  let cursor = path.dirname(canonicalFilePath);

  while (cursor !== workspaceReal && isPathInside(cursor, workspaceReal)) {
    try {
      await fs.lstat(cursor);
      break;
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        missing.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          break;
        }
        cursor = parent;
        continue;
      }
      throw error;
    }
  }

  missing.reverse();
  return missing;
}

interface RollbackStats {
  restoredFiles: string[];
  removedFiles: string[];
  errors: string[];
}

async function rollbackJournalRecord(
  paths: CachePaths,
  record: JournalRecord,
  options: {
    reason: string;
    maxTouchedIndex?: number;
  },
): Promise<RollbackStats> {
  const restoredFiles: string[] = [];
  const removedFiles: string[] = [];
  const errors: string[] = [];

  await fs.mkdir(paths.tmpDir, { recursive: true });

  const startIndex =
    options.maxTouchedIndex !== undefined
      ? Math.min(options.maxTouchedIndex, record.entries.length - 1)
      : record.entries.length - 1;

  for (let i = startIndex; i >= 0; i -= 1) {
    const entry = record.entries[i]!;
    try {
      if (entry.existed) {
        if (!entry.beforeBlobPath || !entry.beforeSha256) {
          errors.push(
            `Missing before-snapshot metadata for "${entry.file}" in txn "${record.txnId}".`,
          );
          continue;
        }

        const absBlobPath = path.join(paths.cacheDir, entry.beforeBlobPath);
        const beforeBytes = await fs.readFile(absBlobPath);
        const actualSha = sha256Hex(beforeBytes);
        if (actualSha !== entry.beforeSha256) {
          errors.push(
            `Before-snapshot checksum mismatch for "${entry.file}" in txn "${record.txnId}".`,
          );
          continue;
        }

        let needsRestore = true;
        try {
          const [currentBytes, currentStat] = await Promise.all([
            fs.readFile(entry.canonicalPath),
            fs.stat(entry.canonicalPath),
          ]);
          const modeMatches =
            entry.beforeMode === undefined ||
            (currentStat.mode & 0o7777) === entry.beforeMode;
          if (Buffer.compare(currentBytes, beforeBytes) === 0 && modeMatches) {
            needsRestore = false;
          }
        } catch (readErr) {
          if (getErrnoCode(readErr) !== 'ENOENT') {
            throw readErr;
          }
        }

        if (needsRestore) {
          await fs.mkdir(path.dirname(entry.canonicalPath), { recursive: true });
          const rollbackTmpPath = path.join(
            paths.tmpDir,
            `${record.txnId}-rb-${i}.tmp`,
          );
          await writeBufferWithFsync(
            rollbackTmpPath,
            beforeBytes,
            entry.beforeMode,
          );
          await fs.rename(rollbackTmpPath, entry.canonicalPath);
          await fsyncDirectory(path.dirname(entry.canonicalPath));
          restoredFiles.push(entry.file);
        }
      } else {
        const removed = await unlinkIfExists(entry.canonicalPath);
        if (removed) {
          removedFiles.push(entry.file);
        }
        if (entry.createdDirs && entry.createdDirs.length > 0) {
          for (let d = entry.createdDirs.length - 1; d >= 0; d -= 1) {
            const createdDir = entry.createdDirs[d]!;
            if (!isPathInside(createdDir, paths.workspaceReal)) {
              continue;
            }
            try {
              await fs.rmdir(createdDir);
            } catch (rmdirErr) {
              const code = getErrnoCode(rmdirErr);
              if (
                code !== 'ENOENT' &&
                code !== 'ENOTEMPTY' &&
                code !== 'EEXIST'
              ) {
                throw rmdirErr;
              }
            }
          }
        }
      }
    } catch (error) {
      errors.push(
        `Failed to roll back "${entry.file}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const entry of record.entries) {
    const absTmpPath = path.join(paths.cacheDir, entry.tmpPath);
    try {
      await unlinkIfExists(absTmpPath);
    } catch (error) {
      errors.push(
        `Failed to clean temp file "${entry.tmpPath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const nowIso = new Date().toISOString();
  const updatedRecord: JournalRecord = {
    ...record,
    status: 'rolled-back',
    updatedAt: nowIso,
    rolledBackAt: nowIso,
    rollbackReason: options.reason,
  };
  try {
    await writeJournalRecordAtomic(paths, updatedRecord);
  } catch (error) {
    errors.push(
      `Failed to mark journal "${record.txnId}" rolled-back: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { restoredFiles, removedFiles, errors };
}

/**
 * Execute an atomic multi-file journaled commit (§8.2 step 4).
 *
 * All staging temp files are written inside `.codecanvas/cache/tmp/` (never
 * inside source directories, honoring Invariant I1), before-snapshots are
 * persisted under `.codecanvas/cache/journal/blobs/<txnId>/`, a durable
 * `pending` journal is written and fsynced before any target rename, and any
 * mid-commit failure restores ALL touched files to their exact original bytes.
 */
export async function executeJournaledWrite(
  workspaceReal: string,
  stagedInputs: readonly StagedFileInput[],
  options: {
    txnId?: string;
    fsHooks?: JournalFsHooks;
  } = {},
): Promise<JournalCommitResult> {
  const txnId = options.txnId ?? generateTxnId();
  assertValidTxnId(txnId);

  const paths = getCachePaths(workspaceReal);
  const txnBlobDir = path.join(paths.blobsDir, txnId);

  const entries: JournalFileEntry[] = [];
  const fileResults: EditTransactionFileResult[] = [];
  const createdTempPaths: string[] = [];

  // Phase 1: Stage before-snapshots and temp files inside `.codecanvas/cache/tmp/`.
  try {
    await fs.mkdir(paths.tmpDir, { recursive: true });
    await fs.mkdir(paths.journalDir, { recursive: true });
    await fs.mkdir(txnBlobDir, { recursive: true });

    for (let i = 0; i < stagedInputs.length; i += 1) {
      const input = stagedInputs[i]!;
      const canonicalPath = input.target.canonicalPath;
      const afterBytes = Buffer.from(input.content, 'utf8');
      const afterSha256 = sha256Hex(afterBytes);

      let existed = false;
      let beforeBlobRelPath: string | undefined;
      let beforeSha256: string | undefined;
      let beforeMode: number | undefined;
      let createdDirs: string[] | undefined;

      try {
        const [beforeBytes, stat] = await Promise.all([
          fs.readFile(canonicalPath),
          fs.stat(canonicalPath),
        ]);
        existed = true;
        beforeMode = stat.mode & 0o7777;
        beforeSha256 = sha256Hex(beforeBytes);
        beforeBlobRelPath = path
          .join(JOURNAL_SUBDIR, BLOBS_SUBDIR, txnId, `${i}.before`)
          .split(path.sep)
          .join('/');
        const absBlobPath = path.join(paths.cacheDir, beforeBlobRelPath);
        await writeBufferWithFsync(absBlobPath, beforeBytes);
      } catch (error) {
        if (getErrnoCode(error) !== 'ENOENT') {
          throw error;
        }
        existed = false;
        const missingDirs = await computeMissingParentDirs(
          canonicalPath,
          workspaceReal,
        );
        if (missingDirs.length > 0) {
          createdDirs = missingDirs;
        }
      }

      const tmpRelPath = path
        .join(TMP_SUBDIR, `${txnId}-${i}.tmp`)
        .split(path.sep)
        .join('/');
      const absTmpPath = path.join(paths.cacheDir, tmpRelPath);
      await writeBufferWithFsync(absTmpPath, afterBytes, beforeMode);
      createdTempPaths.push(absTmpPath);

      entries.push({
        file: input.target.file,
        canonicalPath,
        existed,
        ...(beforeBlobRelPath !== undefined
          ? { beforeBlobPath: beforeBlobRelPath }
          : {}),
        ...(beforeSha256 !== undefined ? { beforeSha256 } : {}),
        ...(beforeMode !== undefined ? { beforeMode } : {}),
        afterSha256,
        tmpPath: tmpRelPath,
        ...(createdDirs !== undefined ? { createdDirs } : {}),
      });

      fileResults.push({
        file: input.target.file,
        canonicalPath,
        existed,
        ...(beforeSha256 !== undefined ? { beforeSha256 } : {}),
        afterSha256,
        bytesWritten: afterBytes.byteLength,
      });
    }
  } catch (error) {
    const cleanupErrors: string[] = [];
    for (const tmpPath of createdTempPaths) {
      try {
        await unlinkIfExists(tmpPath);
      } catch (cleanupErr) {
        cleanupErrors.push(
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        );
      }
    }
    return {
      ok: false,
      txnId,
      stage: 'prepare',
      message: `Failed to stage transaction "${txnId}": ${error instanceof Error ? error.message : String(error)}`,
      rolledBack: cleanupErrors.length === 0,
      rollbackErrors: cleanupErrors,
    };
  }

  const nowIso = new Date().toISOString();
  const pendingRecord: JournalRecord = {
    version: 1,
    txnId,
    status: 'pending',
    createdAt: nowIso,
    updatedAt: nowIso,
    entries,
  };

  let journalPath: string;
  try {
    journalPath = await writeJournalRecordAtomic(paths, pendingRecord);
    if (options.fsHooks?.onAfterPendingJournal) {
      await options.fsHooks.onAfterPendingJournal(pendingRecord, journalPath);
    }
  } catch (error) {
    const cleanupErrors: string[] = [];
    for (const tmpPath of createdTempPaths) {
      try {
        await unlinkIfExists(tmpPath);
      } catch (cleanupErr) {
        cleanupErrors.push(
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        );
      }
    }
    return {
      ok: false,
      txnId,
      stage: 'prepare',
      message: `Failed to persist pending journal "${txnId}": ${error instanceof Error ? error.message : String(error)}`,
      rolledBack: cleanupErrors.length === 0,
      rollbackErrors: cleanupErrors,
    };
  }

  // Phase 2: Commit staged temp files into target paths via atomic rename.
  const renameFn = options.fsHooks?.commitRename ?? fs.rename;
  const touchedParentDirs = new Set<string>();
  let lastTouchedIndex = -1;

  try {
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const absTmpPath = path.join(paths.cacheDir, entry.tmpPath);
      const parentDir = path.dirname(entry.canonicalPath);

      if (options.fsHooks?.onBeforeCommitEntry) {
        await options.fsHooks.onBeforeCommitEntry(entry, i);
      }

      lastTouchedIndex = i;
      await fs.mkdir(parentDir, { recursive: true });
      await renameFn(absTmpPath, entry.canonicalPath);
      touchedParentDirs.add(parentDir);

      if (options.fsHooks?.onAfterCommitEntry) {
        await options.fsHooks.onAfterCommitEntry(entry, i);
      }
    }

    for (const dir of touchedParentDirs) {
      await fsyncDirectory(dir);
    }

    const committedAt = new Date().toISOString();
    const committedRecord: JournalRecord = {
      ...pendingRecord,
      status: 'committed',
      updatedAt: committedAt,
      committedAt,
    };
    await writeJournalRecordAtomic(paths, committedRecord);

    return {
      ok: true,
      txnId,
      journalPath,
      files: fileResults,
    };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error);
    const rollbackStats = await rollbackJournalRecord(paths, pendingRecord, {
      reason,
      maxTouchedIndex: lastTouchedIndex,
    });

    return {
      ok: false,
      txnId,
      stage: 'commit',
      message: `Commit failed for transaction "${txnId}": ${reason}`,
      rolledBack: rollbackStats.errors.length === 0,
      rollbackErrors: rollbackStats.errors,
    };
  }
}

export async function readJournalRecord(
  workspaceRoot: string,
  txnId: string,
): Promise<JournalRecord | null> {
  const workspaceReal = await fs.realpath(workspaceRoot);
  const paths = getCachePaths(workspaceReal);
  const journalPath = getJournalFilePath(paths, txnId);

  try {
    const raw = await fs.readFile(journalPath, 'utf8');
    return JSON.parse(raw) as JournalRecord;
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function isJournalRecord(value: unknown): value is JournalRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return (
    rec.version === 1 &&
    typeof rec.txnId === 'string' &&
    (rec.status === 'pending' ||
      rec.status === 'committed' ||
      rec.status === 'rolled-back') &&
    Array.isArray(rec.entries)
  );
}

/**
 * Startup crash recovery (§8.2 step 4):
 * Scans `.codecanvas/cache/journal/` for any incomplete `pending` journals left
 * behind by a crashed process, rolls them back from their before-snapshots,
 * marks them `rolled-back`, and removes any orphaned temp files from
 * `.codecanvas/cache/tmp/`.
 */
export async function recoverJournal(
  workspaceRoot: string,
  policy: WriteContainmentPolicy = {},
): Promise<JournalRecoveryReport> {
  const workspaceReal = await fs.realpath(workspaceRoot);
  const paths = getCachePaths(workspaceReal);

  const recoveredTxnIds: string[] = [];
  const restoredFiles: string[] = [];
  const removedFiles: string[] = [];
  const cleanedTempFiles: string[] = [];
  const errors: JournalRecoveryError[] = [];

  // 1. Scan `.codecanvas/cache/journal/` for pending journals.
  let journalFilenames: string[] = [];
  try {
    journalFilenames = (await fs.readdir(paths.journalDir)).filter((name) =>
      name.endsWith('.json'),
    );
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') {
      throw error;
    }
  }

  const pendingRecords: JournalRecord[] = [];
  for (const filename of journalFilenames) {
    const fullPath = path.join(paths.journalDir, filename);
    try {
      const raw = await fs.readFile(fullPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isJournalRecord(parsed)) {
        errors.push({
          file: filename,
          message: `Malformed journal record in "${filename}".`,
        });
        continue;
      }
      if (parsed.status === 'pending') {
        pendingRecords.push(parsed);
      }
    } catch (error) {
      errors.push({
        file: filename,
        message: `Failed to parse journal "${filename}": ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // Roll back newest pending transactions first to unwind in reverse order.
  pendingRecords.sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return b.createdAt.localeCompare(a.createdAt);
    }
    return b.txnId.localeCompare(a.txnId);
  });

  for (const record of pendingRecords) {
    let containmentSafe = true;
    for (const entry of record.entries) {
      if (!isPathInside(entry.canonicalPath, workspaceReal)) {
        containmentSafe = false;
        errors.push({
          txnId: record.txnId,
          file: entry.file,
          message: `Refused to recover entry "${entry.file}": canonicalPath escapes workspace.`,
        });
        continue;
      }
      const check = await checkPathContainment(workspaceReal, entry.file, policy);
      if (!check.ok) {
        containmentSafe = false;
        errors.push({
          txnId: record.txnId,
          file: entry.file,
          message: `Refused to recover entry "${entry.file}": ${check.violation.message}`,
        });
      }
    }

    if (!containmentSafe) {
      continue;
    }

    const stats = await rollbackJournalRecord(paths, record, {
      reason: 'crash-recovery',
    });

    recoveredTxnIds.push(record.txnId);
    restoredFiles.push(...stats.restoredFiles);
    removedFiles.push(...stats.removedFiles);
    for (const errMsg of stats.errors) {
      errors.push({ txnId: record.txnId, message: errMsg });
    }
  }

  // 2. Clean up any orphaned temp files in `.codecanvas/cache/tmp/`.
  let tmpEntries: string[] = [];
  try {
    tmpEntries = await fs.readdir(paths.tmpDir);
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') {
      throw error;
    }
  }

  for (const tmpName of tmpEntries) {
    const absTmp = path.join(paths.tmpDir, tmpName);
    try {
      const removed = await unlinkIfExists(absTmp);
      if (removed) {
        cleanedTempFiles.push(tmpName);
      }
    } catch (error) {
      errors.push({
        file: tmpName,
        message: `Failed to remove orphaned temp file "${tmpName}": ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return {
    recoveredTxnIds,
    restoredFiles,
    removedFiles,
    cleanedTempFiles,
    errors,
  };
}
