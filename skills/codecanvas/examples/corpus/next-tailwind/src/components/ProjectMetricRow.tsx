import type { WorkspaceProject } from '@/data/projects';
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
