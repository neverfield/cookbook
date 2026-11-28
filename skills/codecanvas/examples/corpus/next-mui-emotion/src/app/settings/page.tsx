/** @jsxImportSource react */
import { ServerCatalogHeader } from '@/components/ServerCatalogHeader';
import { PreferencesPanel } from '@/components/PreferencesPanel';

export default function SettingsPage() {
  return (
    <div>
      <ServerCatalogHeader
        eyebrow="Policy & Preview"
        title="Inspector Settings"
        description="Verifies Emotion css prop updates alongside read-only MUI sx guardrails."
      />
      <PreferencesPanel />
    </div>
  );
}
