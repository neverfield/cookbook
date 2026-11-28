/** @jsxImportSource react */
import { CATALOG_ITEMS, getCatalogItem } from '@/data/catalog';
import { ServerCatalogHeader } from '@/components/ServerCatalogHeader';
import { ItemInspector } from '@/components/ItemInspector';

export function generateStaticParams() {
  return CATALOG_ITEMS.map((item) => ({ id: item.id }));
}

export default async function CatalogDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const item = getCatalogItem(id);

  return (
    <div>
      <ServerCatalogHeader
        eyebrow={`Component · ${item.category}`}
        title={item.name}
        description={item.summary}
      />
      <ItemInspector item={item} />
    </div>
  );
}
