import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire, register } from 'node:module';

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function appendAudit(entry) {
  const auditFile = process.env.CC_AUDIT_LOG;
  if (!auditFile) return;
  try {
    fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');
  } catch {
    // Best-effort telemetry for spike tests
  }
}

/**
 * Activation rule (§3.4):
 * NODE_OPTIONS reaches every Node child process. Activate ONLY when:
 * 1. CC_TARGET_FRAMEWORK and CC_APP_ROOT are configured.
 * 2. The process is running inside the target app root (or workspace root targeting appRoot).
 * 3. The entry point (process.argv[1]) matches the target framework's dev binary / server worker.
 * Everywhere else, return { active: false } and do nothing.
 */
function checkActivation() {
  const target = process.env.CC_TARGET_FRAMEWORK;
  const rawAppRoot = process.env.CC_APP_ROOT;
  if (!target || !rawAppRoot) {
    return { active: false, reason: 'missing-env' };
  }

  const appRoot = safeRealpath(rawAppRoot);
  const workspaceRoot = safeRealpath(process.env.CC_WORKSPACE_ROOT || appRoot);
  const cwd = safeRealpath(process.cwd());
  const rawEntry = process.argv[1] || '';
  const entry = rawEntry ? safeRealpath(rawEntry) : '';
  const entryNorm = entry.replace(/\\/g, '/');
  const rawEntryNorm = rawEntry.replace(/\\/g, '/');

  const inAppOrWorkspace =
    cwd === appRoot ||
    cwd.startsWith(appRoot + path.sep) ||
    cwd === workspaceRoot ||
    cwd.startsWith(workspaceRoot + path.sep);

  if (!inAppOrWorkspace) {
    return { active: false, reason: 'outside-workspace', cwd, entry: rawEntry };
  }

  if (target === 'next') {
    const isNextStartServer =
      entryNorm.endsWith('/next/dist/server/lib/start-server.js') ||
      (process.env.__NEXT_DEV_SERVER === '1' && entryNorm.includes('/next/dist/'));
    const isNextDevCli =
      (entryNorm.endsWith('/next/dist/bin/next') || rawEntryNorm.endsWith('/.bin/next')) &&
      process.argv.slice(2).includes('dev');

    if (isNextStartServer || isNextDevCli) {
      return {
        active: true,
        framework: 'next',
        role: isNextStartServer ? 'start-server' : 'cli',
        appRoot,
        workspaceRoot,
        cwd,
        entry: entryNorm
      };
    }
    return { active: false, reason: 'non-next-process', cwd, entry: rawEntry };
  }

  if (target === 'vite') {
    const isViteBin =
      entryNorm.endsWith('/vite/bin/vite.js') || rawEntryNorm.endsWith('/.bin/vite');
    if (!isViteBin) {
      return { active: false, reason: 'non-vite-process', cwd, entry: rawEntry };
    }
    const cliArgs = process.argv.slice(2);
    const firstPositional = cliArgs.find((a) => !a.startsWith('-'));
    const isNonDevSubcommand =
      firstPositional && ['build', 'preview', 'optimize'].includes(firstPositional);
    if (isNonDevSubcommand) {
      return { active: false, reason: `vite-${firstPositional}`, cwd, entry: rawEntry };
    }
    return {
      active: true,
      framework: 'vite',
      role: 'cli',
      appRoot,
      workspaceRoot,
      cwd,
      entry: entryNorm
    };
  }

  return { active: false, reason: 'unknown-target', cwd, entry: rawEntry };
}

function readInstalledVersion(appRoot, pkgName) {
  try {
    const req = createRequire(path.join(appRoot, 'package.json'));
    return req(`${pkgName}/package.json`).version;
  } catch {
    return 'unknown';
  }
}

let nextHandshakeSent = false;
function sendNextHandshake(payload) {
  if (nextHandshakeSent) return;
  nextHandshakeSent = true;
  const url = process.env.CC_DAEMON_URL;
  const token = process.env.CC_DAEMON_TOKEN;
  if (!url || !token) return;
  fetch(`${url}/handshake`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  }).catch(() => {
    // Daemon may have closed during teardown
  });
}

