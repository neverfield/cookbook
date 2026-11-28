'use client';

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
