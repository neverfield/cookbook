import React, { useState } from 'react';
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
          title={`${release.version} — ${release.title}`}
          subtitle={`Channel: ${release.channel} · Owner: ${release.owner}`}
          actions={<StatusBadge status={release.status} />}
        >
          <p style={{ margin: 0, fontSize: 14 }}>{release.summary}</p>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="sr-caption">{release.screensTouched} screens impacted</span>
            <Link to={`/releases/${release.id}`}>
              <ActionButton variant="secondary" size="sm">Open detail</ActionButton>
            </Link>
          </div>
        </Panel>
      ))}
    </div>
  );
}
