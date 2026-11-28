import Link from 'next/link';
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
              subtitle={`${project.owner} · ${project.routesCount} routes`}
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
                href={`/projects/${project.slug}`}
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
