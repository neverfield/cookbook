#!/usr/bin/env node
/**
 * Deterministic generator for the codecanvas v2 Sprint 0 seed corpus.
 *
 * Usage:
 *   node skills/codecanvas/scripts/generate-corpus.mjs          # generate/update corpus apps
 *   node skills/codecanvas/scripts/generate-corpus.mjs --check  # verify files match generator output
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORPUS_ROOT = path.resolve(__dirname, '../examples/corpus');

const PRESERVED_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'out',
  '.turbo',
  '.codecanvas',
]);

const PRESERVED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'next-env.d.ts',
]);

function isPreservedFile(fileName) {
  return PRESERVED_FILES.has(fileName) || fileName.endsWith('.tsbuildinfo');
}

function json(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function normalize(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

function buildCorpusGitignore() {
  return normalize(`# Dependencies and build outputs (never commit generated artifacts)
node_modules/
.next/
dist/
out/
.turbo/
*.tsbuildinfo

# Local lockfiles and framework-generated type shims
package-lock.json
pnpm-lock.yaml
yarn.lock
next-env.d.ts

# Local codecanvas cache
.codecanvas/cache/
`);
}

function buildViteReact18JsApp() {
  const files = {};

  files['package.json'] = json({
    name: 'corpus-vite-react18-js',
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview',
    },
    dependencies: {
      react: '^18.3.1',
      'react-dom': '^18.3.1',
      'react-router-dom': '^6.30.6',
    },
    devDependencies: {
      '@vitejs/plugin-react': '^4.7.0',
      vite: '^6.4.6',
    },
  });

  files['vite.config.js'] = normalize(`import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'classic',
    }),
  ],
  css: {
    devSourcemap: true,
  },
});
`);

  files['index.html'] = normalize(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Release Studio — Vite React 18 JS Corpus</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`);

  files['src/styles/tokens.css'] = normalize(`:root {
  --color-bg: #f6f7fb;
  --color-surface: #ffffff;
  --color-surface-muted: #eef1f7;
  --color-ink: #141926;
  --color-ink-muted: #525d73;
  --color-border: #d8dfec;
  --color-accent: #2457e6;
  --color-accent-hover: #1b44b8;
  --color-accent-soft: #e8efff;
  --color-success: #16794c;
  --color-success-soft: #e6f6ee;
  --color-warning: #a35c00;
  --color-warning-soft: #fff4e0;
  --color-danger: #b42318;
  --color-danger-soft: #fdecec;
  --radius-sm: 6px;
  --radius-md: 12px;
  --radius-pill: 999px;
  --space-xs: 6px;
  --space-sm: 12px;
  --space-md: 20px;
  --space-lg: 28px;
  --shadow-card: 0 1px 3px rgba(20, 25, 38, 0.08);
  --shadow-elevated: 0 8px 24px rgba(20, 25, 38, 0.12);
}
`);

  files['src/styles/global.css'] = normalize(`*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  background-color: var(--color-bg);
  color: var(--color-ink);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  line-height: 1.5;
}

a {
  color: inherit;
  text-decoration: none;
}

.app-shell .sidebar-link {
  color: var(--color-ink-muted);
  border-radius: var(--radius-sm);
  transition: background-color 120ms ease, color 120ms ease;
}

.app-shell .sidebar-link:hover {
  background-color: var(--color-surface-muted);
  color: var(--color-ink);
}

.section-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-sm);
}

.two-column-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: var(--space-md);
}

.sr-caption {
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-ink-muted);
}

.density-compact {
  --space-md: 14px;
}

@media (max-width: 768px) {
  .section-grid {
    grid-template-columns: 1fr;
  }

  .two-column-grid {
    grid-template-columns: 1fr;
  }
}
`);

  files['src/utils/classNames.js'] = normalize(`/**
 * Joins truthy class names deterministically for computed className tests.
 */
export function joinClasses(...parts) {
  const result = [];
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === 'string') {
      result.push(part);
    } else if (Array.isArray(part)) {
      const nested = joinClasses(...part);
      if (nested) result.push(nested);
    } else if (typeof part === 'object') {
      for (const [key, enabled] of Object.entries(part)) {
        if (enabled) result.push(key);
      }
    }
  }
  return result.join(' ');
}

export const RELEASE_STATUS_META = {
  ready: { label: 'Ready to ship', tone: 'success' },
  review: { label: 'In review', tone: 'warning' },
  blocked: { label: 'Blocked', tone: 'danger' },
};
`);

  files['src/data/releases.js'] = normalize(`export const METRICS = [
  { id: 'active-trains', label: 'Active trains', value: '4', delta: '+1 this cycle', tone: 'accent' },
  { id: 'pass-rate', label: 'Verification pass rate', value: '98.4%', delta: '+0.6% vs last week', tone: 'success' },
  { id: 'open-blockers', label: 'Open blockers', value: '2', delta: '1 critical review', tone: 'warning' },
];

export const RELEASES = [
  {
    id: 'rel-241',
    version: 'v2.4.1',
    title: 'Checkout Tax Breakdown',
    owner: 'Maya Lin',
    channel: 'web-prod',
    status: 'ready',
    screensTouched: 6,
    summary: 'Clarifies regional VAT line items and aligns summary spacing across breakpoints.',
    checks: [
      { id: 'chk-1', label: 'Visual diff under 0.1% threshold', done: true },
      { id: 'chk-2', label: 'Keyboard focus order verified', done: true },
      { id: 'chk-3', label: 'Staging smoke routes returning 200', done: true },
    ],
  },
  {
    id: 'rel-242',
    version: 'v2.4.2',
    title: 'Billing Seat Estimator',
    owner: 'Devon Patel',
    channel: 'web-beta',
    status: 'review',
    screensTouched: 11,
    summary: 'Introduces tiered seat breakdown cards with responsive grid stacking.',
    checks: [
      { id: 'chk-4', label: 'Token contrast ratio >= 4.5:1', done: true },
      { id: 'chk-5', label: 'Design sign-off on tablet layout', done: false },
      { id: 'chk-6', label: 'Telemetry payload schema check', done: true },
    ],
  },
  {
    id: 'rel-243',
    version: 'v2.4.3',
    title: 'Workspace Role Matrix',
    owner: 'Elena Gomez',
    channel: 'web-canary',
    status: 'blocked',
    screensTouched: 9,
    summary: 'Refines role permission badges and adds read-only audit drawer states.',
    checks: [
      { id: 'chk-7', label: 'Audit drawer scroll trap resolved', done: false },
      { id: 'chk-8', label: 'Empty state copy approved', done: true },
      { id: 'chk-9', label: 'Permissions API fixture recorded', done: false },
    ],
  },
];

export function findReleaseById(id) {
  return RELEASES.find((item) => item.id === id) || RELEASES[0];
}
`);

  files['src/components/ActionButton.module.css'] = normalize(`.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 9px 16px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.primary {
  background-color: var(--color-accent);
  color: #ffffff;
}

.primary:hover {
  background-color: var(--color-accent-hover);
}

.secondary {
  background-color: var(--color-surface);
  border-color: var(--color-border);
  color: var(--color-ink);
}

.secondary:hover {
  background-color: var(--color-surface-muted);
}

.ghost {
  background-color: transparent;
  color: var(--color-accent);
}

.ghost:hover {
  background-color: var(--color-accent-soft);
}

.compact {
  padding: 6px 11px;
  font-size: 13px;
}

.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
`);

  files['src/components/ActionButton.jsx'] = normalize(`import React from 'react';
import styles from './ActionButton.module.css';
import { joinClasses } from '../utils/classNames.js';

const VARIANT_STYLES = {
  primary: styles.primary,
  secondary: styles.secondary,
  ghost: styles.ghost,
};

export const ActionButton = React.forwardRef(function ActionButton(
  {
    variant = 'primary',
    size = 'md',
    disabled = false,
    className = '',
    type = 'button',
    children,
    ...rest
  },
  ref
) {
  const computedClassName = joinClasses(
    styles.button,
    VARIANT_STYLES[variant] || styles.primary,
    size === 'sm' && styles.compact,
    disabled && styles.disabled,
    className
  );

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={computedClassName}
      {...rest}
    >
      {children}
    </button>
  );
});
`);

  files['src/components/StatusBadge.module.css'] = normalize(`.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 600;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: currentColor;
}

