'use client';

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
              subtitle={`${project.owner} · ${project.environment}`}
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
                href={`/projects/${project.slug}`}
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
