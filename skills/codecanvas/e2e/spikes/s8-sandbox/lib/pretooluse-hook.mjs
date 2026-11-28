#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook enforcing codecanvas agent clone boundary containment.
 *
 * Protocol (Claude Code hooks):
 * - Reads JSON payload on stdin: { session_id, cwd, hook_event_name, tool_name, tool_input }
 * - Reads CODECANVAS_CLONE_ROOT (required) from process.env
 * - Writes JSON decision to stdout:
 *   { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow"|"deny", permissionDecisionReason? } }
 * - Exits 0 on structured allow/deny decision; exits 2 on fatal misconfiguration (fail-closed).
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves a path by walking up to the nearest existing ancestor, calling
 * fs.realpathSync on that ancestor, and rejoining any not-yet-created suffix.
 * This catches symlinks pointing outside the clone even for newly created files.
 */
export function resolvePathSafely(rawPath, cwd) {
  const abs = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(cwd, rawPath);
  const trailing = [];
  let cursor = abs;

  while (true) {
    try {
      const real = fs.realpathSync(cursor);
      return trailing.length ? path.join(real, ...trailing.reverse()) : real;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          return abs;
        }
        trailing.push(path.basename(cursor));
        cursor = parent;
        continue;
      }
      throw err;
    }
  }
}

export function isWithinRoot(candidateRealPath, rootRealPath) {
  if (candidateRealPath === rootRealPath) return true;
  const prefix = rootRealPath.endsWith(path.sep) ? rootRealPath : `${rootRealPath}${path.sep}`;
  return candidateRealPath.startsWith(prefix);
}

export function isInsideGitAdminDir(candidateRealPath, cloneRootRealPath) {
  const gitDir = path.join(cloneRootRealPath, '.git');
  return candidateRealPath === gitDir || candidateRealPath.startsWith(`${gitDir}${path.sep}`);
}

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function extractTargetPaths(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const paths = [];
  if (typeof toolInput.file_path === 'string') paths.push(toolInput.file_path);
  if (typeof toolInput.notebook_path === 'string') paths.push(toolInput.notebook_path);
  if (typeof toolInput.path === 'string') paths.push(toolInput.path);
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit && typeof edit.file_path === 'string') paths.push(edit.file_path);
    }
  }
  return paths;
}

/**
 * Defense-in-depth static checks on Bash commands.
 * NOTE: The OS sandbox (Landlock / bwrap / unshare / Seatbelt) is the real security
 * boundary for Bash; this hook merely gives fast, explicit feedback on obvious git/escape
 * patterns before spawning the shell command.
 */
function checkBashCommand(command, cloneRootReal, cwd) {
  if (typeof command !== 'string') return { allow: true };

  if (/\bcore\.hooksPath\b/i.test(command)) {
    return {
      allow: false,
      reason: 'Blocked by codecanvas PreToolUse guard: modifying git core.hooksPath is prohibited inside agent clones.',
    };
  }

  // Catch explicit GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR pointing outside clone
  const gitEnvRe = /\b(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_ALTERNATE_OBJECT_DIRECTORIES)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/g;
  for (const match of command.matchAll(gitEnvRe)) {
    const rawTarget = match[1] ?? match[2] ?? match[3];
    const resolved = resolvePathSafely(rawTarget, cwd);
    if (!isWithinRoot(resolved, cloneRootReal)) {
      return {
        allow: false,
        reason: `Blocked by codecanvas PreToolUse guard: git environment variable targets path outside clone (${rawTarget} -> ${resolved}).`,
      };
    }
  }

  // Catch `git -C <dir>` targeting outside clone
  const gitCRe = /\bgit\s+(?:[^\n;|&]*\s)?-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/g;
  for (const match of command.matchAll(gitCRe)) {
    const rawTarget = match[1] ?? match[2] ?? match[3];
    const resolved = resolvePathSafely(rawTarget, cwd);
    if (!isWithinRoot(resolved, cloneRootReal)) {
      return {
        allow: false,
        reason: `Blocked by codecanvas PreToolUse guard: git -C targets directory outside clone (${rawTarget} -> ${resolved}).`,
      };
    }
  }

  return { allow: true };
}

export function evaluatePreToolUse(payload, cloneRootEnv) {
  if (!cloneRootEnv) {
    return {
      allow: false,
      reason: 'Fail-closed: CODECANVAS_CLONE_ROOT is not set in PreToolUse hook environment.',
    };
  }

  let cloneRootReal;
  try {
    cloneRootReal = fs.realpathSync(cloneRootEnv);
  } catch (err) {
    return {
      allow: false,
      reason: `Fail-closed: CODECANVAS_CLONE_ROOT cannot be resolved (${err.message}).`,
    };
  }

  const toolName = payload?.tool_name;
  const toolInput = payload?.tool_input ?? {};
  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : cloneRootReal;

  if (FILE_WRITE_TOOLS.has(toolName)) {
    const targets = extractTargetPaths(toolName, toolInput);
    if (targets.length === 0) {
      return {
        allow: false,
        reason: `Fail-closed: ${toolName} tool call did not specify a target path.`,
      };
    }

    for (const rawTarget of targets) {
      let resolved;
      try {
        resolved = resolvePathSafely(rawTarget, cwd);
      } catch (err) {
        return {
          allow: false,
          reason: `Blocked by codecanvas PreToolUse guard: failed to resolve path "${rawTarget}" (${err.message}).`,
        };
      }

      if (!isWithinRoot(resolved, cloneRootReal)) {
        return {
          allow: false,
          reason: `Blocked by codecanvas PreToolUse guard: ${toolName} target "${rawTarget}" resolves to "${resolved}", outside clone root "${cloneRootReal}".`,
        };
      }

      if (isInsideGitAdminDir(resolved, cloneRootReal)) {
        return {
          allow: false,
          reason: `Blocked by codecanvas PreToolUse guard: direct ${toolName} inside clone .git directory ("${resolved}") is prohibited.`,
        };
      }
    }

    return { allow: true };
  }

  if (toolName === 'Bash') {
    return checkBashCommand(toolInput.command, cloneRootReal, cwd);
  }

  // Read / Glob / Grep / MCP canvas tools: allow
  return { allow: true };
}

async function runCli() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (err) {
    process.stderr.write(`codecanvas PreToolUse hook: invalid JSON on stdin (${err.message})\n`);
    process.exit(2);
  }

  const verdict = evaluatePreToolUse(payload, process.env.CODECANVAS_CLONE_ROOT);
  const response = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.allow ? 'allow' : 'deny',
      ...(verdict.reason ? { permissionDecisionReason: verdict.reason } : {}),
    },
  };

  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exit(0);
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  runCli();
}
