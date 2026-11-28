import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ContainmentRejectionReason,
  ContainmentViolation,
  ResolvedWriteTarget,
  WriteContainmentPolicy,
} from '@codecanvas/protocol';

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;
const MAX_SYMLINK_HOPS = 40;
const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules']);

export interface CanonicalizeSuccess {
  ok: true;
  canonicalPath: string;
  encounteredSymlink: boolean;
  existed: boolean;
  isDirectory: boolean;
}

export interface CanonicalizeFailure {
  ok: false;
  reason: 'symlink-loop' | 'not-a-directory';
  message: string;
}

export type CanonicalizeResult = CanonicalizeSuccess | CanonicalizeFailure;

export interface ContainmentCheckSuccess {
  ok: true;
  target: ResolvedWriteTarget;
}

export interface ContainmentCheckFailure {
  ok: false;
  violation: ContainmentViolation;
}

export type ContainmentCheckResult =
  | ContainmentCheckSuccess
  | ContainmentCheckFailure;

interface ResolvedWriteRoot {
  rel: string;
  canonical: string;
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function isPathInside(candidate: string, root: string): boolean {
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

function toPosixRelative(fromDir: string, target: string): string {
  const rel = path.relative(fromDir, target);
  if (rel.length === 0) {
    return '.';
  }
  return rel.split(path.sep).join('/');
}

/**
 * Compile a workspace-relative glob pattern (e.g. `**\/*.config.*`,
 * `**\/generated/**`, `.github/**`) into a RegExp matching POSIX relative paths.
 */
export function compileGlobPattern(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let regex = '^';
  let i = 0;

  while (i < normalized.length) {
    const ch = normalized[i]!;

    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 3;
          continue;
        }
        regex += '.*';
        i += 2;
        continue;
      }
      regex += '[^/]*';
      i += 1;
      continue;
    }

    if (ch === '/' && normalized.slice(i, i + 3) === '/**' && i + 3 === normalized.length) {
      regex += '(?:/.*)?';
      i += 3;
      continue;
    }

    if (ch === '?') {
      regex += '[^/]';
      i += 1;
      continue;
    }

    if (ch === '[') {
      const closeIdx = normalized.indexOf(']', i + 1);
      if (closeIdx !== -1) {
        let content = normalized.slice(i + 1, closeIdx);
        if (content.startsWith('!')) {
          content = `^${content.slice(1)}`;
        }
        regex += `[${content}]`;
        i = closeIdx + 1;
        continue;
      }
    }

    if (/[.+^${}()|[\]\\]/.test(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
    i += 1;
  }

  regex += '$';
  return new RegExp(regex);
}

export function matchesProtectedPatterns(
  posixRelativePath: string,
  patterns: readonly string[] | undefined,
): string | null {
  if (!patterns || patterns.length === 0) {
    return null;
  }
  for (const pattern of patterns) {
    if (compileGlobPattern(pattern).test(posixRelativePath)) {
      return pattern;
    }
  }
  return null;
}

function hasForbiddenDirectorySegment(posixRelativePath: string): string | null {
  const segments = posixRelativePath.split('/').filter(Boolean);
  for (const seg of segments) {
    if (FORBIDDEN_SEGMENTS.has(seg)) {
      return seg;
    }
  }
  if (segments[0] === '.codecanvas' && segments[1] === 'cache') {
    return '.codecanvas/cache';
  }
  return null;
}

/**
 * Canonicalize an absolute path by walking components with `lstat` and
 * resolving symlinks (including dangling symlinks and non-existent leaves via
 * the deepest existing ancestor's `realpath`).
 */
export async function canonicalizeTargetPath(
  absPath: string,
): Promise<CanonicalizeResult> {
  const parsedRoot = path.parse(absPath).root;
  let current = parsedRoot;
  const queue = absPath.slice(parsedRoot.length).split(path.sep).filter(Boolean);

  let symlinkHops = 0;
  let encounteredSymlink = false;
  let missingAncestor = false;
  let finalExisted = true;
  let finalIsDirectory = false;

  while (queue.length > 0) {
    const segment = queue.shift()!;
    if (segment === '.') {
      continue;
    }
    if (segment === '..') {
      current = path.dirname(current);
      if (missingAncestor) {
        // Re-check whether walking up landed back on an existing directory.
        try {
          await fs.lstat(current);
          missingAncestor = false;
        } catch {
          // Still missing.
        }
      }
      continue;
    }

    const next = path.join(current, segment);

    if (missingAncestor) {
      current = next;
      continue;
    }

    try {
      const stat = await fs.lstat(next);
      if (stat.isSymbolicLink()) {
        encounteredSymlink = true;
        symlinkHops += 1;
        if (symlinkHops > MAX_SYMLINK_HOPS) {
          return {
            ok: false,
            reason: 'symlink-loop',
            message: `Symlink resolution exceeded ${MAX_SYMLINK_HOPS} hops at "${next}".`,
          };
        }

        const linkTarget = await fs.readlink(next);
        if (path.isAbsolute(linkTarget)) {
          const targetRoot = path.parse(linkTarget).root;
          current = targetRoot;
          const targetSegments = linkTarget
            .slice(targetRoot.length)
            .split(path.sep)
            .filter(Boolean);
          queue.unshift(...targetSegments);
        } else {
          const targetSegments = linkTarget.split(path.sep).filter(Boolean);
          queue.unshift(...targetSegments);
        }
        continue;
      }

      current = next;
      if (queue.length === 0) {
        finalExisted = true;
        finalIsDirectory = stat.isDirectory();
      }
    } catch (error) {
      const code = getErrnoCode(error);
      if (code === 'ENOENT') {
        // Canonicalize the deepest existing ancestor with OS realpath before
        // appending non-existent leaf segments.
        try {
          current = await fs.realpath(current);
        } catch {
          // Ancestor already resolved component-by-component.
        }
        missingAncestor = true;
        finalExisted = false;
        finalIsDirectory = false;
        current = path.join(current, segment);
        continue;
      }
      if (code === 'ENOTDIR') {
        return {
          ok: false,
          reason: 'not-a-directory',
          message: `Parent component "${current}" is not a directory.`,
        };
      }
      throw error;
    }
  }

  if (!missingAncestor) {
    try {
      current = await fs.realpath(current);
      const finalStat = await fs.stat(current);
      finalExisted = true;
      finalIsDirectory = finalStat.isDirectory();
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        finalExisted = false;
        finalIsDirectory = false;
      }
    }
  }

