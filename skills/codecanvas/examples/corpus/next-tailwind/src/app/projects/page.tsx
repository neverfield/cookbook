import { PROJECTS } from '@/data/projects';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { ProjectFilterBoard } from '@/components/ProjectFilterBoard';

export default function ProjectsPage() {
  return (
    <div>
      <SectionHeading
        eyebrow="RSC → Client Composition"
        title="Projects Directory"
        description="Server-loaded project catalog passed into a client filter board using shared Tailwind primitives."
      />
      <ProjectFilterBoard projects={PROJECTS} />
    </div>
  );
}
