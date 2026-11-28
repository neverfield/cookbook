import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { initGitRepo } from './proc.mjs';

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath, obj) {
  writeFile(filePath, JSON.stringify(obj, null, 2) + '\n');
}

function writeSharedUiPackage(wsDir) {
  const uiDir = path.join(wsDir, 'packages', 'ui');
  writeJson(path.join(uiDir, 'package.json'), {
    name: '@acme/ui',
    version: '0.0.1',
    private: true,
    type: 'module',
    exports: {
      '.': './src/index.ts'
    }
  });
  writeFile(
    path.join(uiDir, 'src', 'index.ts'),
    `export { Button } from './Button';\n`
  );
  writeFile(
    path.join(uiDir, 'src', 'Button.tsx'),
    `'use client';

import React from 'react';

export interface ButtonProps {
  label: string;
}

export function Button({ label }: ButtonProps) {
  return (
    <button type="button" className="acme-btn">
      <span>{label}</span>
    </button>
  );
}
`
  );
}

/**
 * Create a git-initialized pnpm monorepo fixture with Next 15 or 16 + workspace package @acme/ui.
 */
export function createNextMonorepoFixture(
  wsDir,
  { nextVersion = '16.4.6', configMode = 'ts', withExistingAgentsMd = false } = {}
) {
  fs.mkdirSync(wsDir, { recursive: true });

  writeFile(
    path.join(wsDir, '.gitignore'),
    `node_modules/\n.next/\n.turbo/\n*.log\n`
  );
  writeFile(
    path.join(wsDir, 'pnpm-workspace.yaml'),
    `packages:\n  - 'apps/*'\n  - 'packages/*'\n`
  );
  writeJson(path.join(wsDir, 'package.json'), {
    name: 'next-monorepo-fixture',
    private: true,
    scripts: {
      'dev:web': 'pnpm --filter @acme/web dev',
      'dev:turbo-strict': 'node scripts/fake-turbo-strict.mjs'
    }
  });

  // Simulates a root orchestrator (like `turbo dev` in strict env mode) that strips NODE_OPTIONS
  writeFile(
    path.join(wsDir, 'scripts', 'fake-turbo-strict.mjs'),
    `import { spawn } from 'node:child_process';
import path from 'node:path';

const webDir = path.resolve('apps/web');
const cleanEnv = { ...process.env };
delete cleanEnv.NODE_OPTIONS; // Strict env mode strips NODE_OPTIONS!

const args = ['exec', 'next', 'dev', ...process.argv.slice(2)];
const child = spawn('pnpm', args, { cwd: webDir, env: cleanEnv, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
`
  );

  writeSharedUiPackage(wsDir);

  const appDir = path.join(wsDir, 'apps', 'web');
  writeJson(path.join(appDir, 'package.json'), {
    name: '@acme/web',
    version: '0.0.1',
    private: true,
    scripts: {
      dev: 'next dev',
      'dev:turbopack': 'next dev --turbopack',
      'dev:webpack': 'next dev --webpack',
      'dev:wrapped': 'node scripts/dev-wrapper.mjs'
    },
    dependencies: {
      '@acme/ui': 'workspace:*',
      next: nextVersion,
      react: '19.3.1',
      'react-dom': '19.3.1'
    },
    devDependencies: {
      '@types/node': '^22.0.0',
      '@types/react': '^19.0.0',
      typescript: '^5.8.0'
    }
  });

  // Realistic dotenv/doppler-like wrapper script that spawns a helper node process then next dev
  writeFile(
    path.join(appDir, 'scripts', 'dev-wrapper.mjs'),
    `import { execFileSync, spawn } from 'node:child_process';

// Simulate a pre-flight helper script running under the same NODE_OPTIONS
execFileSync(process.execPath, ['-e', 'process.stdout.write("preflight-ok")'], {
  env: process.env
});

const extraArgs = process.argv.slice(2);
const child = spawn('pnpm', ['exec', 'next', 'dev', ...extraArgs], {
  cwd: process.cwd(),
  env: { ...process.env, WRAPPED_BY_DEV_SCRIPT: '1' },
  stdio: 'inherit'
});
child.on('exit', (code) => process.exit(code ?? 0));
`
  );

  writeJson(path.join(appDir, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2017',
      lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: 'preserve',
      incremental: true,
      plugins: [{ name: 'next' }]
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
    exclude: ['node_modules']
  });

  // Pre-existing tracked next-env.d.ts (must remain untouched by instrumented run)
  writeFile(
    path.join(appDir, 'next-env.d.ts'),
    `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`
  );

  if (withExistingAgentsMd) {
    writeFile(
      path.join(appDir, 'AGENTS.md'),
      `# Custom App Agents Guide\n\nDo not modify this tracked file during codecanvas runs.\n`
    );
  }

  if (configMode === 'ts') {
    writeFile(
      path.join(appDir, 'next.config.ts'),
      `import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true
};

export default nextConfig;
`
    );
  } else if (configMode === 'mjs-async-fn') {
    writeFile(
      path.join(appDir, 'next.config.mjs'),
      `export default async function nextConfig(_phase) {
  return {
    reactStrictMode: true,
    webpack(config) {
      return config;
    }
  };
}
`
    );
  }
  // configMode === 'none' intentionally omits next.config.*

  writeFile(
    path.join(appDir, 'app', 'layout.tsx'),
    `import React from 'react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`
  );

  writeFile(
    path.join(appDir, 'app', 'components', 'Counter.tsx'),
    `'use client';

import React, { useState } from 'react';

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <section className="counter-box">
      <p>Count: {count}</p>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Increment
      </button>
    </section>
  );
}
`
  );

  writeFile(
    path.join(appDir, 'app', 'page.tsx'),
    `import React from 'react';
import { Button } from '@acme/ui';
import { Counter } from './components/Counter';

export default function HomePage() {
  return (
    <main className="home-root">
      <h1>Next Monorepo Fixture</h1>
      <p>Wrapped env: {process.env.WRAPPED_BY_DEV_SCRIPT || 'none'}</p>
      <Button label="Workspace Action" />
      <Counter />
    </main>
  );
}
`
  );

  // Edge runtime route importing a JSX-instrumented helper to verify __cc prelude never throws
  writeFile(
    path.join(appDir, 'app', 'lib', 'edge-badge.tsx'),
    `export function edgeBadgeText() {
  const tag = <span>edge-ok</span>;
  return tag ? 'edge-ok' : 'fail';
}
`
  );

  writeFile(
    path.join(appDir, 'app', 'api', 'edge', 'route.ts'),
    `import { edgeBadgeText } from '../../lib/edge-badge';

export const runtime = 'edge';

export async function GET() {
  return new Response(JSON.stringify({ ok: true, badge: edgeBadgeText() }), {
    headers: { 'content-type': 'application/json' }
  });
}
`
  );

  execFileSync('pnpm', ['install', '--prefer-offline', '--no-frozen-lockfile'], {
    cwd: wsDir,
    stdio: 'pipe'
  });

  // Ignore pnpm-lock.yaml created during install before initial commit
  initGitRepo(wsDir);

  return { wsDir, appDir };
}

