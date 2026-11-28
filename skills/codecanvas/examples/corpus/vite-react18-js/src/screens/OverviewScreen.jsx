import React, { useState } from 'react';
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
                <Link to={`/releases/${release.id}`} style={{ fontWeight: 600 }}>
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
