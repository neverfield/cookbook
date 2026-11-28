import Link from 'next/link';
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
        eyebrow={`Project · ${project.environment}`}
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
