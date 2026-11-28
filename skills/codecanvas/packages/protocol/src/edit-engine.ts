import type { Diagnostic, TextEdit } from './adapters.js';

/**
 * Write-containment policy matching architecture-v2 §8.2 step 1 and §9.5.
 */
export interface WriteContainmentPolicy {
  /**
   * Workspace-relative directories where writes are permitted.
   * When omitted, defaults to `['.']` (workspace root, still excluding `.git`,
   * `node_modules`, `.codecanvas/cache`, and `protected` globs).
   * When explicitly empty (`[]`), all writes are denied.
   */
  writeRoots?: readonly string[];
  /**
   * Workspace-relative glob patterns that are always read-only
   * (e.g. `['**\/*.config.*', '**\/generated/**', '**\/*.lock', '.github/**']`).
   */
  protected?: readonly string[];
}

export type ContainmentRejectionReason =
  | 'empty-path'
  | 'control-characters'
  | 'not-workspace-relative'
  | 'path-traversal'
  | 'symlink-escape'
  | 'symlink-loop'
  | 'outside-workspace'
  | 'outside-write-roots'
  | 'forbidden-directory'
  | 'protected-path'
  | 'target-is-directory'
  | 'not-a-directory';

export interface ContainmentViolation {
  file: string;
  reason: ContainmentRejectionReason;
  message: string;
  resolvedPath?: string;
}

export interface ResolvedWriteTarget {
  /** Normalized POSIX workspace-relative requested path. */
  file: string;
  /** Canonical POSIX workspace-relative path after resolving symlinks. */
  canonicalRelativePath: string;
  /** Canonical absolute filesystem path on disk. */
  canonicalPath: string;
  /** Matched canonical write root (POSIX workspace-relative, '.' for workspace root). */
  writeRoot: string;
}

/**
 * A proposed edit to a single workspace-relative file.
 * Supports either full-file content replacement or surgical TextEdit ranges.
 */
export type ProposedFileEdit =
  | {
      kind: 'content';
      file: string;
      content: string;
    }
  | {
      kind: 'edits';
      file: string;
      edits: readonly TextEdit[];
    };

export type JournalStatus = 'pending' | 'committed' | 'rolled-back';

export interface JournalFileEntry {
  /** Normalized POSIX workspace-relative path. */
  file: string;
  /** Canonical absolute path resolved at prepare time. */
  canonicalPath: string;
  /** Whether the file existed prior to this transaction. */
  existed: boolean;
  /** Path relative to `.codecanvas/cache/` of the before-snapshot blob (when existed is true). */
  beforeBlobPath?: string;
  /** SHA-256 hex digest of original bytes (when existed is true). */
  beforeSha256?: string;
  /** File mode bits captured before write (when existed is true). */
  beforeMode?: number;
  /** SHA-256 hex digest of target bytes written by this transaction. */
  afterSha256: string;
  /** Path relative to `.codecanvas/cache/` of the staged temp file under `tmp/`. */
  tmpPath: string;
  /** Newly created parent directories (canonical absolute paths, shallowest first) for rollback cleanup. */
  createdDirs?: string[];
}

export interface JournalRecord {
  version: 1;
  txnId: string;
  status: JournalStatus;
  createdAt: string;
  updatedAt: string;
  committedAt?: string;
  rolledBackAt?: string;
  rollbackReason?: string;
  entries: JournalFileEntry[];
}

export interface EditTransactionFileResult {
  file: string;
  canonicalPath: string;
  existed: boolean;
  beforeSha256?: string;
  afterSha256: string;
  bytesWritten: number;
}

export interface EditTransactionSuccess {
  ok: true;
  txnId: string;
  journalPath: string;
  files: EditTransactionFileResult[];
}

export type EditFailureStage =
  | 'input'
  | 'containment'
  | 'apply-edits'
  | 'validation'
  | 'prepare'
  | 'commit';

export interface EditTransactionFailure {
  ok: false;
  txnId?: string;
  stage: EditFailureStage;
  message: string;
  containmentViolations?: ContainmentViolation[];
  diagnostics?: Diagnostic[];
  rolledBack: boolean;
  rollbackErrors?: string[];
}

export type EditTransactionResult =
  | EditTransactionSuccess
  | EditTransactionFailure;

export interface JournalRecoveryError {
  txnId?: string;
  file?: string;
  message: string;
}

export interface JournalRecoveryReport {
  recoveredTxnIds: string[];
  restoredFiles: string[];
  removedFiles: string[];
  cleanedTempFiles: string[];
  errors: JournalRecoveryError[];
}

/**
 * Validator seam compatible with LanguageAdapter.validate (architecture-v2 §5, §8.2 step 2).
 */
export interface SyntaxValidator {
  validate(file: string, text: string): Diagnostic[];
}
