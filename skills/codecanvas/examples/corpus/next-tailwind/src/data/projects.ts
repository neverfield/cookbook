export interface ProjectTask {
  id: string;
  title: string;
  done: boolean;
}

export interface WorkspaceProject {
  slug: string;
  name: string;
  environment: 'production' | 'staging' | 'preview';
  status: 'healthy' | 'degraded' | 'paused';
  owner: string;
  routesCount: number;
  summary: string;
  tasks: ProjectTask[];
}

export const PROJECTS: WorkspaceProject[] = [
  {
    slug: 'storefront-web',
    name: 'Storefront Web',
    environment: 'production',
    status: 'healthy',
    owner: 'Commerce Core',
    routesCount: 24,
    summary: 'Customer-facing catalog, cart, and localized checkout flows.',
    tasks: [
      { id: 't-1', title: 'Audit responsive hero spacing tokens', done: true },
      { id: 't-2', title: 'Verify dark badge contrast on mobile', done: true },
      { id: 't-3', title: 'Consolidate card header primitives', done: false },
    ],
  },
  {
    slug: 'billing-portal',
    name: 'Billing Portal',
    environment: 'staging',
    status: 'degraded',
    owner: 'Revenue Platform',
    routesCount: 14,
    summary: 'Self-serve invoice history, seat upgrades, and payment methods.',
    tasks: [
      { id: 't-4', title: 'Align table row hover tokens', done: true },
      { id: 't-5', title: 'Resolve compact density wrapping on tablet', done: false },
    ],
  },
  {
    slug: 'docs-hub',
    name: 'Docs Hub',
    environment: 'preview',
    status: 'paused',
    owner: 'Developer Experience',
    routesCount: 38,
    summary: 'Interactive API guides and versioned reference pages.',
    tasks: [
      { id: 't-6', title: 'Standardize callout border radius variables', done: false },
      { id: 't-7', title: 'Update sidebar active state ring', done: true },
    ],
  },
];

export function getProjectBySlug(slug: string): WorkspaceProject {
  return PROJECTS.find((project) => project.slug === slug) ?? PROJECTS[0];
}
