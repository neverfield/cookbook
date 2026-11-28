import fs from 'node:fs/promises';
import type {
  ContainmentViolation,
  Diagnostic,
  EditTransactionResult,
  JournalRecord,
  JournalRecoveryReport,
  ProposedFileEdit,
  ResolvedWriteTarget,
  SyntaxValidator,
  WriteContainmentPolicy,
} from '@codecanvas/protocol';
import { checkPathContainment } from './containment.js';
import {
  executeJournaledWrite,
  readJournalRecord,
  recoverJournal as recoverWorkspaceJournal,
  type JournalFsHooks,
  type StagedFileInput,
} from './journal.js';
import { applyTextEdits, TextEditApplyError } from './text-edits.js';
import { createDefaultValidator } from './validator.js';

export interface EditEngineOptions {
  workspaceRoot: string;
  policy?: WriteContainmentPolicy;
  validator?: SyntaxValidator;
  fsHooks?: JournalFsHooks;
}

export interface ApplyTransactionOptions {
  txnId?: string;
  fsHooks?: JournalFsHooks;
}

export type BatchContainmentResult =
  | { ok: true; targets: ResolvedWriteTarget[] }
  | { ok: false; violations: ContainmentViolation[] };

/**
 * Core codecanvas v2 edit engine implementing architecture-v2 §8.2:
 * - Step 1: Realpath containment inside `policy.writeRoots`, outside `.git`,
 *   `node_modules`, `.codecanvas/cache`, and `policy.protected`.
 * - Step 2: Pre-write parse validation across JS/TS/JSX/TSX, CSS/SCSS, and JSON
 *   with zero disk writes on failure.
 * - Step 4: Durable journal + atomic multi-file commit via `.codecanvas/cache/tmp/`,
 *   full rollback on mid-commit failure, and startup crash recovery.
 */
export class EditEngine {
  readonly workspaceRoot: string;
  readonly policy: WriteContainmentPolicy;
  readonly validator: SyntaxValidator;
  private readonly defaultFsHooks?: JournalFsHooks;
  private serialQueue: Promise<unknown> = Promise.resolve();