  return {
    ok: true,
    canonicalPath: current,
    encounteredSymlink,
    existed: finalExisted,
    isDirectory: finalIsDirectory,
  };
}

function makeViolation(
  file: string,
  reason: ContainmentRejectionReason,
  message: string,
  resolvedPath?: string,
): ContainmentCheckFailure {
  const violation: ContainmentViolation =
    resolvedPath === undefined
      ? { file, reason, message }
      : { file, reason, message, resolvedPath };
  return { ok: false, violation };
}

function parseWorkspaceRelativeSegments(
  rawFile: string,
):
  | { ok: true; segments: string[]; normalizedPosix: string }
  | { ok: false; violation: ContainmentViolation } {
  if (rawFile.length === 0) {
    return makeViolation(rawFile, 'empty-path', 'Target path must not be empty.');
  }

  if (CONTROL_CHAR_RE.test(rawFile)) {
    return makeViolation(
      rawFile,
      'control-characters',
      'Target path must not contain null bytes or ASCII control characters.',
    );
  }

  if (
    path.isAbsolute(rawFile) ||
    rawFile.startsWith('/') ||
    rawFile.startsWith('\\') ||
    WINDOWS_DRIVE_RE.test(rawFile)
  ) {
    return makeViolation(
      rawFile,
      'not-workspace-relative',
      `Target path "${rawFile}" must be workspace-relative.`,
    );
  }

  const rawSegments = rawFile.split(/[/\\]/);
  const cleanedSegments: string[] = [];

  for (const segment of rawSegments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      return makeViolation(
        rawFile,
        'path-traversal',
        `Target path "${rawFile}" contains forbidden parent directory traversal ("..").`,
      );
    }
    cleanedSegments.push(segment);
  }

  if (cleanedSegments.length === 0) {
    return makeViolation(
      rawFile,
      'target-is-directory',
      `Target path "${rawFile}" resolves to the workspace root directory.`,
    );
  }

  return {
    ok: true,
    segments: cleanedSegments,
    normalizedPosix: cleanedSegments.join('/'),
  };
}

async function resolvePolicyWriteRoots(
  workspaceReal: string,
  policy: WriteContainmentPolicy,
): Promise<ResolvedWriteRoot[]> {
  if (policy.writeRoots === undefined) {
    return [{ rel: '.', canonical: workspaceReal }];
  }
  if (policy.writeRoots.length === 0) {
    return [];
  }

  const resolved: ResolvedWriteRoot[] = [];
  for (const rawRoot of policy.writeRoots) {
    if (rawRoot === '.' || rawRoot === './' || rawRoot === '') {
      resolved.push({ rel: '.', canonical: workspaceReal });
      continue;
    }
    const parsed = parseWorkspaceRelativeSegments(rawRoot);
    if (!parsed.ok) {
      continue;
    }
    const absRoot = path.join(workspaceReal, ...parsed.segments);
    const canonical = await canonicalizeTargetPath(absRoot);
    if (!canonical.ok) {
      continue;
    }
    if (!isPathInside(canonical.canonicalPath, workspaceReal)) {
      continue;
    }
    resolved.push({
      rel: toPosixRelative(workspaceReal, canonical.canonicalPath),
      canonical: canonical.canonicalPath,
    });
  }

  return resolved;
}

