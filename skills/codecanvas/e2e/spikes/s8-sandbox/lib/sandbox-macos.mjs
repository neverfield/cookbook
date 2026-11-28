import fs from 'node:fs';
import path from 'node:path';
import { SandboxUnavailableError, buildConfinedEnv } from './sandbox-linux.mjs';

function escapeSbplString(value) {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Refusing control character in Seatbelt path: ${JSON.stringify(value)}`);
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizePath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Generates an Apple Seatbelt (SBPL) profile for macOS `sandbox-exec`.
 *
 * Strategy (matches Claude Code / @anthropic-ai/sandbox-runtime on macOS):
 * - Start with `(allow default)` so dyld, Mach IPC, and read-only system tooling work.
 * - Globally `(deny file-write*)` across the entire filesystem (covers create,
 *   modify, unlink, rename, hardlink, truncate, chmod, and xattr).
 * - Narrowly `(allow file-write* ...)` ONLY for `cloneDir`, `scratchDir`, and
 *   character device sinks (`/dev/null`, `/dev/dtracehelper`, `/dev/tty*`).
 * - Explicitly `(deny file-read* ...)` on `~/.codecanvas/secrets.json` (and any
 *   configured secret paths) so secrets never leak to the agent process.
 */
export function generateMacosSeatbeltProfile(options) {
  const cloneDir = normalizePath(options.cloneDir);
  const scratchDir = normalizePath(options.scratchDir);
  const extraRw = (options.extraAllowRw ?? []).map(normalizePath);
  const denyReadPaths = (options.denyReadPaths ?? []).map(normalizePath);

  const allowSubpaths = [cloneDir, scratchDir, ...extraRw]
    .map((p) => `  (subpath "${escapeSbplString(p)}")`)
    .join('\n');

  const denyReadClauses = denyReadPaths.length
    ? `\n;; Deny reading codecanvas secrets\n(deny file-read*\n${denyReadPaths
        .map((p) => `  (subpath "${escapeSbplString(p)}")`)
        .join('\n')}\n)\n`
    : '';

  return [
    '(version 1)',
    ';; codecanvas v2 macOS Seatbelt profile — clone write confinement',
    '(allow default)',
    '',
    ';; Default-deny all filesystem writes outside the task clone',
    '(deny file-write*)',
    '',
    ';; Allow writes strictly inside cloneDir, clone scratchDir, and null/tty sinks',
    '(allow file-write*',
    allowSubpaths,
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/tty")',
    ')',
    denyReadClauses.trimEnd(),
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

export function wrapForMacosSandbox(cmd, args, options, probe) {
  if (options.disableAllBackends || !probe.primitives.sandboxExec.functional) {
    throw new SandboxUnavailableError(
      'macOS sandbox-exec is unavailable: codecanvas refuses unsandboxed agent execution (fail-closed per §10.2).',
      { platform: process.platform, sandboxExec: probe.primitives.sandboxExec },
    );
  }

  const profile = generateMacosSeatbeltProfile(options);
  const profilePath = path.join(fs.realpathSync(options.scratchDir), 'codecanvas-seatbelt.sb');
  fs.writeFileSync(profilePath, profile, { mode: 0o600 });

  return {
    backend: 'sandbox-exec',
    command: 'sandbox-exec',
    args: ['-f', profilePath, '--', cmd, ...args],
    profilePath,
    profile,
    env: buildConfinedEnv(options),
  };
}