.success {
  background-color: var(--color-success-soft);
  color: var(--color-success);
}

.warning {
  background-color: var(--color-warning-soft);
  color: var(--color-warning);
}

.danger {
  background-color: var(--color-danger-soft);
  color: var(--color-danger);
}

.compact {
  padding: 2px 8px;
  font-size: 11px;
}
`);

  files['src/components/StatusBadge.jsx'] = normalize(`import React from 'react';
import styles from './StatusBadge.module.css';
import { RELEASE_STATUS_META, joinClasses } from '../utils/classNames.js';

const TONE_CLASS = {
  success: styles.success,
  warning: styles.warning,
  danger: styles.danger,
};

export const StatusBadge = React.memo(function StatusBadge({
  status = 'ready',
  compact = false,
  className = '',
}) {
  const meta = RELEASE_STATUS_META[status] || RELEASE_STATUS_META.ready;
  const badgeClass = joinClasses(
    styles.badge,
    TONE_CLASS[meta.tone],
    { [styles.compact]: compact },
    className
  );

  return (
    <span className={badgeClass} data-status={status}>
      <span className={styles.dot} aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
});
`);

  files['src/components/Panel.module.css'] = normalize(`.panel {
  background-color: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
}

.elevated {
  box-shadow: var(--shadow-elevated);
}

.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-sm);
  padding: var(--space-md);
  border-bottom: 1px solid var(--color-border);
}

.title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}

.subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--color-ink-muted);
}

.body {
  padding: var(--space-md);
}
`);

  files['src/components/Panel.jsx'] = normalize(`import React from 'react';
import styles from './Panel.module.css';

const BASE_BODY_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

export function Panel({
  title,
  subtitle,
  actions = null,
  elevated = false,
  className = '',
  bodyStyle = null,
  children,
}) {
  const panelClass = \`\${styles.panel} \${elevated ? styles.elevated : ''} \${className}\`.trim();

  return (
    <section className={panelClass}>
      {title ? (
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>{title}</h2>
            {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
          </div>
          {actions ? <div>{actions}</div> : null}
        </header>
      ) : null}
      <div className={styles.body} style={bodyStyle ? { ...BASE_BODY_STYLE, ...bodyStyle } : BASE_BODY_STYLE}>
        {children}
      </div>
    </section>
  );
}
`);

  files['src/components/MetricCard.module.css'] = normalize(`.card {
  background-color: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.topRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.value {
  margin: 0;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.delta {
  margin: 0;
  font-size: 13px;
  color: var(--color-ink-muted);
}

.accent {
  border-top: 3px solid var(--color-accent);
}

.success {
  border-top: 3px solid var(--color-success);
}

.warning {
  border-top: 3px solid var(--color-warning);
}
`);

  files['src/components/MetricCard.jsx'] = normalize(`import React from 'react';
import styles from './MetricCard.module.css';
import { joinClasses } from '../utils/classNames.js';

export function MetricCard({ label, value, delta, tone = 'accent' }) {
  const toneClass = tone === 'success' ? styles.success : tone === 'warning' ? styles.warning : styles.accent;

  return (
    <article className={joinClasses(styles.card, toneClass)}>
      <div className={styles.topRow}>
        <span className="sr-caption">{label}</span>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.5 8.5L7.2 10.2L10.8 6.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
      <p className={styles.value}>{value}</p>
      <p className={styles.delta}>{delta}</p>
    </article>
  );
}
`);

  files['src/components/ShellLayout.module.css'] = normalize(`.shell {
  display: grid;
  grid-template-columns: 228px minmax(0, 1fr);
  min-height: 100vh;
}

.sidebar {
  background-color: var(--color-surface);
  border-right: 1px solid var(--color-border);
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.brand {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.brandName {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}

.brandTag {
  margin: 0;
  font-size: 12px;
  color: var(--color-ink-muted);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.navLink {
  display: block;
  padding: 9px 12px;
  font-size: 14px;
  font-weight: 500;
}

.navLinkActive {
  background-color: var(--color-accent-soft);
  color: var(--color-accent);
  font-weight: 600;
}

.content {
  padding: var(--space-lg);
  max-width: 1080px;
  width: 100%;
}

@media (max-width: 768px) {
  .shell {
    grid-template-columns: 1fr;
  }

  .sidebar {
    border-right: none;
    border-bottom: 1px solid var(--color-border);
  }
}
`);

  files['src/components/ShellLayout.jsx'] = normalize(`import React from 'react';
import { NavLink } from 'react-router-dom';
import styles from './ShellLayout.module.css';
import { joinClasses } from '../utils/classNames.js';

const NAV_ITEMS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/releases', label: 'Releases', end: false },
  { to: '/settings', label: 'Settings', end: true },
];

export function ShellLayout({ compact = false, children }) {
  return (
    <div className={joinClasses('app-shell', styles.shell, compact && 'density-compact')}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <p className={styles.brandName}>Release Studio</p>
          <p className={styles.brandTag}>Vite + React 18 Classic JSX</p>
        </div>
        <nav className={styles.nav} aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                joinClasses('sidebar-link', styles.navLink, isActive && styles.navLinkActive)
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
`);

  files['src/screens/OverviewScreen.jsx'] = normalize(`import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { METRICS, RELEASES } from '../data/releases.js';
import { MetricCard } from '../components/MetricCard.jsx';
import { Panel } from '../components/Panel.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { ActionButton } from '../components/ActionButton.jsx';

export function OverviewScreen() {
  const [filterStatus, setFilterStatus] = useState('all');

  const visibleReleases =
    filterStatus === 'all'
      ? RELEASES
      : RELEASES.filter((release) => release.status === filterStatus);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <div>
          <span className="sr-caption">Seed Corpus · Vite React 18</span>
          <h1 style={{ margin: '4px 0 0', fontSize: 26 }}>Release Operations</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/releases">
            <ActionButton variant="secondary" size="sm">View all trains</ActionButton>
          </Link>
          <Link to="/settings">
            <ActionButton variant="primary" size="sm">Workspace rules</ActionButton>
          </Link>
        </div>
      </header>

      <section className="section-grid" aria-label="Key metrics">
        {METRICS.map((metric) => (
          <MetricCard
            key={metric.id}
            label={metric.label}
            value={metric.value}
            delta={metric.delta}
            tone={metric.tone}
          />
        ))}
      </section>

      <div className="two-column-grid">
        <Panel
          title="Current release queue"
          subtitle="Filter by readiness or inspect individual release checklists"
          elevated
          actions={
            <div style={{ display: 'flex', gap: 6 }}>
              {['all', 'ready', 'review', 'blocked'].map((status) => (
                <ActionButton
                  key={status}
                  size="sm"
                  variant={filterStatus === status ? 'primary' : 'secondary'}
                  onClick={() => setFilterStatus(status)}
                >
                  {status}
                </ActionButton>
              ))}
            </div>
          }
        >
          {visibleReleases.map((release) => (
            <div
              key={release.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: 12,
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                opacity: release.status === 'blocked' ? 0.85 : 1,
              }}
            >
              <div>
                <Link to={\`/releases/\${release.id}\`} style={{ fontWeight: 600 }}>
                  {release.version} · {release.title}
                </Link>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--color-ink-muted)' }}>
                  Owner: {release.owner} · {release.screensTouched} screens touched
                </p>
              </div>
              <StatusBadge status={release.status} />
            </div>
          ))}
        </Panel>

        <Panel
          title="Verification defaults"
          subtitle="Deterministic snapshot settings"
          bodyStyle={{ gap: 10 }}
        >
          <p style={{ margin: 0, fontSize: 14, color: 'var(--color-ink-muted)' }}>
            All routes render with static seed data and CSS custom property tokens.
          </p>
          <StatusBadge status="ready" compact />
          <Link to="/releases/rel-241">
            <ActionButton variant="ghost" size="sm">Inspect v2.4.1 checklist</ActionButton>
          </Link>
        </Panel>
      </div>
    </div>
  );
}
`);

  files['src/screens/ReleasesScreen.jsx'] = normalize(`import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { RELEASES } from '../data/releases.js';
import { Panel } from '../components/Panel.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { ActionButton } from '../components/ActionButton.jsx';

export function ReleasesScreen() {
  const [selectedChannel, setSelectedChannel] = useState('all');

  const channels = ['all', 'web-prod', 'web-beta', 'web-canary'];
  const filtered =
    selectedChannel === 'all'
      ? RELEASES
      : RELEASES.filter((item) => item.channel === selectedChannel);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <header>
        <span className="sr-caption">Release directory</span>
        <h1 style={{ margin: '4px 0 0', fontSize: 24 }}>All Release Trains</h1>
      </header>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {channels.map((channel) => (
          <ActionButton
            key={channel}
            size="sm"
            variant={selectedChannel === channel ? 'primary' : 'secondary'}
            onClick={() => setSelectedChannel(channel)}
          >
            {channel}
          </ActionButton>
        ))}
      </div>

      {filtered.map((release) => (
        <Panel
          key={release.id}
          title={\`\${release.version} — \${release.title}\`}
          subtitle={\`Channel: \${release.channel} · Owner: \${release.owner}\`}
          actions={<StatusBadge status={release.status} />}
        >
          <p style={{ margin: 0, fontSize: 14 }}>{release.summary}</p>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="sr-caption">{release.screensTouched} screens impacted</span>
            <Link to={\`/releases/\${release.id}\`}>
              <ActionButton variant="secondary" size="sm">Open detail</ActionButton>
            </Link>
          </div>
        </Panel>
      ))}
    </div>
  );
}
`);

  files['src/screens/ReleaseDetailScreen.jsx'] = normalize(`import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { findReleaseById } from '../data/releases.js';
import { Panel } from '../components/Panel.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { ActionButton } from '../components/ActionButton.jsx';

export function ReleaseDetailScreen() {
  const { id } = useParams();
  const release = findReleaseById(id);
  const [checks, setChecks] = useState(release.checks);

  function toggleCheck(checkId) {
    setChecks((prev) =>
      prev.map((item) => (item.id === checkId ? { ...item, done: !item.done } : item))
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span className="sr-caption">Release detail · {release.channel}</span>
          <h1 style={{ margin: '4px 0 0', fontSize: 24 }}>
            {release.version}: {release.title}
          </h1>
        </div>
        <StatusBadge status={release.status} />
      </div>

      <Panel
        title="Pre-ship verification checklist"
        subtitle={release.summary}
        elevated
        actions={
          <Link to="/releases">
            <ActionButton variant="secondary" size="sm">Back to releases</ActionButton>
          </Link>
        }
      >
        {checks.map((item) => (
          <label
            key={item.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: 10,
              borderRadius: 'var(--radius-sm)',
              backgroundColor: item.done ? 'var(--color-success-soft)' : 'var(--color-surface-muted)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={item.done}
              onChange={() => toggleCheck(item.id)}
            />
            <span style={{ textDecoration: item.done ? 'line-through' : 'none' }}>
              {item.label}
            </span>
          </label>
        ))}
      </Panel>
    </div>
  );
}
`);

  files['src/screens/SettingsScreen.jsx'] = normalize(`import React, { useState } from 'react';
import { Panel } from '../components/Panel.jsx';
import { ActionButton } from '../components/ActionButton.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';

export function SettingsScreen({ compact, onToggleCompact }) {
  const [strictTokens, setStrictTokens] = useState(true);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <header>
        <span className="sr-caption">Workspace settings</span>
        <h1 style={{ margin: '4px 0 0', fontSize: 24 }}>Canvas Preferences</h1>
      </header>

      <Panel
        title="Layout density"
        subtitle="Switches CSS custom property spacing across the shell"
        actions={<StatusBadge status={compact ? 'review' : 'ready'} compact />}
      >
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <ActionButton
            variant={compact ? 'secondary' : 'primary'}
            size="sm"
            onClick={() => onToggleCompact(false)}
          >
            Comfortable
          </ActionButton>
          <ActionButton
            variant={compact ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => onToggleCompact(true)}
          >
            Compact
          </ActionButton>
        </div>
      </Panel>

      <Panel
        title="Token preference"
        subtitle="Demonstrates static vs computed inline style origins"
        bodyStyle={{ backgroundColor: strictTokens ? 'var(--color-accent-soft)' : 'var(--color-surface)' }}
      >
        <div style={{ padding: 12, borderRadius: 8, border: '1px solid var(--color-border)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={strictTokens}
              onChange={(event) => setStrictTokens(event.target.checked)}
            />
            <span>Prefer design tokens when writing CSS module updates</span>
          </label>
        </div>
      </Panel>
    </div>
  );
}
`);

  files['src/App.jsx'] = normalize(`import React, { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { ShellLayout } from './components/ShellLayout.jsx';
import { OverviewScreen } from './screens/OverviewScreen.jsx';
import { ReleasesScreen } from './screens/ReleasesScreen.jsx';
import { ReleaseDetailScreen } from './screens/ReleaseDetailScreen.jsx';
import { SettingsScreen } from './screens/SettingsScreen.jsx';

export function App() {
  const [compact, setCompact] = useState(false);

  return (
    <ShellLayout compact={compact}>
      <Routes>
        <Route path="/" element={<OverviewScreen />} />
        <Route path="/releases" element={<ReleasesScreen />} />
        <Route path="/releases/:id" element={<ReleaseDetailScreen />} />
        <Route
          path="/settings"
          element={<SettingsScreen compact={compact} onToggleCompact={setCompact} />}
        />
      </Routes>
    </ShellLayout>
  );
}
`);

  files['src/main.jsx'] = normalize(`import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/tokens.css';
import './styles/global.css';
import { App } from './App.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
`);

  return files;
}

