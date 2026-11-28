import fs from 'node:fs';
import path from 'node:path';
import { LANDLOCK_EXEC_PATH } from './probe.mjs';

export class SandboxUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SandboxUnavailableError';
    this.details = details;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds the Linux Landlock LSM wrapper invocation.
 * Allows writes ONLY under cloneDir, scratchDir, and /dev/null.
 */
export function wrapWithLandlock(cmd, args, options) {
  const cloneDir = fs.realpathSync(options.cloneDir);
  const scratchDir = fs.realpathSync(options.scratchDir);
  const extraRw = (options.extraAllowRw ?? []).map((p) => fs.realpathSync(p));
  const cwd = fs.realpathSync(options.cwd ?? cloneDir);

  const pyArgs = [LANDLOCK_EXEC_PATH, '--cwd', cwd, '--allow-rw', cloneDir, '--allow-rw', scratchDir];
  for (const p of extraRw) {
    pyArgs.push('--allow-rw', p);
  }
  pyArgs.push('--', cmd, ...args);

  return {
    backend: 'landlock',
    command: 'python3',
    args: pyArgs,
    env: buildConfinedEnv(options),
  };
}

/**
 * Builds a Linux user+mount namespace (`unshare -Urm` + `pivot_root`) wrapper.
 * Mounts host directories read-only, replaces /tmp with a private tmpfs,
 * masks optional secret files with /dev/null, and bind-mounts ONLY cloneDir
 * and scratchDir read-write at their canonical paths.
 */
export function wrapWithUnshare(cmd, args, options) {
  const cloneDir = fs.realpathSync(options.cloneDir);
  const scratchDir = fs.realpathSync(options.scratchDir);
  const extraRw = (options.extraAllowRw ?? []).map((p) => fs.realpathSync(p));
  const extraRo = (options.extraAllowRo ?? []).filter((p) => fs.existsSync(p)).map((p) => fs.realpathSync(p));
  const maskReadPaths = (options.maskReadPaths ?? []).filter((p) => fs.existsSync(p)).map((p) => fs.realpathSync(p));
  const cwd = fs.realpathSync(options.cwd ?? cloneDir);

  const roBindLines = extraRo
    .map(
      (p) =>
        `mkdir -p "$ROOT${p}" && mount --bind ${shellQuote(p)} "$ROOT${p}" && mount -o remount,bind,ro "$ROOT${p}"`,
    )
    .join('\n');

  const rwPaths = [cloneDir, scratchDir, ...extraRw];
  const rwBindLines = rwPaths
    .map((p) => `mkdir -p "$ROOT${p}" && mount --bind ${shellQuote(p)} "$ROOT${p}"`)
    .join('\n');

  const maskLines = maskReadPaths
    .map((p) => {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        return `if [ -d "$ROOT${p}" ]; then mount -t tmpfs -o ro,size=4k tmpfs "$ROOT${p}"; fi`;
      }
      return `if [ -e "$ROOT${p}" ]; then mount --bind /dev/null "$ROOT${p}"; fi`;
    })
    .join('\n');

  const execLine = `exec ${[cmd, ...args].map(shellQuote).join(' ')}`;

  const script = `
set -eu
mount --make-rprivate /
ROOT=$(mktemp -d)
mount -t tmpfs -o mode=755 tmpfs "$ROOT"
for entry in /*; do
  name="\${entry#/}"
  case "$name" in
    tmp|proc|dev|sys) continue ;;
  esac
  if [ -L "$entry" ]; then
    ln -s "$(readlink "$entry")" "$ROOT/$name"
  elif [ -d "$entry" ]; then
    mkdir -p "$ROOT/$name"
    mount --rbind "$entry" "$ROOT/$name"
    mount -o remount,bind,ro "$ROOT/$name" 2>/dev/null || true
  fi
done
mkdir -p "$ROOT/proc" "$ROOT/dev" "$ROOT/sys" "$ROOT/tmp"
mount --rbind /proc "$ROOT/proc"
mount --rbind /dev "$ROOT/dev"
mount --rbind /sys "$ROOT/sys" 2>/dev/null || true
mount -t tmpfs -o mode=1777 tmpfs "$ROOT/tmp"
${roBindLines}
${maskLines}
${rwBindLines}
mkdir -p "$ROOT/.oldroot"
pivot_root "$ROOT" "$ROOT/.oldroot"
cd ${shellQuote(cwd)}
umount -l /.oldroot 2>/dev/null || true
rmdir /.oldroot 2>/dev/null || true
${execLine}
`.trim();

  return {
    backend: 'unshare',
    command: 'unshare',
    args: ['-Urm', 'sh', '-c', script],
    env: buildConfinedEnv(options),
  };
}

