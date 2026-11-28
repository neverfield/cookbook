import React, { useState } from 'react';
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
