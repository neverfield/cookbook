/** @jsxImportSource react */
import { CATALOG_ITEMS } from '@/data/catalog';
import { ServerCatalogHeader } from '@/components/ServerCatalogHeader';
import { OverviewClientSection } from '@/components/OverviewClientSection';

export default function HomePage() {
  return (
    <div>
      <ServerCatalogHeader
        eyebrow="Seed Corpus · Next.js + MUI + Emotion"
        title="Design System Surface"
        description="Server-rendered shell composing Emotion styled, css prop, MUI styled, and read-only sx primitives."
      />
      <OverviewClientSection items={CATALOG_ITEMS} />
    </div>
  );
}
