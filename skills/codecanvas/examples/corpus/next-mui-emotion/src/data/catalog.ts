export interface CatalogItem {
  id: string;
  name: string;
  category: 'surface' | 'input' | 'feedback';
  owner: string;
  status: 'stable' | 'beta' | 'audit';
  emotionPattern: 'styled' | 'css-prop' | 'mui-styled';
  summary: string;
}

export const CATALOG_ITEMS: CatalogItem[] = [
  {
    id: 'hero-banner',
    name: 'Hero Banner',
    category: 'surface',
    owner: 'Design Systems',
    status: 'stable',
    emotionPattern: 'styled',
    summary: 'Template-literal Emotion styled container with responsive media rules.',
  },
  {
    id: 'metric-tile',
    name: 'Metric Tile',
    category: 'surface',
    owner: 'Analytics UI',
    status: 'stable',
    emotionPattern: 'mui-styled',
    summary: 'MUI styled primitive driven by createTheme palette and spacing tokens.',
  },
  {
    id: 'inline-callout',
    name: 'Inline Callout',
    category: 'feedback',
    owner: 'Checkout UX',
    status: 'beta',
    emotionPattern: 'css-prop',
    summary: 'Client component styled with the Emotion css prop and conditional rules.',
  },
  {
    id: 'action-bar',
    name: 'Action Bar',
    category: 'input',
    owner: 'Core Platform',
    status: 'audit',
    emotionPattern: 'mui-styled',
    summary: 'Combines MUI styled layout slots with read-only sx prop overrides.',
  },
];

export function getCatalogItem(id: string): CatalogItem {
  return CATALOG_ITEMS.find((item) => item.id === id) ?? CATALOG_ITEMS[0];
}