function buildNextMuiEmotionApp() {
  const files = {};

  files['package.json'] = json({
    name: 'corpus-next-mui-emotion',
    private: true,
    version: '0.1.0',
    scripts: {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      typecheck: 'tsc --noEmit',
    },
    dependencies: {
      '@emotion/cache': '^11.14.0',
      '@emotion/react': '^11.14.0',
      '@emotion/styled': '^11.14.0',
      '@mui/material': '^7.3.0',
      '@mui/material-nextjs': '^7.3.0',
      next: '^15.5.0',
      react: '^19.1.0',
      'react-dom': '^19.1.0',
    },
    devDependencies: {
      '@types/node': '^22.15.0',
      '@types/react': '^19.1.0',
      '@types/react-dom': '^19.1.0',
      typescript: '^5.8.3',
    },
  });

  files['next.config.mjs'] = normalize(`/** @type {import('next').NextConfig} */
const nextConfig = {
  compiler: {
    emotion: true,
  },
};

export default nextConfig;
`);

  files['tsconfig.json'] = json({
    compilerOptions: {
      target: 'ES2022',
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
      jsxImportSource: '@emotion/react',
      incremental: true,
      plugins: [{ name: 'next' }],
      paths: {
        '@/*': ['./src/*'],
      },
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
    exclude: ['node_modules'],
  });

  files['src/data/catalog.ts'] = normalize(`export interface CatalogItem {
  id: string;
  name: string;
  category: 'surface' | 'input' | 'feedback';
  owner: string;
  status: 'stable' | 'beta' | 'audit';
  emotionPattern: 'styled' | 'css-prop' | 'mui-styled';
  summary: string;
}

export const CATALOG_ITEMS: CatalogItem[] = [
  {
    id: 'hero-banner',
    name: 'Hero Banner',
    category: 'surface',
    owner: 'Design Systems',
    status: 'stable',
    emotionPattern: 'styled',
    summary: 'Template-literal Emotion styled container with responsive media rules.',
  },
  {
    id: 'metric-tile',
    name: 'Metric Tile',
    category: 'surface',
    owner: 'Analytics UI',
    status: 'stable',
    emotionPattern: 'mui-styled',
    summary: 'MUI styled primitive driven by createTheme palette and spacing tokens.',
  },
  {
    id: 'inline-callout',
    name: 'Inline Callout',
    category: 'feedback',
    owner: 'Checkout UX',
    status: 'beta',
    emotionPattern: 'css-prop',
    summary: 'Client component styled with the Emotion css prop and conditional rules.',
  },
  {
    id: 'action-bar',
    name: 'Action Bar',
    category: 'input',
    owner: 'Core Platform',
    status: 'audit',
    emotionPattern: 'mui-styled',
    summary: 'Combines MUI styled layout slots with read-only sx prop overrides.',
  },
];

export function getCatalogItem(id: string): CatalogItem {
  return CATALOG_ITEMS.find((item) => item.id === id) ?? CATALOG_ITEMS[0];
}
`);

  files['src/theme/theme.ts'] = normalize(`import { createTheme } from '@mui/material/styles';

export const appTheme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#1f4fd8',
      dark: '#163ba3',
    },
    secondary: {
      main: '#6c2bd9',
    },
    background: {
      default: '#f5f7fb',
      paper: '#ffffff',
    },
    text: {
      primary: '#111827',
      secondary: '#4b5563',
    },
  },
  shape: {
    borderRadius: 10,
  },
  typography: {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
});
`);

  files['src/components/ThemeRegistry.tsx'] = normalize(`'use client';

import type { ReactNode } from 'react';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { appTheme } from '@/theme/theme';

export function ThemeRegistry({ children }: { children: ReactNode }) {
  return (
    <AppRouterCacheProvider options={{ key: 'mui' }}>
      <ThemeProvider theme={appTheme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
`);

  files['src/components/EmotionPrimitives.tsx'] = normalize(`'use client';

import type { ReactNode } from 'react';
import { css } from '@emotion/react';
import styled from '@emotion/styled';

export const StyledHeroBanner = styled.section\`
  background: linear-gradient(135deg, #1b3f9c 0%, #2b5be0 100%);
  color: #ffffff;
  border-radius: 14px;
  padding: 24px 28px;
  display: flex;
  flex-direction: column;
  gap: 8px;

  @media (max-width: 768px) {
    padding: 18px 20px;
  }
\`;

export const StyledObjectSurface = styled.div({
  backgroundColor: '#ffffff',
  border: '1px solid #dce3f0',
  borderRadius: 12,
  padding: 20,
  transition: 'border-color 140ms ease',
  '&:hover': {
    borderColor: '#1f4fd8',
  },
});

export const StyledStatusPill = styled.span<{ active?: boolean }>\`
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background-color: \${(props) => (props.active ? '#e5edff' : '#eef1f6')};
  color: \${(props) => (props.active ? '#1f4fd8' : '#4b5563')};
\`;

const calloutBase = css\`
  border-left: 4px solid #1f4fd8;
  background-color: #f0f5ff;
  border-radius: 8px;
  padding: 14px 16px;
  color: #162447;
\`;

const calloutHighlighted = css({
  borderLeftColor: '#6c2bd9',
  backgroundColor: '#f5f0ff',
});

export function EmotionCssCallout({
  title,
  highlighted = false,
  children,
}: {
  title: string;
  highlighted?: boolean;
  children: ReactNode;
}) {
  return (
    <aside css={[calloutBase, highlighted && calloutHighlighted]}>
      <strong
        css={css\`
          display: block;
          font-size: 14px;
          margin-bottom: 4px;
        \`}
      >
        {title}
      </strong>
      <div css={{ fontSize: 13, lineHeight: 1.5 }}>{children}</div>
    </aside>
  );
}
`);

  files['src/components/MuiStyledPrimitives.tsx'] = normalize(`'use client';

import type { ReactNode } from 'react';
import { Box, Button, Chip, Paper, Typography } from '@mui/material';
import { styled as muiStyled } from '@mui/material/styles';

export const MuiSurfaceCard = muiStyled(Paper)(({ theme }) => ({
  padding: theme.spacing(2.5),
  border: \`1px solid \${theme.palette.divider}\`,
  borderRadius: theme.shape.borderRadius,
  boxShadow: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: theme.spacing(1.5),
}));

export const MuiMetricTile = muiStyled('div')(({ theme }) => ({
  padding: theme.spacing(2),
  borderRadius: theme.shape.borderRadius,
  backgroundColor: theme.palette.background.paper,
  border: \`1px solid \${theme.palette.divider}\`,
  display: 'flex',
  flexDirection: 'column',
  gap: theme.spacing(0.5),
}));

export function MuiSxShowcaseCard({
  heading,
  caption,
  badgeLabel,
  actionLabel,
  onAction,
  children,
}: {
  heading: string;
  caption: string;
  badgeLabel: string;
  actionLabel?: string;
  onAction?: () => void;
  children?: ReactNode;
}) {
  return (
    <Box
      sx={{
        p: 2.5,
        borderRadius: 2,
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <div>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {heading}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {caption}
          </Typography>
        </div>
        <Chip
          label={badgeLabel}
          size="small"
          sx={(theme) => ({
            fontWeight: 600,
            bgcolor: theme.palette.action.selected,
          })}
        />
      </Box>
      {children}
      {actionLabel ? (
        <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
          <Button
            variant="contained"
            size="small"
            onClick={onAction}
            sx={{ textTransform: 'none', fontWeight: 600, px: 2 }}
          >
            {actionLabel}
          </Button>
        </Box>
      ) : null}
    </Box>
  );
}
`);

  files['src/components/AppShell.tsx'] = normalize(`'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { css } from '@emotion/react';
import { Box, Container, Stack } from '@mui/material';

const navLinkStyle = (active: boolean) => css\`
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: \${active ? 600 : 500};
  text-decoration: none;
  color: \${active ? '#1f4fd8' : '#374151'};
  background-color: \${active ? '#e8efff' : 'transparent'};
  &:hover {
    background-color: #eef2fa;
  }
\`;

const NAV_LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/catalog', label: 'Catalog' },
  { href: '/settings', label: 'Settings' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <header
        css={css\`
          background-color: #ffffff;
          border-bottom: 1px solid #e5e7eb;
        \`}
      >
        <Container maxWidth="lg">
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ py: 1.5 }}
          >
            <Link
              href="/"
              css={{
                fontWeight: 700,
                fontSize: 16,
                color: '#111827',
                textDecoration: 'none',
              }}
            >
              MUI + Emotion Corpus
            </Link>
            <nav aria-label="Primary" css={{ display: 'flex', gap: 6 }}>
              {NAV_LINKS.map((item) => {
                const active =
                  item.href === '/'
                    ? pathname === '/'
                    : pathname === item.href || pathname.startsWith(\`\${item.href}/\`);
                return (
                  <Link key={item.href} href={item.href} css={navLinkStyle(active)}>
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </Stack>
        </Container>
      </header>
      <Container maxWidth="lg" sx={{ py: 4 }}>
        {children}
      </Container>
    </Box>
  );
}
`);

  files['src/components/ServerCatalogHeader.tsx'] = normalize(`/** @jsxImportSource react */
import type { ReactNode } from 'react';

export function ServerCatalogHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section data-rsc-boundary="header" style={{ marginBottom: 24 }}>
      <p
        style={{
          margin: 0,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: '#4b5563',
        }}
      >
        {eyebrow}
      </p>
      <h1 style={{ margin: '6px 0 8px', fontSize: 28, lineHeight: 1.2 }}>{title}</h1>
      <p style={{ margin: 0, fontSize: 15, color: '#4b5563' }}>{description}</p>
      {children ? <div style={{ marginTop: 14 }}>{children}</div> : null}
    </section>
  );
}
`);

  files['src/components/CatalogBrowser.tsx'] = normalize(`'use client';

import { useState } from 'react';
import Link from 'next/link';
import { css } from '@emotion/react';
import { Box, Button, Stack, Typography } from '@mui/material';
import type { CatalogItem } from '@/data/catalog';
import {
  EmotionCssCallout,
  StyledObjectSurface,
  StyledStatusPill,
} from '@/components/EmotionPrimitives';
import { MuiSurfaceCard, MuiSxShowcaseCard } from '@/components/MuiStyledPrimitives';

export function CatalogBrowser({ items }: { items: CatalogItem[] }) {
  const [category, setCategory] = useState<'all' | CatalogItem['category']>('all');

  const visibleItems =
    category === 'all' ? items : items.filter((item) => item.category === category);

  return (
    <Stack spacing={3}>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        {(['all', 'surface', 'input', 'feedback'] as const).map((cat) => (
          <Button
            key={cat}
            size="small"
            variant={category === cat ? 'contained' : 'outlined'}
            onClick={() => setCategory(cat)}
            sx={{ textTransform: 'capitalize' }}
          >
            {cat}
          </Button>
        ))}
      </Box>

      <div
        css={css\`
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
          @media (max-width: 768px) {
            grid-template-columns: 1fr;
          }
        \`}
      >
        {visibleItems.map((item) => (
          <MuiSurfaceCard key={item.id}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="h6" sx={{ fontSize: 17, fontWeight: 700 }}>
                {item.name}
              </Typography>
              <StyledStatusPill active={item.status === 'stable'}>{item.status}</StyledStatusPill>
            </Box>
            <Typography variant="body2" color="text.secondary">
              {item.summary}
            </Typography>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span css={{ fontSize: 12, color: '#4b5563' }}>
                {item.owner} · {item.emotionPattern}
              </span>
              <Link
                href={\`/catalog/\${item.id}\`}
                css={{ fontSize: 13, fontWeight: 600, color: '#1f4fd8', textDecoration: 'none' }}
              >
                Inspect component
              </Link>
            </Box>
          </MuiSurfaceCard>
        ))}
      </div>

      <StyledObjectSurface>
        <EmotionCssCallout title="Read-only sx testing target" highlighted={category !== 'all'}>
          The card below applies styling via MUI sx props, which codecanvas v2 reports as read-only
          while allowing edits to Emotion styled, css prop, and MUI styled origins.
        </EmotionCssCallout>
        <Box sx={{ mt: 2 }}>
          <MuiSxShowcaseCard
            heading="MUI sx surface"
            caption="Styled exclusively via sx prop objects and theme callback"
            badgeLabel="sx read-only"
          />
        </Box>
      </StyledObjectSurface>
    </Stack>
  );
}
`);

  files['src/components/ItemInspector.tsx'] = normalize(`'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Box, Button, Stack, Typography } from '@mui/material';
import type { CatalogItem } from '@/data/catalog';
import {
  EmotionCssCallout,
  StyledHeroBanner,
  StyledStatusPill,
} from '@/components/EmotionPrimitives';
import { MuiMetricTile, MuiSxShowcaseCard } from '@/components/MuiStyledPrimitives';

export function ItemInspector({ item }: { item: CatalogItem }) {
  const [highlighted, setHighlighted] = useState(false);

  return (
    <Stack spacing={3}>
      <StyledHeroBanner>
        <span css={{ fontSize: 12, opacity: 0.85, textTransform: 'uppercase' }}>
          Pattern: {item.emotionPattern}
        </span>
        <Typography variant="h5" sx={{ fontWeight: 700, color: '#ffffff' }}>
          {item.name}
        </Typography>
        <Typography variant="body2" sx={{ color: 'rgba(255,255,255,0.88)' }}>
          {item.summary}
        </Typography>
      </StyledHeroBanner>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
          gap: 2,
        }}
      >
        <MuiMetricTile>
          <span css={{ fontSize: 12, color: '#4b5563' }}>Owning team</span>
          <strong css={{ fontSize: 18 }}>{item.owner}</strong>
          <StyledStatusPill active={item.status === 'stable'}>{item.status}</StyledStatusPill>
        </MuiMetricTile>

        <MuiSxShowcaseCard
          heading="Interactive highlight"
          caption="Toggle the Emotion css prop conditional branch below"
          badgeLabel={highlighted ? 'accent' : 'default'}
          actionLabel={highlighted ? 'Reset highlight' : 'Highlight callout'}
          onAction={() => setHighlighted((prev) => !prev)}
        />
      </Box>

      <EmotionCssCallout title="Live css prop origin" highlighted={highlighted}>
        This callout mixes a base template-literal rule with a conditional object rule via the
        Emotion css prop.
      </EmotionCssCallout>

      <Box>
        <Button component={Link} href="/catalog" variant="outlined" size="small">
          Back to catalog
        </Button>
      </Box>
    </Stack>
  );
}
`);

  files['src/components/PreferencesPanel.tsx'] = normalize(`'use client';

import { useState } from 'react';
import { Box, FormControlLabel, Stack, Switch, Typography } from '@mui/material';
import { EmotionCssCallout, StyledObjectSurface } from '@/components/EmotionPrimitives';
import { MuiSxShowcaseCard } from '@/components/MuiStyledPrimitives';

export function PreferencesPanel() {
  const [highContrast, setHighContrast] = useState(false);

  return (
    <Stack spacing={3}>
      <StyledObjectSurface>
        <Typography variant="h6" sx={{ fontSize: 17, fontWeight: 700, mb: 1 }}>
          Emotion &amp; MUI Inspector Rules
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={highContrast}
              onChange={(event) => setHighContrast(event.target.checked)}
            />
          }
          label="Emphasize Emotion css prop callout preview"
        />
        <Box sx={{ mt: 2 }}>
          <EmotionCssCallout title="Preview banner" highlighted={highContrast}>
            Toggle switches the conditional css prop branch without touching MUI sx rules.
          </EmotionCssCallout>
        </Box>
      </StyledObjectSurface>

      <MuiSxShowcaseCard
        heading="sx Read-Only Guardrail"
        caption="MUI sx props remain read-only in v2; MUI styled() rules remain directly editable."
        badgeLabel="v2 policy"
      />
    </Stack>
  );
}
`);

  files['src/components/OverviewClientSection.tsx'] = normalize(`'use client';

import Link from 'next/link';
import { Box, Button, Stack, Typography } from '@mui/material';
import type { CatalogItem } from '@/data/catalog';
import {
  EmotionCssCallout,
  StyledHeroBanner,
  StyledStatusPill,
} from '@/components/EmotionPrimitives';
import { MuiMetricTile, MuiSxShowcaseCard } from '@/components/MuiStyledPrimitives';

export function OverviewClientSection({ items }: { items: CatalogItem[] }) {
  return (
    <Stack spacing={3}>
      <StyledHeroBanner>
        <span css={{ fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Emotion Styled + MUI v7 + App Router
        </span>
        <Typography variant="h4" sx={{ fontWeight: 700, color: '#ffffff' }}>
          Component System Overview
        </Typography>
        <Typography variant="body1" sx={{ color: 'rgba(255,255,255,0.9)', maxWidth: 640 }}>
          Exercises @emotion/styled, @emotion/react css prop, MUI styled(), read-only MUI sx props,
          and React Server Component boundaries.
        </Typography>
        <Box sx={{ pt: 1, display: 'flex', gap: 1.5 }}>
          <Button
            component={Link}
            href="/catalog"
            variant="contained"
            sx={{ bgcolor: '#ffffff', color: '#1b3f9c', '&:hover': { bgcolor: '#eef2ff' } }}
          >
            Browse catalog
          </Button>
          <Button
            component={Link}
            href="/settings"
            variant="outlined"
            sx={{ borderColor: 'rgba(255,255,255,0.6)', color: '#ffffff' }}
          >
            Inspector settings
          </Button>
        </Box>
      </StyledHeroBanner>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' },
          gap: 2,
        }}
      >
        <MuiMetricTile>
          <span css={{ fontSize: 12, color: '#4b5563' }}>Catalog components</span>
          <strong css={{ fontSize: 26 }}>{items.length}</strong>
          <StyledStatusPill active>Tracked in RSC</StyledStatusPill>
        </MuiMetricTile>
        <MuiMetricTile>
          <span css={{ fontSize: 12, color: '#4b5563' }}>Editable CSS-in-JS</span>
          <strong css={{ fontSize: 26 }}>3 systems</strong>
          <StyledStatusPill active>Emotion + MUI styled</StyledStatusPill>
        </MuiMetricTile>
        <MuiMetricTile>
          <span css={{ fontSize: 12, color: '#4b5563' }}>Read-only probes</span>
          <strong css={{ fontSize: 26 }}>MUI sx</strong>
          <StyledStatusPill>Reported with reason</StyledStatusPill>
        </MuiMetricTile>
      </Box>

      <EmotionCssCallout title="Emotion css prop coverage">
        Client modules compile with jsxImportSource: &quot;@emotion/react&quot; while App Router
        pages stay React Server Components.
      </EmotionCssCallout>

      <MuiSxShowcaseCard
        heading="MUI sx prop read-only card"
        caption="Used to assert I3 read-only reporting on MUI sx objects and theme functions"
        badgeLabel="sx prop"
      />
    </Stack>
  );
}
`);

  files['src/app/layout.tsx'] = normalize(`/** @jsxImportSource react */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ThemeRegistry } from '@/components/ThemeRegistry';
import { AppShell } from '@/components/AppShell';

export const metadata: Metadata = {
  title: 'Next MUI Emotion — Seed Corpus',
  description: 'Next.js App Router + MUI + Emotion seed corpus app for codecanvas v2',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ThemeRegistry>
          <AppShell>{children}</AppShell>
        </ThemeRegistry>
      </body>
    </html>
  );
}
`);

  files['src/app/page.tsx'] = normalize(`/** @jsxImportSource react */
import { CATALOG_ITEMS } from '@/data/catalog';
import { ServerCatalogHeader } from '@/components/ServerCatalogHeader';
import { OverviewClientSection } from '@/components/OverviewClientSection';

export default function HomePage() {
  return (
    <div>
      <ServerCatalogHeader
        eyebrow="Seed Corpus · Next.js + MUI + Emotion"
        title="Design System Surface"
        description="Server-rendered shell composing Emotion styled, css prop, MUI styled, and read-only sx primitives."
      />
      <OverviewClientSection items={CATALOG_ITEMS} />
    </div>
  );
}
`);

  files['src/app/catalog/page.tsx'] = normalize(`/** @jsxImportSource react */
import { CATALOG_ITEMS } from '@/data/catalog';
import { ServerCatalogHeader } from '@/components/ServerCatalogHeader';
import { CatalogBrowser } from '@/components/CatalogBrowser';

export default function CatalogPage() {
  return (
    <div>
      <ServerCatalogHeader
        eyebrow="RSC → Client Boundary"
        title="Component Catalog"
        description="Server-fetched catalog entries streamed into an Emotion and MUI client browser."
      />
      <CatalogBrowser items={CATALOG_ITEMS} />
    </div>
  );
}
`);

  files['src/app/catalog/[id]/page.tsx'] = normalize(`/** @jsxImportSource react */
import { CATALOG_ITEMS, getCatalogItem } from '@/data/catalog';
import { ServerCatalogHeader } from '@/components/ServerCatalogHeader';
import { ItemInspector } from '@/components/ItemInspector';

export function generateStaticParams() {
  return CATALOG_ITEMS.map((item) => ({ id: item.id }));
}

export default async function CatalogDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const item = getCatalogItem(id);

  return (
    <div>
      <ServerCatalogHeader
        eyebrow={\`Component · \${item.category}\`}
        title={item.name}
        description={item.summary}
      />
      <ItemInspector item={item} />
    </div>
  );
}
`);

  files['src/app/settings/page.tsx'] = normalize(`/** @jsxImportSource react */
import { ServerCatalogHeader } from '@/components/ServerCatalogHeader';
import { PreferencesPanel } from '@/components/PreferencesPanel';

export default function SettingsPage() {
  return (
    <div>
      <ServerCatalogHeader
        eyebrow="Policy & Preview"
        title="Inspector Settings"
        description="Verifies Emotion css prop updates alongside read-only MUI sx guardrails."
      />
      <PreferencesPanel />
    </div>
  );
}
`);

  return files;
}

function buildNextTailwindApp() {
  const files = {};

  files['package.json'] = json({
    name: 'corpus-next-tailwind',
    private: true,
    version: '0.1.0',
    scripts: {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      typecheck: 'tsc --noEmit',
    },
    dependencies: {
      clsx: '^2.1.1',
      next: '^15.5.0',
      react: '^19.1.0',
      'react-dom': '^19.1.0',
      'tailwind-merge': '^3.3.0',
    },
    devDependencies: {
      '@tailwindcss/postcss': '^4.1.0',
      '@types/node': '^22.15.0',
      '@types/react': '^19.1.0',
      '@types/react-dom': '^19.1.0',
      postcss: '^8.5.0',
      tailwindcss: '^4.1.0',
      typescript: '^5.8.3',
    },
  });

  files['next.config.mjs'] = normalize(`/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
`);

  files['postcss.config.mjs'] = normalize(`const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
`);

  files['tsconfig.json'] = json({
    compilerOptions: {
      target: 'ES2022',
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
      plugins: [{ name: 'next' }],
      paths: {
        '@/*': ['./src/*'],
      },
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
    exclude: ['node_modules'],
  });

  files['src/app/globals.css'] = normalize(`@import "tailwindcss";

:root {
  --surface-canvas: #f8fafc;
  --surface-card: #ffffff;
  --surface-subtle: #f1f5f9;
  --ink-primary: #0f172a;
  --ink-secondary: #475569;
  --border-subtle: #e2e8f0;
  --brand-primary: #2563eb;
  --brand-primary-hover: #1d4ed8;
  --brand-soft: #eff6ff;
  --tone-success: #15803d;
  --tone-warning: #b45309;
  --radius-card: 0.75rem;
  --radius-pill: 9999px;
}

@theme inline {
  --color-canvas: var(--surface-canvas);
  --color-card: var(--surface-card);
  --color-subtle: var(--surface-subtle);
  --color-ink: var(--ink-primary);
  --color-ink-muted: var(--ink-secondary);
  --color-line: var(--border-subtle);
  --color-brand: var(--brand-primary);
  --color-brand-hover: var(--brand-primary-hover);
  --color-brand-soft: var(--brand-soft);
  --radius-card: var(--radius-card);
}

body {
  background-color: var(--surface-canvas);
  color: var(--ink-primary);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
`);

  files['src/lib/cn.ts'] = normalize(`import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
`);

  files['src/data/projects.ts'] = normalize(`export interface ProjectTask {
  id: string;
  title: string;
  done: boolean;
}

export interface WorkspaceProject {
  slug: string;
  name: string;
  environment: 'production' | 'staging' | 'preview';
  status: 'healthy' | 'degraded' | 'paused';
  owner: string;
  routesCount: number;
  summary: string;
  tasks: ProjectTask[];
}

export const PROJECTS: WorkspaceProject[] = [
  {
    slug: 'storefront-web',
    name: 'Storefront Web',
    environment: 'production',
    status: 'healthy',
    owner: 'Commerce Core',
    routesCount: 24,
    summary: 'Customer-facing catalog, cart, and localized checkout flows.',
    tasks: [
      { id: 't-1', title: 'Audit responsive hero spacing tokens', done: true },
      { id: 't-2', title: 'Verify dark badge contrast on mobile', done: true },
      { id: 't-3', title: 'Consolidate card header primitives', done: false },
    ],
  },
  {
    slug: 'billing-portal',
    name: 'Billing Portal',
    environment: 'staging',
    status: 'degraded',
    owner: 'Revenue Platform',
    routesCount: 14,
    summary: 'Self-serve invoice history, seat upgrades, and payment methods.',
    tasks: [
      { id: 't-4', title: 'Align table row hover tokens', done: true },
      { id: 't-5', title: 'Resolve compact density wrapping on tablet', done: false },
    ],
  },
  {
    slug: 'docs-hub',
    name: 'Docs Hub',
    environment: 'preview',
    status: 'paused',
    owner: 'Developer Experience',
    routesCount: 38,
    summary: 'Interactive API guides and versioned reference pages.',
    tasks: [
      { id: 't-6', title: 'Standardize callout border radius variables', done: false },
      { id: 't-7', title: 'Update sidebar active state ring', done: true },
    ],
  },
];

export function getProjectBySlug(slug: string): WorkspaceProject {
  return PROJECTS.find((project) => project.slug === slug) ?? PROJECTS[0];
}
`);

  files['src/components/ui/Button.tsx'] = normalize(`import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-hover border-transparent',
  secondary: 'bg-card text-ink border-line hover:bg-subtle',
  ghost: 'bg-transparent text-brand border-transparent hover:bg-brand-soft',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  active = false,
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg border font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        active && 'ring-2 ring-brand/40',
        className
      )}
      {...props}
    />
  );
}
`);

  files['src/components/ui/Badge.tsx'] = normalize(`import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'brand';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-subtle text-ink-muted',
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-800',
  brand: 'bg-brand-soft text-brand',
};

export function Badge({
  tone = 'neutral',
  dot = false,
  className,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
        TONE_CLASSES[tone],
        className
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
      <span>{children}</span>
    </span>
  );
}
`);

  files['src/components/ui/Card.tsx'] = normalize(`import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({
  elevated = false,
  interactive = false,
  className,
  children,
}: {
  elevated?: boolean;
  interactive?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'rounded-[var(--radius-card)] border border-line bg-card p-5',
        elevated ? 'shadow-md' : 'shadow-xs',
        interactive && 'transition-colors hover:border-brand/50',
        className
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-3', className)}>
      <div>
        <h2 className="text-base font-bold text-ink">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p> : null}
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
`);

  files['src/components/ui/SectionHeading.tsx'] = normalize(`import type { ReactNode } from 'react';

export function SectionHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        <p className="text-xs font-semibold tracking-wider text-ink-muted uppercase">{eyebrow}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">{title}</h1>
        <p className="mt-1 text-sm text-ink-muted">{description}</p>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
`);

  files['src/components/SidebarNav.tsx'] = normalize(`'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/projects', label: 'Projects' },
  { href: '/settings', label: 'Settings' },
];

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <aside className="w-full border-b border-line bg-card p-5 md:w-60 md:shrink-0 md:border-r md:border-b-0">
      <div className="mb-5">
        <p className="text-sm font-bold text-ink">Token Workspace</p>
        <p className="text-xs text-ink-muted">Next.js + Tailwind CSS v4</p>
      </div>
      <nav aria-label="Workspace navigation" className="flex gap-1.5 md:flex-col">
        {LINKS.map((item) => {
          const isActive =
            item.href === '/'
              ? pathname === '/'
              : pathname === item.href || pathname.startsWith(\`\${item.href}/\`);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-brand-soft font-semibold text-brand'
                  : 'text-ink-muted hover:bg-subtle hover:text-ink'
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
`);

  files['src/components/ProjectMetricRow.tsx'] = normalize(`import type { WorkspaceProject } from '@/data/projects';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';

export function ProjectMetricRow({ projects }: { projects: WorkspaceProject[] }) {
  const totalRoutes = projects.reduce((sum, item) => sum + item.routesCount, 0);
  const healthyCount = projects.filter((item) => item.status === 'healthy').length;

  return (
    <section
      aria-label="Workspace summary"
      className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3"
    >
      <Card>
        <p className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Projects</p>
        <p className="mt-2 text-3xl font-bold text-ink">{projects.length}</p>
        <div className="mt-2">
          <Badge tone="brand" dot>RSC computed</Badge>
        </div>
      </Card>

      <Card>
        <p className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Healthy apps</p>
        <p className="mt-2 text-3xl font-bold text-ink">{healthyCount}</p>
        <div className="mt-2">
          <Badge tone="success" dot>All checks green</Badge>
        </div>
      </Card>

      <Card>
        <p className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Mapped routes</p>
        <p className="mt-2 text-3xl font-bold text-ink">{totalRoutes}</p>
        <div className="mt-2">
          <Badge tone="neutral">App Router</Badge>
        </div>
      </Card>
    </section>
  );
}
`);

  files['src/components/ProjectFilterBoard.tsx'] = normalize(`'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { WorkspaceProject } from '@/data/projects';
import { cn } from '@/lib/cn';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';

const STATUS_TONE: Record<WorkspaceProject['status'], BadgeTone> = {
  healthy: 'success',
  degraded: 'warning',
  paused: 'neutral',
};

export function ProjectFilterBoard({ projects }: { projects: WorkspaceProject[] }) {
  const [envFilter, setEnvFilter] = useState<'all' | WorkspaceProject['environment']>('all');
  const [compact, setCompact] = useState(false);

  const visible =
    envFilter === 'all'
      ? projects
      : projects.filter((project) => project.environment === envFilter);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {(['all', 'production', 'staging', 'preview'] as const).map((env) => (
            <Button
              key={env}
              size="sm"
              variant={envFilter === env ? 'primary' : 'secondary'}
              active={envFilter === env}
              onClick={() => setEnvFilter(env)}
            >
              {env}
            </Button>
          ))}
        </div>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => setCompact((prev) => !prev)}
        >
          {compact ? 'Switch to comfortable' : 'Switch to compact'}
        </Button>
      </div>

      <div className={cn('grid grid-cols-1 gap-4', !compact && 'md:grid-cols-2')}>
        {visible.map((project) => (
          <Card
            key={project.slug}
            interactive
            className={cn(compact ? 'p-3.5' : 'p-5', {
              'border-amber-300': project.status === 'degraded',
            })}
          >
            <CardHeader
              title={project.name}
              subtitle={\`\${project.owner} · \${project.environment}\`}
              action={
                <Badge tone={STATUS_TONE[project.status]} dot>
                  {project.status}
                </Badge>
              }
            />
            <p className="text-sm text-ink-muted">{project.summary}</p>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-muted">
                {project.routesCount} screens
              </span>
              <Link
                href={\`/projects/\${project.slug}\`}
                className="text-xs font-semibold text-brand hover:underline"
              >
                Open project
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
`);

  files['src/components/TaskChecklist.tsx'] = normalize(`'use client';

import { useState } from 'react';
import type { ProjectTask } from '@/data/projects';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader } from '@/components/ui/Card';

export function TaskChecklist({ initialTasks }: { initialTasks: ProjectTask[] }) {
  const [tasks, setTasks] = useState(initialTasks);
  const completed = tasks.filter((task) => task.done).length;
  const pct = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0;

  function toggle(id: string) {
    setTasks((prev) =>
      prev.map((task) => (task.id === id ? { ...task, done: !task.done } : task))
    );
  }

  return (
    <Card elevated>
      <CardHeader
        title="Design verification checklist"
        subtitle="Client island hydrated inside a Server Component detail route"
        action={<Badge tone={pct === 100 ? 'success' : 'brand'}>{pct}% complete</Badge>}
      />

      <div className="mb-4 h-2 w-full overflow-hidden rounded-full bg-subtle">
        <div
          className="h-full rounded-full bg-brand transition-all"
          style={{ width: \`\${pct}%\` }}
        />
      </div>

      <div className="space-y-2">
        {tasks.map((task) => (
          <label
            key={task.id}
            className={cn(
              'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors',
              task.done
                ? 'border-emerald-200 bg-emerald-50/70 text-emerald-900'
                : 'border-line bg-card text-ink hover:bg-subtle'
            )}
          >
            <input
              type="checkbox"
              checked={task.done}
              onChange={() => toggle(task.id)}
              className="h-4 w-4 rounded border-line accent-brand"
            />
            <span className={cn(task.done && 'line-through opacity-75')}>{task.title}</span>
          </label>
        ))}
      </div>
    </Card>
  );
}
`);

  files['src/components/WorkspaceSettingsForm.tsx'] = normalize(`'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';

const ACCENT_PRESETS = [
  { id: 'blue', label: 'Cobalt', hex: '#2563eb' },
  { id: 'teal', label: 'Teal', hex: '#0d9488' },
  { id: 'violet', label: 'Violet', hex: '#7c3aed' },
];

export function WorkspaceSettingsForm() {
  const [selectedAccent, setSelectedAccent] = useState(ACCENT_PRESETS[0]);
  const [preferTokens, setPreferTokens] = useState(true);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="CSS custom property preview"
          subtitle="Overrides --brand-primary locally on the preview card"
          action={<Badge tone="brand">{selectedAccent.label}</Badge>}
        />
        <div className="flex flex-wrap gap-2">
          {ACCENT_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              size="sm"
              variant={selectedAccent.id === preset.id ? 'primary' : 'secondary'}
              onClick={() => setSelectedAccent(preset)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <div
          className="mt-4 rounded-lg border border-line bg-subtle p-4"
          style={{ ['--brand-primary' as string]: selectedAccent.hex }}
        >
          <p className="text-sm font-semibold text-brand">
            Token-bound sample text using var(--brand-primary)
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Tailwind utility conventions"
          subtitle="Exercises conditional cn() classes on interactive toggles"
        />
        <button
          type="button"
          onClick={() => setPreferTokens((prev) => !prev)}
          className={cn(
            'rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
            preferTokens
              ? 'border-brand bg-brand-soft text-brand'
              : 'border-line bg-card text-ink-muted'
          )}
        >
          {preferTokens ? 'Tokens preferred (active)' : 'Raw utility values allowed'}
        </button>
      </Card>
    </div>
  );
}
`);

  files['src/app/layout.tsx'] = normalize(`import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { SidebarNav } from '@/components/SidebarNav';

export const metadata: Metadata = {
  title: 'Next Tailwind — Seed Corpus',
  description: 'Next.js App Router + Tailwind CSS seed corpus app for codecanvas v2',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <div className="flex min-h-screen flex-col md:flex-row">
          <SidebarNav />
          <main className="mx-auto w-full max-w-5xl flex-1 p-6 md:p-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
`);

  files['src/app/page.tsx'] = normalize(`import Link from 'next/link';
import { PROJECTS } from '@/data/projects';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ProjectMetricRow } from '@/components/ProjectMetricRow';

export default function HomePage() {
  return (
    <div>
      <SectionHeading
        eyebrow="Seed Corpus · Next.js + Tailwind CSS"
        title="Workspace Overview"
        description="Shared UI primitives, conditional cn() classes, CSS custom property tokens, and RSC boundaries."
        actions={
          <Link
            href="/projects"
            className="inline-flex items-center rounded-lg bg-brand px-3.5 py-2 text-xs font-semibold text-white hover:bg-brand-hover"
          >
            View all projects
          </Link>
        }
      />

      <ProjectMetricRow projects={PROJECTS} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {PROJECTS.map((project) => (
          <Card key={project.slug} interactive>
            <CardHeader
              title={project.name}
              subtitle={\`\${project.owner} · \${project.routesCount} routes\`}
              action={
                <Badge
                  tone={
                    project.status === 'healthy'
                      ? 'success'
                      : project.status === 'degraded'
                        ? 'warning'
                        : 'neutral'
                  }
                  dot
                >
                  {project.status}
                </Badge>
              }
            />
            <p className="text-sm text-ink-muted">{project.summary}</p>
            <div className="mt-4">
              <Link
                href={\`/projects/\${project.slug}\`}
                className="text-xs font-semibold text-brand hover:underline"
              >
                Inspect checklist
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
`);

  files['src/app/projects/page.tsx'] = normalize(`import { PROJECTS } from '@/data/projects';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { ProjectFilterBoard } from '@/components/ProjectFilterBoard';

export default function ProjectsPage() {
  return (
    <div>
      <SectionHeading
        eyebrow="RSC → Client Composition"
        title="Projects Directory"
        description="Server-loaded project catalog passed into a client filter board using shared Tailwind primitives."
      />
      <ProjectFilterBoard projects={PROJECTS} />
    </div>
  );
}
`);

  files['src/app/projects/[slug]/page.tsx'] = normalize(`import Link from 'next/link';
import { PROJECTS, getProjectBySlug } from '@/data/projects';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Badge } from '@/components/ui/Badge';
import { TaskChecklist } from '@/components/TaskChecklist';

export function generateStaticParams() {
  return PROJECTS.map((project) => ({ slug: project.slug }));
}

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = getProjectBySlug(slug);

  return (
    <div>
      <SectionHeading
        eyebrow={\`Project · \${project.environment}\`}
        title={project.name}
        description={project.summary}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={project.status === 'healthy' ? 'success' : 'warning'} dot>
              {project.status}
            </Badge>
            <Link
              href="/projects"
              className="rounded-lg border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink hover:bg-subtle"
            >
              Back
            </Link>
          </div>
        }
      />
      <TaskChecklist initialTasks={project.tasks} />
    </div>
  );
}
`);

  files['src/app/settings/page.tsx'] = normalize(`import { SectionHeading } from '@/components/ui/SectionHeading';
import { WorkspaceSettingsForm } from '@/components/WorkspaceSettingsForm';

export default function SettingsPage() {
  return (
    <div>
      <SectionHeading
        eyebrow="Tokens & Conventions"
        title="Workspace Settings"
        description="Tests CSS custom property token overrides and conditional Tailwind utility branches."
      />
      <WorkspaceSettingsForm />
    </div>
  );
}
`);

  return files;
}

function collectManagedFiles() {
  const manifest = new Map();
  manifest.set('.gitignore', buildCorpusGitignore());

  const apps = {
    'vite-react18-js': buildViteReact18JsApp(),
    'next-mui-emotion': buildNextMuiEmotionApp(),
    'next-tailwind': buildNextTailwindApp(),
  };

  for (const [appName, appFiles] of Object.entries(apps)) {
    const sortedPaths = Object.keys(appFiles).sort();
    for (const relPath of sortedPaths) {
      manifest.set(path.posix.join(appName, relPath), appFiles[relPath]);
    }
  }

  return {
    appNames: Object.keys(apps),
    manifest,
  };
}

function listExistingManagedFiles(appDir, prefix) {
  const results = [];
  if (!fs.existsSync(appDir)) return results;

  const entries = fs.readdirSync(appDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (PRESERVED_DIRS.has(entry.name)) continue;
      results.push(
        ...listExistingManagedFiles(
          path.join(appDir, entry.name),
          path.posix.join(prefix, entry.name)
        )
      );
    } else if (entry.isFile()) {
      if (isPreservedFile(entry.name)) continue;
      results.push(path.posix.join(prefix, entry.name));
    }
  }
  return results;
}

function pruneEmptyDirs(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || PRESERVED_DIRS.has(entry.name)) continue;
    pruneEmptyDirs(path.join(dirPath, entry.name));
  }
  if (fs.readdirSync(dirPath).length === 0) {
    fs.rmdirSync(dirPath);
  }
}

