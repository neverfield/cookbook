import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { instrumentSource } = require('./transform.cjs');

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

let handshakeSent = false;

async function sendHandshake(payload) {
  if (handshakeSent) return;
  handshakeSent = true;
  const url = process.env.CC_DAEMON_URL;
  const token = process.env.CC_DAEMON_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/handshake`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });
  } catch {
    // Daemon may have already exited during teardown
  }
}

function readViteVersion(appRoot) {
  try {
    const req = createRequire(path.join(appRoot, 'package.json'));
    return req('vite/package.json').version;
  } catch {
    return 'unknown';
  }
}

export function codecanvasVitePlugin(options = {}) {
  const appRoot = safeRealpath(options.appRoot || process.env.CC_APP_ROOT || process.cwd());
  const workspaceRoot = safeRealpath(
    options.workspaceRoot || process.env.CC_WORKSPACE_ROOT || appRoot
  );
  const cacheDir =
    options.cacheDir ||
    process.env.CC_CACHE_DIR ||
    path.join(appRoot, '.codecanvas', 'cache', 'vite');

  return {
    name: 'codecanvas:instrument',
    enforce: 'pre',
    apply: 'serve',

    config(userConfig) {
      const existingAllow = userConfig?.server?.fs?.allow || [];
      const allowSet = new Set([...existingAllow, appRoot, workspaceRoot]);
      return {
        cacheDir,
        css: {
          devSourcemap: true
        },
        server: {
          fs: {
            allow: Array.from(allowSet)
          }
        }
      };
    },

    configResolved(resolvedConfig) {
      void sendHandshake({
        framework: 'vite',
        version: readViteVersion(appRoot),
        pid: process.pid,
        ppid: process.ppid,
        bundler: 'vite',
        appRoot,
        workspaceRoot,
        cacheDir: resolvedConfig.cacheDir,
        devSourcemap: Boolean(resolvedConfig.css?.devSourcemap),
        pluginCount: resolvedConfig.plugins?.length ?? 0,
        hookMode: options.hookMode || 'config-hook',
        timestamp: Date.now()
      });
    },

    transform(code, id) {
      const cleanId = id.split('?')[0];
      if (!/\.[jt]sx$/.test(cleanId)) return null;

      const realId = safeRealpath(cleanId);
      if (
        realId.includes(`${path.sep}node_modules${path.sep}`) ||
        realId.includes(`${path.sep}.codecanvas${path.sep}`)
      ) {
        return null;
      }
      if (realId !== workspaceRoot && !realId.startsWith(workspaceRoot + path.sep)) {
        return null;
      }

      const relPath = path.relative(workspaceRoot, realId);
      const { code: out } = instrumentSource(code, relPath);
      return { code: out, map: null };
    }
  };
}

export function injectCodecanvasIntoViteConfig(rawConfig, options = {}) {
  const plugin = codecanvasVitePlugin(options);
  const cacheDir =
    options.cacheDir ||
    process.env.CC_CACHE_DIR ||
    path.join(
      safeRealpath(options.appRoot || process.env.CC_APP_ROOT || process.cwd()),
      '.codecanvas',
      'cache',
      'vite'
    );

  const attach = (cfg) => {
    const resolved = cfg && typeof cfg === 'object' ? { ...cfg } : {};
    const existingPlugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    const alreadyHas = existingPlugins
      .flat(Infinity)
      .some((p) => p && typeof p === 'object' && p.name === 'codecanvas:instrument');
    if (!alreadyHas) {
      resolved.plugins = [plugin, ...existingPlugins];
    }
    resolved.cacheDir = cacheDir;
    resolved.css = {
      ...(resolved.css || {}),
      devSourcemap: true
    };
    return resolved;
  };

  if (typeof rawConfig === 'function') {
    return async function wrappedViteConfig(...args) {
      const result = await rawConfig(...args);
      return attach(result);
    };
  }
  return attach(rawConfig);
}