/**
 * Builds a bubblewrap (`bwrap`) wrapper matching Claude Code's Linux sandbox model.
 */
export function wrapWithBwrap(cmd, args, options) {
  const cloneDir = fs.realpathSync(options.cloneDir);
  const scratchDir = fs.realpathSync(options.scratchDir);
  const extraRw = (options.extraAllowRw ?? []).map((p) => fs.realpathSync(p));
  const extraRo = (options.extraAllowRo ?? []).filter((p) => fs.existsSync(p)).map((p) => fs.realpathSync(p));
  const maskReadPaths = (options.maskReadPaths ?? []).filter((p) => fs.existsSync(p)).map((p) => fs.realpathSync(p));
  const cwd = fs.realpathSync(options.cwd ?? cloneDir);

  const bwrapArgs = [
    '--die-with-parent',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
  ];
  for (const p of extraRo) {
    bwrapArgs.push('--ro-bind', p, p);
  }
  bwrapArgs.push('--bind', cloneDir, cloneDir, '--bind', scratchDir, scratchDir);
  for (const p of extraRw) {
    bwrapArgs.push('--bind', p, p);
  }
  for (const p of maskReadPaths) {
    if (fs.statSync(p).isDirectory()) {
      bwrapArgs.push('--tmpfs', p);
    } else {
      bwrapArgs.push('--ro-bind', '/dev/null', p);
    }
  }
  bwrapArgs.push('--chdir', cwd, '--', cmd, ...args);

  return {
    backend: 'bwrap',
    command: 'bwrap',
    args: bwrapArgs,
    env: buildConfinedEnv(options),
  };
}

/**
 * Layered defense-in-depth on Linux: mount namespace (`unshare -Urm` + `pivot_root`)
 * PLUS Landlock LSM write confinement inside the namespace.
 * Even if a submount remained writable inside the namespace, Landlock blocks writes;
 * meanwhile the mount namespace provides private /tmp and masks secret files from reads.
 */
export function wrapLayeredLinux(cmd, args, options) {
  const inner = wrapWithLandlock(cmd, args, options);
  const outer = wrapWithUnshare(inner.command, inner.args, options);
  return {
    ...outer,
    backend: 'layered',
  };
}

export function buildConfinedEnv(options) {
  const scratchDir = fs.realpathSync(options.scratchDir);
  const cloneDir = fs.realpathSync(options.cloneDir);
  const homeDir = path.join(scratchDir, 'home');
  const tmpDir = path.join(scratchDir, 'tmp');
  const npmCacheDir = path.join(scratchDir, 'npm-cache');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(npmCacheDir, { recursive: true });

  return {
    ...process.env,
    ...(options.env ?? {}),
    HOME: homeDir,
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    npm_config_cache: npmCacheDir,
    XDG_CACHE_HOME: path.join(scratchDir, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(scratchDir, 'xdg-config'),
    CODECANVAS_CLONE_ROOT: cloneDir,
    CODECANVAS_ALLOWED_TMP: scratchDir,
  };
}

/**
 * Fail-closed Linux sandbox selector.
 * Preference order: bwrap -> layered (unshare+landlock) -> landlock -> unshare.
 * Throws SandboxUnavailableError if no backend is available (no weaker fallback).
 */
export function wrapForLinuxSandbox(cmd, args, options, probe, requestedBackend = 'auto') {
  if (options.disableAllBackends) {
    throw new SandboxUnavailableError(
      'OS sandbox unavailable (all backends disabled): codecanvas refuses unsandboxed agent execution (fail-closed per §10.2).',
      { requestedBackend, availableBackends: [] },
    );
  }

  const available = new Set(probe.availableBackends);
  let chosen = requestedBackend;
  if (chosen === 'auto') {
    for (const candidate of ['bwrap', 'layered', 'landlock', 'unshare']) {
      if (available.has(candidate)) {
        chosen = candidate;
        break;
      }
    }
  }

  if (!available.has(chosen)) {
    throw new SandboxUnavailableError(
      `Requested Linux OS sandbox backend "${requestedBackend}" is unavailable. Available: [${[...available].join(', ')}]. Agent tasks are disabled on platforms without an OS sandbox (no weaker fallback).`,
      { requestedBackend, availableBackends: [...available] },
    );
  }

  switch (chosen) {
    case 'bwrap':
      return wrapWithBwrap(cmd, args, options);
    case 'layered':
      return wrapLayeredLinux(cmd, args, options);
    case 'landlock':
      return wrapWithLandlock(cmd, args, options);
    case 'unshare':
      return wrapWithUnshare(cmd, args, options);
    default:
      throw new SandboxUnavailableError(`Unsupported Linux sandbox backend: ${chosen}`);
  }
}