/**
 * Verify that `rawFile` is a valid workspace-relative path whose canonical
 * `realpath` target stays strictly inside `workspaceRoot` and `policy.writeRoots`,
 * and outside `.git`, `node_modules`, `.codecanvas/cache`, and `policy.protected`.
 */
export async function checkPathContainment(
  workspaceRoot: string,
  rawFile: string,
  policy: WriteContainmentPolicy = {},
): Promise<ContainmentCheckResult> {
  const parsed = parseWorkspaceRelativeSegments(rawFile);
  if (!parsed.ok) {
    return parsed;
  }

  const workspaceReal = await fs.realpath(workspaceRoot);
  const absCandidate = path.join(workspaceReal, ...parsed.segments);
  const canonical = await canonicalizeTargetPath(absCandidate);

  if (!canonical.ok) {
    return makeViolation(rawFile, canonical.reason, canonical.message);
  }

  if (!isPathInside(canonical.canonicalPath, workspaceReal)) {
    const reason: ContainmentRejectionReason = canonical.encounteredSymlink
      ? 'symlink-escape'
      : 'outside-workspace';
    return makeViolation(
      rawFile,
      reason,
      canonical.encounteredSymlink
        ? `Target path "${rawFile}" escapes the workspace via symlink to "${canonical.canonicalPath}".`
        : `Target path "${rawFile}" resolves outside the workspace ("${canonical.canonicalPath}").`,
      canonical.canonicalPath,
    );
  }

  if (canonical.canonicalPath === workspaceReal || canonical.isDirectory) {
    return makeViolation(
      rawFile,
      'target-is-directory',
      `Target path "${rawFile}" resolves to a directory ("${canonical.canonicalPath}").`,
      canonical.canonicalPath,
    );
  }

  const canonicalRelativePath = toPosixRelative(
    workspaceReal,
    canonical.canonicalPath,
  );

  const requestedForbidden = hasForbiddenDirectorySegment(parsed.normalizedPosix);
  if (requestedForbidden !== null) {
    return makeViolation(
      rawFile,
      'forbidden-directory',
      `Target path "${rawFile}" targets forbidden directory "${requestedForbidden}".`,
      canonical.canonicalPath,
    );
  }

  const canonicalForbidden = hasForbiddenDirectorySegment(canonicalRelativePath);
  if (canonicalForbidden !== null) {
    return makeViolation(
      rawFile,
      'forbidden-directory',
      `Target path "${rawFile}" resolves into forbidden directory "${canonicalForbidden}".`,
      canonical.canonicalPath,
    );
  }

  const writeRoots = await resolvePolicyWriteRoots(workspaceReal, policy);
  const matchedRoot = writeRoots.find((root) =>
    isPathInside(canonical.canonicalPath, root.canonical),
  );
  if (!matchedRoot) {
    const reason: ContainmentRejectionReason = canonical.encounteredSymlink
      ? 'symlink-escape'
      : 'outside-write-roots';
    return makeViolation(
      rawFile,
      reason,
      canonical.encounteredSymlink
        ? `Target path "${rawFile}" escapes allowed writeRoots via symlink to "${canonicalRelativePath}".`
        : `Target path "${rawFile}" is outside configured writeRoots.`,
      canonical.canonicalPath,
    );
  }

  const matchedProtectedReq = matchesProtectedPatterns(
    parsed.normalizedPosix,
    policy.protected,
  );
  if (matchedProtectedReq !== null) {
    return makeViolation(
      rawFile,
      'protected-path',
      `Target path "${rawFile}" matches protected pattern "${matchedProtectedReq}".`,
      canonical.canonicalPath,
    );
  }

  const matchedProtectedCanon = matchesProtectedPatterns(
    canonicalRelativePath,
    policy.protected,
  );
  if (matchedProtectedCanon !== null) {
    return makeViolation(
      rawFile,
      'protected-path',
      `Target path "${rawFile}" resolves to protected path "${canonicalRelativePath}" (pattern "${matchedProtectedCanon}").`,
      canonical.canonicalPath,
    );
  }

  return {
    ok: true,
    target: {
      file: parsed.normalizedPosix,
      canonicalRelativePath,
      canonicalPath: canonical.canonicalPath,
      writeRoot: matchedRoot.rel,
    },
  };
}
