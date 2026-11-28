import React, { useState } from 'react';
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
