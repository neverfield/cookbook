import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LANDLOCK_EXEC_PATH = path.join(__dirname, 'landlock-exec.py');

function which(bin) {
  const res = spawnSync('which', [bin], { encoding: 'utf8' });
  if (res.status === 0 && res.stdout.trim()) {
    return res.stdout.trim().split('\n')[0];
  }
  return null;
}

function probeClaudeCli() {
  const bin = which('claude');
  if (!bin) {
    return { available: false, path: null, version: null };
  }
  const res = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return {
    available: res.status === 0,
    path: bin,
    version: res.status === 0 ? res.stdout.trim() : null,
  };
}

function probeBwrap() {
  const bin = which('bwrap');
  if (!bin) {
    return { available: false, path: null, functional: false, reason: 'bwrap binary not installed' };
  }
  const res = spawnSync(bin, ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    available: true,
    path: bin,
    functional: res.status === 0,
    reason: res.status === 0 ? null : (res.stderr || `exit ${res.status}`).trim(),
  };
}

function probeLandlock() {
  if (process.platform !== 'linux') {
    return { available: false, abi: null, reason: `not linux (${process.platform})` };
  }
  const py = which('python3');
  if (!py) {
    return { available: false, abi: null, reason: 'python3 not installed' };
  }
  const res = spawnSync(py, [LANDLOCK_EXEC_PATH, '--probe'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (res.status === 0) {
    const abi = Number.parseInt(res.stdout.trim(), 10);
    return {
      available: Number.isFinite(abi) && abi >= 1,
      abi,
      supportsRefer: abi >= 2,
      supportsTruncate: abi >= 3,
      reason: null,
    };
  }
  return {
    available: false,
    abi: null,
    reason: (res.stderr || `exit ${res.status}`).trim(),
  };
}

function probeUnshare() {
  if (process.platform !== 'linux') {
    return { available: false, path: null, functional: false, reason: `not linux (${process.platform})` };
  }
  const bin = which('unshare');
  if (!bin) {
    return { available: false, path: null, functional: false, reason: 'unshare binary not installed' };
  }
  const res = spawnSync(
    bin,
    ['-Urm', 'sh', '-c', 'mount --make-rprivate / && echo ok'],
    { encoding: 'utf8', timeout: 5000 },
  );
  return {
    available: true,
    path: bin,
    functional: res.status === 0 && res.stdout.includes('ok'),
    reason: res.status === 0 ? null : (res.stderr || `exit ${res.status}`).trim(),
  };
}

function probeMacosSandboxExec() {
  if (process.platform !== 'darwin') {
    return { available: false, path: null, functional: false, reason: `not darwin (${process.platform})` };
  }
  const bin = which('sandbox-exec');
  if (!bin) {
    return { available: false, path: null, functional: false, reason: 'sandbox-exec not found' };
  }
  const res = spawnSync(bin, ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    available: true,
    path: bin,
    functional: res.status === 0,
    reason: res.status === 0 ? null : (res.stderr || `exit ${res.status}`).trim(),
  };
}

function readLsmList() {
  try {
    return fs.readFileSync('/sys/kernel/security/lsm', 'utf8').trim();
  } catch {
    return null;
  }
}

export function probeEnvironment() {
  const kernel =
    process.platform === 'linux'
      ? execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim()
      : os.release();

  const claude = probeClaudeCli();
  const bwrap = probeBwrap();
  const landlock = probeLandlock();
  const unshare = probeUnshare();
  const sandboxExec = probeMacosSandboxExec();

  const availableBackends = [];
  if (process.platform === 'linux') {
    if (bwrap.functional) availableBackends.push('bwrap');
    if (landlock.available && unshare.functional) availableBackends.push('layered');
    if (landlock.available) availableBackends.push('landlock');
    if (unshare.functional) availableBackends.push('unshare');
  } else if (process.platform === 'darwin') {
    if (sandboxExec.functional) availableBackends.push('sandbox-exec');
  }

  return {
    platform: process.platform,
    arch: process.arch,
    kernel,
    nodeVersion: process.version,
    lsm: readLsmList(),
    claude,
    primitives: {
      bwrap,
      landlock,
      unshare,
      sandboxExec,
    },
    availableBackends,
  };
}
