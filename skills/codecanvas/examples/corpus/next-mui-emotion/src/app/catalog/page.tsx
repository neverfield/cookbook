/** @jsxImportSource react */
import { CATALOG_ITEMS } from '@/data/catalog';
import { ServerCatalogHeader } from '@/components/ServerCatalogHeader';
import { CatalogBrowser } from '@/components/CatalogBrowser';

export default function CatalogPage() {
  return (
    <div>
      <ServerCatalogHeader
        eyebrow="RSC → Client Boundary"
        title="Component Catalog"
        description="Server-fetched catalog entries streamed into an Emotion and MUI client browser."
      />
      <CatalogBrowser items={CATALOG_ITEMS} />
    </div>
  );
}