function installNextInstrumentation(act) {
  const { appRoot, workspaceRoot } = act;
  const runtimeDir = process.env.CC_RUNTIME_DIR || path.join(appRoot, '.codecanvas', 'cache', 'runtime', '0.0.1');
  const distDir = process.env.CC_DIST_DIR || '.codecanvas/cache/next';
  const tsconfigPath = process.env.CC_TSCONFIG_PATH || '.codecanvas/cache/tsconfig.json';
  const transpilePackages = (() => {
    try {
      return JSON.parse(process.env.CC_TRANSPILE_PACKAGES || '[]');
    } catch {
      return [];
    }
  })();

  const loaderAbsPath = process.env.CC_FORCE_LOADER_PATH || path.join(runtimeDir, 'next-loader.cjs');
  const loaderRelToApp = './' + path.relative(appRoot, loaderAbsPath).replace(/\\/g, '/');
  const useExternalLoader = Boolean(process.env.CC_FORCE_LOADER_PATH);

  const origLoad = Module._load;
  const wrappedExportsCache = new WeakMap();

  function wrapExports(origExports, overrides) {
    if (wrappedExportsCache.has(origExports)) {
      return wrappedExportsCache.get(origExports);
    }
    const proxy = new Proxy(origExports, {
      get(target, prop, receiver) {
        if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
          return overrides[prop];
        }
        return Reflect.get(target, prop, receiver);
      }
    });
    wrappedExportsCache.set(origExports, proxy);
    return proxy;
  }

  function augmentNextConfig(config, dir, loadOpts) {
    if (!config || typeof config !== 'object' || config.__ccInstrumented) {
      return config;
    }

    const nextVersion = readInstalledVersion(appRoot, 'next');
    const isTurbopack =
      Boolean(process.env.TURBOPACK) ||
      (loadOpts && loadOpts.bundler === 'turbopack');

    // 1. Private distDir (avoids .next/dev/lock collision with developer's own `next dev`)
    if ('distDirRoot' in config) {
      // Next 16 keeps distDirRoot + appends /dev in development mode
      config.distDirRoot = distDir;
      config.distDir = path.join(distDir, 'dev');
    } else {
      // Next 15 uses distDir directly
      config.distDir = distDir;
    }

    // 2. Private tsconfigPath (avoids mutating repo tsconfig.json)
    config.typescript = {
      ...(config.typescript || {}),
      tsconfigPath
    };

    // 3. allowedDevOrigins for per-screen loopback origins
    const existingOrigins = Array.isArray(config.allowedDevOrigins) ? config.allowedDevOrigins : [];
    config.allowedDevOrigins = Array.from(
      new Set([...existingOrigins, '127.0.0.1', 'localhost', '*.localhost'])
    );

    // 4. transpilePackages for workspace packages outside app root
    if (transpilePackages.length > 0) {
      const existingTranspile = Array.isArray(config.transpilePackages)
        ? config.transpilePackages
        : [];
      config.transpilePackages = Array.from(new Set([...existingTranspile, ...transpilePackages]));
    }

    // 5. Disable serverComponentsHmrCache for determinism (§3.4, §11.3)
    config.experimental = {
      ...(config.experimental || {}),
      serverComponentsHmrCache: false
    };

    // 6. Turbopack root + loader rules (from copied runtime inside .codecanvas/cache/runtime/)
    config.turbopack = {
      ...(config.turbopack || {}),
      rules: {
        ...((config.turbopack && config.turbopack.rules) || {})
      }
    };
    if (workspaceRoot !== appRoot) {
      config.turbopack.root = workspaceRoot;
      config.outputFileTracingRoot = workspaceRoot;
    }

    // Turbopack resolves loader strings relative to project root when inside project root
    const turbopackLoaderSpec = useExternalLoader ? loaderAbsPath : loaderRelToApp;
    const loaderItem = {
      loader: turbopackLoaderSpec,
      options: { workspaceRoot }
    };

    for (const glob of ['*.tsx', '*.jsx']) {
      const prevRule = config.turbopack.rules[glob];
      if (!prevRule) {
        config.turbopack.rules[glob] = {
          loaders: [loaderItem]
        };
      } else if (Array.isArray(prevRule)) {
        config.turbopack.rules[glob] = [...prevRule, { loaders: [loaderItem] }];
      } else if (typeof prevRule === 'object') {
        config.turbopack.rules[glob] = {
          ...prevRule,
          loaders: [...(prevRule.loaders || []), loaderItem]
        };
      }
    }

    // 7. Webpack loader rule (preserving any existing user config.webpack hook)
    const userWebpack = config.webpack;
    config.webpack = function codecanvasWebpack(wpConfig, wpContext) {
      const nextWp = typeof userWebpack === 'function' ? userWebpack(wpConfig, wpContext) : wpConfig;
      nextWp.module = nextWp.module || {};
      nextWp.module.rules = nextWp.module.rules || [];
      nextWp.module.rules.push({
        test: /\.[jt]sx$/,
        enforce: 'pre',
        use: [
          {
            loader: loaderAbsPath,
            options: { workspaceRoot }
          }
        ]
      });
      return nextWp;
    };

    Object.defineProperty(config, '__ccInstrumented', {
      value: true,
      enumerable: false
    });

    sendNextHandshake({
      framework: 'next',
      version: nextVersion,
      pid: process.pid,
      ppid: process.ppid,
      bundler: isTurbopack ? 'turbopack' : 'webpack',
      appRoot,
      workspaceRoot,
      configDir: dir,
      distDir: config.distDir,
      tsconfigPath: config.typescript.tsconfigPath,
      transpilePackages: config.transpilePackages || [],
      turbopackRoot: config.turbopack.root,
      turbopackLoaderSpec,
      timestamp: Date.now()
    });

    return config;
  }

  Module._load = function patchedModuleLoad(request, parent, isMain) {
    let resolved = '';
    try {
      resolved = Module._resolveFilename(request, parent, isMain).replace(/\\/g, '/');
    } catch {
      return origLoad.apply(this, arguments);
    }

    const exportsObj = origLoad.apply(this, arguments);

    // Hook 1: Next.js config loader (covers .ts, .mjs, .js, function/async, and no-config)
    if (resolved.endsWith('/next/dist/server/config.js')) {
      const origLoadConfig = exportsObj.default;
      if (typeof origLoadConfig === 'function') {
        const wrappedLoadConfig = async function codecanvasLoadConfig(phase, dir, opts) {
          const result = await origLoadConfig.call(this, phase, dir, opts);
          if (phase === 'phase-development-server' && !(opts && opts.rawConfig)) {
            return augmentNextConfig(result, dir, opts);
          }
          return result;
        };
        return wrapExports(exportsObj, { default: wrappedLoadConfig });
      }
    }

    // Hook 2: Suppress repo next-env.d.ts creation/mutation (I1 zero footprint)
    if (resolved.endsWith('/next/dist/lib/typescript/writeAppTypeDeclarations.js')) {
      const origWrite = exportsObj.writeAppTypeDeclarations;
      if (typeof origWrite === 'function') {
        const suppressedWrite = async function codecanvasSuppressedNextEnv(params) {
          const targetBase = params && params.baseDir ? safeRealpath(params.baseDir) : '';
          if (targetBase === appRoot) {
            // Redirect to private cache dir instead of mutating <appRoot>/next-env.d.ts
            const cacheBase = path.join(appRoot, '.codecanvas', 'cache');
            fs.mkdirSync(cacheBase, { recursive: true });
            return origWrite({ ...params, baseDir: cacheBase });
          }
          return origWrite(params);
        };
        return wrapExports(exportsObj, { writeAppTypeDeclarations: suppressedWrite });
      }
    }

    // Hook 3: Defense-in-depth guard preventing accidental mutation of repo tsconfig.json
    if (resolved.endsWith('/next/dist/lib/typescript/writeConfigurationDefaults.js')) {
      const origWriteTs = exportsObj.writeConfigurationDefaults;
      if (typeof origWriteTs === 'function') {
        const guardedWriteTs = async function codecanvasGuardedTsConfig(tsVersion, tsConfigPath, ...rest) {
          const repoTsConfig = path.join(appRoot, 'tsconfig.json');
          if (tsConfigPath && path.resolve(tsConfigPath) === repoTsConfig) {
            return;
          }
          return origWriteTs(tsVersion, tsConfigPath, ...rest);
        };
        return wrapExports(exportsObj, { writeConfigurationDefaults: guardedWriteTs });
      }
    }

    // Hook 4: Suppress Next 16.3+ automatic AGENTS.md creation/mutation when launched under an AI agent (I1)
    if (resolved.endsWith('/next/dist/server/lib/generate-agent-files.js')) {
      const noopResult = () => ({ agentsMd: 'unchanged' });
      return wrapExports(exportsObj, {
        writeAgentFiles: noopResult,
        writeAgentFeedbackFiles: noopResult,
        removeAgentRulesFiles: noopResult,
        removeAgentFeedbackFiles: noopResult
      });
    }

    return exportsObj;
  };
}

function installViteInstrumentation(act) {
  const { appRoot, workspaceRoot } = act;
  const runtimeDir = process.env.CC_RUNTIME_DIR || path.join(appRoot, '.codecanvas', 'cache', 'runtime', '0.0.1');
  const cacheDir = process.env.CC_CACHE_DIR || path.join(appRoot, '.codecanvas', 'cache', 'vite');
  const vitePluginPath = path.join(runtimeDir, 'vite-plugin.mjs');

  register('./hooks.mjs', import.meta.url, {
    data: {
      appRoot,
      workspaceRoot,
      cacheDir,
      vitePluginPath
    }
  });
}

// Entrypoint: run activation check synchronously on --import
const activation = checkActivation();
appendAudit({
  pid: process.pid,
  ppid: process.ppid,
  active: activation.active,
  framework: activation.framework || null,
  role: activation.role || null,
  reason: activation.reason || null,
  argv1: process.argv[1] || '',
  cwd: process.cwd()
});

if (activation.active) {
  if (activation.framework === 'next') {
    installNextInstrumentation(activation);
  } else if (activation.framework === 'vite') {
    installViteInstrumentation(activation);
  }
}
