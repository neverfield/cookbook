import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

let config = null;

export function initialize(data) {
  config = data;
}

function isBundledViteConfigUrl(url) {
  if (!url.startsWith('file://') || url.includes('__cc_orig=1')) return false;
  const cleanUrl = url.split('?')[0];
  let filePath;
  try {
    filePath = fileURLToPath(cleanUrl);
  } catch {
    return false;
  }
  const normalized = filePath.replace(/\\/g, '/');
  // Vite 6-8: node_modules/.vite-temp/vite.config.*.timestamp-*.mjs
  if (/\/\.vite-temp\/vite\.config\.[^/]+\.timestamp-[^/]+\.mjs$/.test(normalized)) {
    return true;
  }
  // Vite 5: <root>/vite.config.*.timestamp-*.mjs
  if (/\/vite\.config\.[^/]+\.timestamp-[^/]+\.mjs$/.test(normalized)) {
    return true;
  }
  // Native config loader (--configLoader native): direct vite.config.(mjs|js|ts|mts) in appRoot
  if (config?.appRoot) {
    const appRootNorm = config.appRoot.replace(/\\/g, '/');
    if (
      normalized.startsWith(`${appRootNorm}/`) &&
      /\/vite\.config\.(?:mjs|js|ts|mts)$/.test(normalized)
    ) {
      return true;
    }
  }
  return false;
}

function isViteCliUrl(url) {
  if (!url.startsWith('file://')) return false;
  const cleanUrl = url.split('?')[0];
  return /\/vite\/dist\/node\/cli\.js$/.test(cleanUrl);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('file://') && specifier.includes('__cc_orig=1')) {
    return { url: specifier, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!config) {
    return nextLoad(url, context);
  }

  // Pass-through for the inner original bundled Vite config import
  if (url.startsWith('file://') && url.includes('__cc_orig=1')) {
    const cleanUrl = url.split('?')[0];
    const filePath = fileURLToPath(cleanUrl);
    const source = fs.readFileSync(filePath, 'utf8');
    return {
      format: 'module',
      source,
      shortCircuit: true
    };
  }

  // Primary hook (§3.4): wrap Vite's bundled temp config module (or native config)
  if (isBundledViteConfigUrl(url)) {
    const cleanUrl = url.split('?')[0];
    const origUrl = `${cleanUrl}?__cc_orig=1`;
    const pluginUrl = pathToFileURL(config.vitePluginPath).href;
    const optsJson = JSON.stringify({
      appRoot: config.appRoot,
      workspaceRoot: config.workspaceRoot,
      cacheDir: config.cacheDir,
      hookMode: 'config-hook'
    });
    const wrapperSource = [
      `import __ccOrigConfig from ${JSON.stringify(origUrl)};`,
      `import { injectCodecanvasIntoViteConfig } from ${JSON.stringify(pluginUrl)};`,
      `export default injectCodecanvasIntoViteConfig(__ccOrigConfig, ${optsJson});`,
      ''
    ].join('\n');
    return {
      format: 'module',
      source: wrapperSource,
      shortCircuit: true
    };
  }

  // Fallback hook: for zero-config Vite apps (or CJS vite.config.cjs) where no ESM
  // temp config module is imported, inject plugin + cacheDir + devSourcemap into
  // cli.js's createServer(inlineConfig) call when no ESM/TS config file exists.
  if (isViteCliUrl(url)) {
    const loaded = await nextLoad(url, context);
    const raw =
      typeof loaded.source === 'string'
        ? loaded.source
        : Buffer.from(loaded.source).toString('utf8');
    const pluginUrl = pathToFileURL(config.vitePluginPath).href;
    const optsJson = JSON.stringify({
      appRoot: config.appRoot,
      workspaceRoot: config.workspaceRoot,
      cacheDir: config.cacheDir,
      hookMode: 'cli-fallback'
    });

    const helperPrefix = [
      `import __ccFs from 'node:fs';`,
      `import __ccPath from 'node:path';`,
      `import { codecanvasVitePlugin as __ccCreatePlugin } from ${JSON.stringify(pluginUrl)};`,
      `function __ccMaybeAugmentInlineConfig(inlineConfig) {`,
      `  const __ccOpts = ${optsJson};`,
      `  const rootDir = __ccPath.resolve(inlineConfig.root || process.cwd());`,
      `  const esmConfigNames = ['vite.config.ts', 'vite.config.mts', 'vite.config.mjs', 'vite.config.js'];`,
      `  const hasHandledConfig = !inlineConfig.configFile && esmConfigNames.some((f) => __ccFs.existsSync(__ccPath.join(rootDir, f)));`,
      `  if (hasHandledConfig) return inlineConfig;`,
      `  const existingPlugins = Array.isArray(inlineConfig.plugins) ? inlineConfig.plugins : [];`,
      `  return {`,
      `    ...inlineConfig,`,
      `    cacheDir: __ccOpts.cacheDir,`,
      `    css: { ...(inlineConfig.css || {}), devSourcemap: true },`,
      `    plugins: [__ccCreatePlugin(__ccOpts), ...existingPlugins]`,
      `  };`,
      `}`,
      ''
    ].join('\n');

    const replaced = raw.replace(
      /await createServer\(\{/,
      'await createServer(__ccMaybeAugmentInlineConfig({'
    );
    // Close the extra paren right before the matching `});` of createServer({...})
    if (replaced !== raw) {
      const marker = 'await createServer(__ccMaybeAugmentInlineConfig({';
      const startIdx = replaced.indexOf(marker);
      let depth = 1;
      let idx = startIdx + marker.length;
      while (idx < replaced.length && depth > 0) {
        const c = replaced[idx];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        idx++;
      }
      // idx is right after the closing '}' of the inlineConfig object
      if (depth === 0 && replaced[idx] === ')') {
        const finalSrc =
          helperPrefix + replaced.slice(0, idx) + ')' + replaced.slice(idx);
        return {
          ...loaded,
          source: finalSrc,
          shortCircuit: true
        };
      }
    }
    return loaded;
  }

  return nextLoad(url, context);
}