/**
 * Create a git-initialized pnpm monorepo fixture with Vite 5/6/7/8 + workspace package @acme/ui.
 */
export function createViteMonorepoFixture(
  wsDir,
  { viteVersion = '8.4.0', pluginReactVersion = '6.3.0', reactVersion = '19.3.1', configMode = 'ts-object' } = {}
) {
  fs.mkdirSync(wsDir, { recursive: true });

  writeFile(
    path.join(wsDir, '.gitignore'),
    `node_modules/\ndist/\n*.log\n`
  );
  writeFile(
    path.join(wsDir, 'pnpm-workspace.yaml'),
    `packages:\n  - 'apps/*'\n  - 'packages/*'\n`
  );
  writeJson(path.join(wsDir, 'package.json'), {
    name: 'vite-monorepo-fixture',
    private: true,
    scripts: {
      'dev:web': 'pnpm --filter @acme/vite-web dev'
    }
  });

  writeSharedUiPackage(wsDir);

  const appDir = path.join(wsDir, 'apps', 'web');
  writeJson(path.join(appDir, 'package.json'), {
    name: '@acme/vite-web',
    version: '0.0.1',
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite',
      'dev:wrapped': 'node scripts/dev-wrapper.mjs'
    },
    dependencies: {
      '@acme/ui': 'workspace:*',
      react: reactVersion,
      'react-dom': reactVersion
    },
    devDependencies: {
      '@vitejs/plugin-react': pluginReactVersion,
      vite: viteVersion
    }
  });

  writeFile(
    path.join(appDir, 'scripts', 'dev-wrapper.mjs'),
    `import { execFileSync, spawn } from 'node:child_process';

execFileSync(process.execPath, ['-e', 'process.stdout.write("vite-preflight-ok")'], {
  env: process.env
});

const extraArgs = process.argv.slice(2);
const child = spawn('pnpm', ['exec', 'vite', ...extraArgs], {
  cwd: process.cwd(),
  env: { ...process.env, WRAPPED_BY_DEV_SCRIPT: '1' },
  stdio: 'inherit'
});
child.on('exit', (code) => process.exit(code ?? 0));
`
  );

  if (configMode === 'ts-object') {
    writeFile(
      path.join(appDir, 'vite.config.ts'),
      `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()]
});
`
    );
  } else if (configMode === 'ts-fn') {
    writeFile(
      path.join(appDir, 'vite.config.ts'),
      `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(async ({ mode }) => {
  return {
    define: { __APP_MODE__: JSON.stringify(mode) },
    plugins: [react()]
  };
});
`
    );
  }
  // configMode === 'none' intentionally omits vite.config.*

  writeFile(
    path.join(appDir, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Vite Fixture</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`
  );

  writeFile(
    path.join(appDir, 'src', 'App.css'),
    `.vite-shell {
  padding: 24px;
  color: #111827;
}
.acme-btn {
  background: #2563eb;
  color: white;
}
`
  );

  writeFile(
    path.join(appDir, 'src', 'App.tsx'),
    `import React from 'react';
import { Button } from '@acme/ui';
import './App.css';

export function App() {
  return (
    <main className="vite-shell">
      <h1>Vite Monorepo Fixture</h1>
      <Button label="Workspace Button" />
    </main>
  );
}
`
  );

  writeFile(
    path.join(appDir, 'src', 'main.tsx'),
    `import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
`
  );

  execFileSync('pnpm', ['install', '--prefer-offline', '--no-frozen-lockfile'], {
    cwd: wsDir,
    stdio: 'pipe'
  });

  initGitRepo(wsDir);

  return { wsDir, appDir };
}
