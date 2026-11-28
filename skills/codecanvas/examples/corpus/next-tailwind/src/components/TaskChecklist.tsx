'use client';

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
          style={{ width: `${pct}%` }}
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