function main() {
  const checkMode = process.argv.includes('--check');
  const { appNames, manifest } = collectManagedFiles();

  const existingFiles = new Set();
  if (fs.existsSync(path.join(CORPUS_ROOT, '.gitignore'))) {
    existingFiles.add('.gitignore');
  }
  for (const appName of appNames) {
    for (const rel of listExistingManagedFiles(path.join(CORPUS_ROOT, appName), appName)) {
      existingFiles.add(rel);
    }
  }

  if (checkMode) {
    const diffs = [];
    for (const [relPath, expected] of manifest.entries()) {
      const absPath = path.join(CORPUS_ROOT, relPath);
      if (!fs.existsSync(absPath)) {
        diffs.push(`missing: ${relPath}`);
        continue;
      }
      const actual = fs.readFileSync(absPath, 'utf8');
      if (actual !== expected) {
        diffs.push(`changed: ${relPath}`);
      }
    }
    for (const relPath of existingFiles) {
      if (!manifest.has(relPath)) {
        diffs.push(`unexpected: ${relPath}`);
      }
    }
    if (diffs.length > 0) {
      console.error('Seed corpus is out of sync with generate-corpus.mjs:');
      for (const diff of diffs) {
        console.error(`  - ${diff}`);
      }
      process.exit(1);
    }
    console.log(`Seed corpus matches generator (${manifest.size} files across ${appNames.length} apps).`);
    return;
  }

  fs.mkdirSync(CORPUS_ROOT, { recursive: true });

  let written = 0;
  let unchanged = 0;
  let removed = 0;

  for (const [relPath, content] of manifest.entries()) {
    const absPath = path.join(CORPUS_ROOT, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    if (fs.existsSync(absPath) && fs.readFileSync(absPath, 'utf8') === content) {
      unchanged += 1;
    } else {
      fs.writeFileSync(absPath, content, 'utf8');
      written += 1;
    }
  }

  for (const relPath of existingFiles) {
    if (!manifest.has(relPath)) {
      fs.rmSync(path.join(CORPUS_ROOT, relPath), { force: true });
      removed += 1;
    }
  }

  for (const appName of appNames) {
    pruneEmptyDirs(path.join(CORPUS_ROOT, appName));
  }

  console.log(
    `Generated seed corpus in ${CORPUS_ROOT} (${manifest.size} files: ${written} written, ${unchanged} unchanged, ${removed} removed).`
  );
}

main();