  constructor(options: EditEngineOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.policy = options.policy ?? {};
    this.validator = options.validator ?? createDefaultValidator();
    this.defaultFsHooks = options.fsHooks;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.serialQueue.then(task, task);
    this.serialQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async checkContainment(
    files: readonly string[],
  ): Promise<BatchContainmentResult> {
    const targets: ResolvedWriteTarget[] = [];
    const violations: ContainmentViolation[] = [];

    for (const file of files) {
      const check = await checkPathContainment(
        this.workspaceRoot,
        file,
        this.policy,
      );
      if (check.ok) {
        targets.push(check.target);
      } else {
        violations.push(check.violation);
      }
    }

    if (violations.length > 0) {
      return { ok: false, violations };
    }
    return { ok: true, targets };
  }

  validate(file: string, content: string): Diagnostic[] {
    return this.validator.validate(file, content);
  }

  async apply(
    edits: readonly ProposedFileEdit[],
    options: ApplyTransactionOptions = {},
  ): Promise<EditTransactionResult> {
    return this.enqueue(() => this.applySerialized(edits, options));
  }

  async recoverJournal(): Promise<JournalRecoveryReport> {
    return this.enqueue(() =>
      recoverWorkspaceJournal(this.workspaceRoot, this.policy),
    );
  }

  async readJournal(txnId: string): Promise<JournalRecord | null> {
    return readJournalRecord(this.workspaceRoot, txnId);
  }

  private async applySerialized(
    edits: readonly ProposedFileEdit[],
    options: ApplyTransactionOptions,
  ): Promise<EditTransactionResult> {
    if (edits.length === 0) {
      return {
        ok: false,
        stage: 'input',
        message: 'Transaction must include at least one file edit.',
        rolledBack: false,
      };
    }

    // Step 1: Path containment check across ALL proposed edits (zero disk writes).
    const containment = await this.checkContainment(
      edits.map((edit) => edit.file),
    );
    if (!containment.ok) {
      return {
        ok: false,
        stage: 'containment',
        message: containment.violations
          .map((v) => `${v.file}: ${v.message}`)
          .join('; '),
        containmentViolations: containment.violations,
        rolledBack: false,
      };
    }

    // Reject duplicate canonical targets within the same transaction.
    const seenCanonical = new Set<string>();
    for (const target of containment.targets) {
      if (seenCanonical.has(target.canonicalPath)) {
        return {
          ok: false,
          stage: 'input',
          message: `Duplicate target file in transaction: "${target.file}" (resolves to "${target.canonicalRelativePath}").`,
          rolledBack: false,
        };
      }
      seenCanonical.add(target.canonicalPath);
    }

    // Compute full proposed file contents in memory before touching disk.
    const stagedInputs: StagedFileInput[] = [];
    for (let i = 0; i < edits.length; i += 1) {
      const edit = edits[i]!;
      const target = containment.targets[i]!;
      let proposedContent: string;

      switch (edit.kind) {
        case 'content': {
          proposedContent = edit.content;
          break;
        }
        case 'edits': {
          let currentContent: string;
          try {
            currentContent = await fs.readFile(target.canonicalPath, 'utf8');
          } catch (error) {
            return {
              ok: false,
              stage: 'apply-edits',
              message: `Failed to read "${target.file}" for surgical TextEdits: ${error instanceof Error ? error.message : String(error)}`,
              rolledBack: false,
            };
          }
          try {
            proposedContent = applyTextEdits(
              target.file,
              currentContent,
              edit.edits,
            );
          } catch (error) {
            return {
              ok: false,
              stage: 'apply-edits',
              message:
                error instanceof TextEditApplyError
                  ? error.message
                  : `Failed to apply TextEdits to "${target.file}": ${String(error)}`,
              rolledBack: false,
            };
          }
          break;
        }
        default: {
          const exhaustive: never = edit;
          throw new Error(`Unhandled ProposedFileEdit kind: ${String(exhaustive)}`);
        }
      }

      stagedInputs.push({ target, content: proposedContent });
    }

    // Step 2: Pre-write parse validation across ALL files (zero disk writes on error).
    const errorDiagnostics: Diagnostic[] = [];
    for (const input of stagedInputs) {
      const diagnostics = this.validator.validate(
        input.target.file,
        input.content,
      );
      for (const diag of diagnostics) {
        if (diag.severity === 'error') {
          errorDiagnostics.push(diag);
        }
      }
    }

    if (errorDiagnostics.length > 0) {
      const first = errorDiagnostics[0]!;
      return {
        ok: false,
        stage: 'validation',
        message: `Pre-write syntax validation failed (${errorDiagnostics.length} error${errorDiagnostics.length === 1 ? '' : 's'}): ${first.file}:${first.line ?? 1}:${first.column ?? first.col ?? 1}: ${first.message}`,
        diagnostics: errorDiagnostics,
        rolledBack: false,
      };
    }

    // Step 4: Durable journal + atomic multi-file commit via `.codecanvas/cache/tmp/`.
    const workspaceReal = await fs.realpath(this.workspaceRoot);
    const fsHooks = options.fsHooks ?? this.defaultFsHooks;
    const outcome = await executeJournaledWrite(workspaceReal, stagedInputs, {
      ...(options.txnId !== undefined ? { txnId: options.txnId } : {}),
      ...(fsHooks !== undefined ? { fsHooks } : {}),
    });

    if (!outcome.ok) {
      return {
        ok: false,
        txnId: outcome.txnId,
        stage: outcome.stage,
        message: outcome.message,
        rolledBack: outcome.rolledBack,
        ...(outcome.rollbackErrors.length > 0
          ? { rollbackErrors: outcome.rollbackErrors }
          : {}),
      };
    }

    return {
      ok: true,
      txnId: outcome.txnId,
      journalPath: outcome.journalPath,
      files: outcome.files,
    };
  }
}
