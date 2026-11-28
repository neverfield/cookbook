import { SectionHeading } from '@/components/ui/SectionHeading';
import { WorkspaceSettingsForm } from '@/components/WorkspaceSettingsForm';

export default function SettingsPage() {
  return (
    <div>
      <SectionHeading
        eyebrow="Tokens & Conventions"
        title="Workspace Settings"
        description="Tests CSS custom property token overrides and conditional Tailwind utility branches."
      />
      <WorkspaceSettingsForm />
    </div>
  );
}
