import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { runCommand } from './process-mgr.mjs';

async function writeTextFile(rootDir, relPath, contents) {
  const fullPath = path.join(rootDir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, contents, 'utf8');
}

function generateCatalogSource() {
  const genres = ['Sci-Fi', 'Drama', 'Thriller', 'Documentary', 'Comedy', 'Animation'];
  const items = Array.from({ length: 24 }, (_, idx) => {
    const id = String(idx + 1);
    const genre = genres[idx % genres.length];
    return {
      id,
      slug: `title-${id}`,
      title: `Reelhouse Feature #${id}: ${genre} Chronicles`,
      genre,
      year: 2018 + (idx % 9),
      rating: Number((7.1 + ((idx * 7) % 27) / 10).toFixed(1)),
      runtimeMin: 88 + ((idx * 13) % 64),
      featured: idx < 6,
      synopsis: `A richly crafted ${genre.toLowerCase()} production following an ensemble cast through shifting timelines and visual set pieces in episode arc ${id}.`,
      director: `Director ${String.fromCharCode(65 + (idx % 26))}. Vance`,
      cast: [`Actor ${id}A`, `Actor ${id}B`, `Actor ${id}C`],
    };
  });

  return `import { z } from 'zod';

export const SHARED_MARKER = 'PARENT_ORIGIN';

export const TitleSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  genre: z.string(),
  year: z.number(),
  rating: z.number(),
  runtimeMin: z.number(),
  featured: z.boolean(),
  synopsis: z.string(),
  director: z.string(),
  cast: z.array(z.string()),
});

export type CatalogTitle = z.infer<typeof TitleSchema>;

export const CATALOG_TITLES: CatalogTitle[] = ${JSON.stringify(items, null, 2)};

export function getTitleById(id: string): CatalogTitle | undefined {
  return CATALOG_TITLES.find((t) => t.id === id);
}

export function getTitlesByGenre(genre: string): CatalogTitle[] {
  if (!genre || genre === 'All') return CATALOG_TITLES;
  return CATALOG_TITLES.filter((t) => t.genre === genre);
}
`;
}

function generateFormatSource() {
  return `import { format } from 'date-fns';

export function formatRuntime(minutes: number): string {
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hrs > 0 ? \`\${hrs}h \${mins}m\` : \`\${mins}m\`;
}

export function formatReleaseStamp(year: number): string {
  return format(new Date(Date.UTC(year, 5, 15)), 'MMM yyyy');
}
`;
}

function generateExtraSectionComponent(index) {
  return `'use client';

import { Badge, Card } from '@fixture/ui';
import { formatRuntime, type CatalogTitle } from '@fixture/shared';
import { Film, Star, Clock } from 'lucide-react';

export function ShowcaseWidget${index}({ items }: { items: CatalogTitle[] }) {
  const slice = items.slice(${index % 6}, ${(index % 6) + 4});
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4" data-widget="showcase-${index}">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <Film className="h-4 w-4 text-amber-400" />
          <span>Curated Shelf ${index}</span>
        </div>
        <Badge variant="subtle">{slice.length} titles</Badge>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {slice.map((item) => (
          <Card key={item.id} title={item.title} subtitle={\`\${item.genre} · \${item.year}\`}>
            <div className="mt-2 flex items-center gap-3 text-xs text-zinc-400">
              <span className="inline-flex items-center gap-1">
                <Star className="h-3.5 w-3.5 text-amber-400" />
                {item.rating}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                {formatRuntime(item.runtimeMin)}
              </span>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
`;
}

export async function createReelhouseFixture(fixtureDir) {
  const startedAt = performance.now();
  await fs.mkdir(fixtureDir, { recursive: true });

  await writeTextFile(
    fixtureDir,
    'pnpm-workspace.yaml',
    `packages:
  - "apps/*"
  - "packages/*"
`,
  );

  await writeTextFile(
    fixtureDir,
    '.npmrc',
    `strict-peer-dependencies=false
auto-install-peers=true
`,
  );

  await writeTextFile(
    fixtureDir,
    '.gitignore',
    `node_modules/
.next/
.codecanvas/cache/
.env.local
.env.*.local
*.tsbuildinfo
`,
  );

  await writeTextFile(
    fixtureDir,
    '.codecanvas/.gitignore',
    `cache/
`,
  );

  await writeTextFile(
    fixtureDir,
    'package.json',
    JSON.stringify(
      {
        name: 'reelhouse-s5-fixture',
        private: true,
        packageManager: 'pnpm@10.9.0',
        scripts: {
          dev: 'pnpm --filter @fixture/web dev',
          typecheck: 'pnpm --filter @fixture/web typecheck',
        },
        pnpm: {
          onlyBuiltDependencies: ['sharp', '@tailwindcss/oxide'],
        },
      },
      null,
      2,
    ) + '\n',
  );

  // packages/shared
  await writeTextFile(
    fixtureDir,
    'packages/shared/package.json',
    JSON.stringify(
      {
        name: '@fixture/shared',
        version: '0.1.0',
        private: true,
        type: 'module',
        main: './src/index.ts',
        exports: {
          '.': './src/index.ts',
        },
        dependencies: {
          'date-fns': '4.1.0',
          zod: '3.24.4',
        },
      },
      null,
      2,
    ) + '\n',
  );

  await writeTextFile(fixtureDir, 'packages/shared/src/catalog.ts', generateCatalogSource());
  await writeTextFile(fixtureDir, 'packages/shared/src/format.ts', generateFormatSource());
  await writeTextFile(
    fixtureDir,
    'packages/shared/src/index.ts',
    `export * from './catalog';
export * from './format';
`,
  );

  // packages/ui
  await writeTextFile(
    fixtureDir,
    'packages/ui/package.json',
    JSON.stringify(
      {
        name: '@fixture/ui',
        version: '0.1.0',
        private: true,
        type: 'module',
        main: './src/index.ts',
        exports: {
          '.': './src/index.ts',
        },
        dependencies: {
          'class-variance-authority': '0.7.1',
          clsx: '2.1.1',
          'lucide-react': '0.511.0',
          'tailwind-merge': '3.3.0',
        },
        peerDependencies: {
          react: '^19.0.0',
        },
      },
      null,
      2,
    ) + '\n',
  );

  await writeTextFile(
    fixtureDir,
    'packages/ui/src/cn.ts',
    `import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'packages/ui/src/Sentinel.tsx',
    `export const UI_SENTINEL = 'PARENT_ORIGIN';

export function SentinelBanner() {
  return (
    <div
      data-testid="ui-sentinel"
      className="rounded-md border border-emerald-700/50 bg-emerald-950/40 px-3 py-1.5 text-xs font-mono text-emerald-300"
    >
      {\`ui-sentinel:\${UI_SENTINEL}\`}
    </div>
  );
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'packages/ui/src/Badge.tsx',
    `import type { ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
        subtle: 'bg-zinc-800 text-zinc-300 border border-zinc-700',
        accent: 'bg-sky-500/20 text-sky-300 border border-sky-500/30',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps extends VariantProps<typeof badgeVariants> {
  children: ReactNode;
  className?: string;
}

export function Badge({ children, variant, className }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)}>{children}</span>;
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'packages/ui/src/Button.tsx',
    `import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors focus:outline-none',
  {
    variants: {
      variant: {
        primary: 'bg-amber-500 text-zinc-950 hover:bg-amber-400',
        secondary: 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700 border border-zinc-700',
        ghost: 'text-zinc-300 hover:bg-zinc-800',
      },
      size: {
        sm: 'px-3 py-1.5 text-xs',
        md: 'px-4 py-2 text-sm',
        lg: 'px-5 py-2.5 text-base',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  children: ReactNode;
}

export function Button({ children, variant, size, className, ...rest }: ButtonProps) {
  return (
    <button className={cn(buttonVariants({ variant, size }), className)} {...rest}>
      {children}
    </button>
  );
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'packages/ui/src/Card.tsx',
    `import type { ReactNode } from 'react';
import { cn } from './cn';

export interface CardProps {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  className?: string;
}

export function Card({ title, subtitle, children, className }: CardProps) {
  return (
    <article
      className={cn(
        'rounded-xl border border-zinc-800 bg-zinc-900/80 p-4 shadow-sm',
        className,
      )}
    >
      <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
      {subtitle ? <p className="mt-0.5 text-xs text-zinc-400">{subtitle}</p> : null}
      {children}
    </article>
  );
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'packages/ui/src/Navbar.tsx',
    `import { Clapperboard } from 'lucide-react';
import { SentinelBanner } from './Sentinel';

export function Navbar({ envLabel }: { envLabel: string }) {
  return (
    <header className="border-b border-zinc-800 bg-zinc-950/90 px-6 py-4">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Clapperboard className="h-5 w-5 text-amber-400" />
          <span className="text-base font-bold tracking-tight text-zinc-100">Reelhouse</span>
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{envLabel}</span>
        </div>
        <nav className="flex items-center gap-4 text-sm text-zinc-300">
          <a href="/" className="hover:text-white">Home</a>
          <a href="/catalog" className="hover:text-white">Catalog</a>
          <a href="/watchlist" className="hover:text-white">Watchlist</a>
          <a href="/analytics" className="hover:text-white">Analytics</a>
          <a href="/settings" className="hover:text-white">Settings</a>
        </nav>
        <SentinelBanner />
      </div>
    </header>
  );
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'packages/ui/src/index.ts',
    `export { cn } from './cn';
export { Badge, type BadgeProps } from './Badge';
export { Button, type ButtonProps } from './Button';
export { Card, type CardProps } from './Card';
export { Navbar } from './Navbar';
export { SentinelBanner, UI_SENTINEL } from './Sentinel';
`,
  );

  // apps/web
  await writeTextFile(
    fixtureDir,
    'apps/web/package.json',
    JSON.stringify(
      {
        name: '@fixture/web',
        version: '0.1.0',
        private: true,
        scripts: {
          dev: 'next dev --turbopack',
          build: 'next build',
          typecheck: 'tsc --noEmit',
        },
        dependencies: {
          '@fixture/shared': 'workspace:*',
          '@fixture/ui': 'workspace:*',
          '@radix-ui/react-dialog': '1.3.1',
          '@radix-ui/react-dropdown-menu': '2.2.1',
          '@radix-ui/react-tabs': '1.2.1',
          '@tanstack/react-table': '8.21.3',
          'class-variance-authority': '0.7.1',
          clsx: '2.1.1',
          'date-fns': '4.1.0',
          'framer-motion': '14.14.0',
          'lucide-react': '0.511.0',
          next: '16.4.6',
          react: '19.3.1',
          'react-dom': '19.3.1',
          'tailwind-merge': '3.3.0',
          zod: '3.24.4',
        },
        devDependencies: {
          '@tailwindcss/postcss': '4.1.7',
          '@types/node': '22.15.18',
          '@types/react': '19.1.4',
          '@types/react-dom': '19.1.4',
          postcss: '8.5.3',
          tailwindcss: '4.1.7',
          typescript: '5.8.3',
        },
      },
      null,
      2,
    ) + '\n',
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/next.config.mjs',
    `/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@fixture/ui', '@fixture/shared'],
  ...(process.env.CC_DIST_DIR ? { distDir: process.env.CC_DIST_DIR } : {}),
  ...(process.env.CC_TURBOPACK_ROOT
    ? {
        turbopack: {
          root: process.env.CC_TURBOPACK_ROOT,
        },
      }
    : {}),
};

export default nextConfig;
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/postcss.config.mjs',
    `const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['dom', 'dom.iterable', 'esnext'],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: 'preserve',
          incremental: true,
          plugins: [{ name: 'next' }],
          paths: {
            '@/*': ['./src/*'],
          },
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      },
      null,
      2,
    ) + '\n',
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/src/lib/marker.ts',
    `export const APP_MARKER = 'PARENT_ORIGIN';
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/src/app/globals.css',
    `@import "tailwindcss";

:root {
  --bg: #09090b;
  --fg: #fafafa;
}

body {
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, -apple-system, sans-serif;
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/src/app/layout.tsx',
    `import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Navbar } from '@fixture/ui';
import './globals.css';

export const metadata: Metadata = {
  title: 'Reelhouse Fixture (Spike S5)',
  description: 'Realistic multi-page Next.js App Router + pnpm workspace fixture',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const envLabel = process.env.NEXT_PUBLIC_APP_ENV ?? 'unset';
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        <Navbar envLabel={envLabel} />
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
`,
  );

  // Generate 12 realistic client widgets to give Turbopack real module-graph weight
  const widgetImports = [];
  const widgetElements = [];
  for (let i = 1; i <= 12; i += 1) {
    await writeTextFile(
      fixtureDir,
      `apps/web/src/components/ShowcaseWidget${i}.tsx`,
      generateExtraSectionComponent(i),
    );
    widgetImports.push(`import { ShowcaseWidget${i} } from '@/components/ShowcaseWidget${i}';`);
    widgetElements.push(`<ShowcaseWidget${i} items={CATALOG_TITLES} />`);
  }

  await writeTextFile(
    fixtureDir,
    'apps/web/src/app/page.tsx',
    `import Link from 'next/link';
import { Badge, Button, Card, UI_SENTINEL } from '@fixture/ui';
import { CATALOG_TITLES, SHARED_MARKER, formatRuntime } from '@fixture/shared';
import { APP_MARKER } from '@/lib/marker';
${widgetImports.slice(0, 4).join('\n')}

export default function HomePage() {
  const featured = CATALOG_TITLES.filter((t) => t.featured);
  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-950 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Featured Streaming</Badge>
          <Badge variant="accent">{\`app:\${APP_MARKER}\`}</Badge>
          <Badge variant="subtle">{\`shared:\${SHARED_MARKER}\`}</Badge>
          <Badge variant="subtle">{\`ui:\${UI_SENTINEL}\`}</Badge>
        </div>
        <h1 className="mt-4 text-3xl font-bold tracking-tight">Reelhouse Cinema Catalog</h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-400">
          Multi-page Next.js App Router monorepo benchmark fixture for Spike S5 agent clone latency and Turbopack root resolution.
        </p>
        <div className="mt-5 flex gap-3">
          <Link href="/catalog">
            <Button>Browse Catalog</Button>
          </Link>
          <Link href="/settings">
            <Button variant="secondary">Environment Status</Button>
          </Link>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {featured.map((title) => (
          <Link key={title.id} href={\`/title/\${title.id}\`}>
            <Card title={title.title} subtitle={\`\${title.genre} · \${title.year} · \${formatRuntime(title.runtimeMin)}\`}>
              <p className="mt-2 line-clamp-2 text-xs text-zinc-400">{title.synopsis}</p>
            </Card>
          </Link>
        ))}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        ${widgetElements.slice(0, 4).join('\n        ')}
      </div>
    </div>
  );
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/src/components/CatalogBrowser.tsx',
    `'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
} from '@tanstack/react-table';
import { motion } from 'framer-motion';
import { Search, Star } from 'lucide-react';
import { Badge } from '@fixture/ui';
import { formatRuntime, type CatalogTitle } from '@fixture/shared';

const columnHelper = createColumnHelper<CatalogTitle>();

export function CatalogBrowser({ titles }: { titles: CatalogTitle[] }) {
  const [globalFilter, setGlobalFilter] = useState('');

  const columns = useMemo(
    () => [
      columnHelper.accessor('title', {
        header: 'Title',
        cell: (info) => (
          <Link href={\`/title/\${info.row.original.id}\`} className="font-medium text-amber-300 hover:underline">
            {info.getValue()}
          </Link>
        ),
      }),
      columnHelper.accessor('genre', {
        header: 'Genre',
        cell: (info) => <Badge variant="subtle">{info.getValue()}</Badge>,
      }),
      columnHelper.accessor('year', { header: 'Year' }),
      columnHelper.accessor('rating', {
        header: 'Rating',
        cell: (info) => (
          <span className="inline-flex items-center gap-1">
            <Star className="h-3.5 w-3.5 text-amber-400" />
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor('runtimeMin', {
        header: 'Runtime',
        cell: (info) => formatRuntime(info.getValue()),
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: titles,
    columns,
    state: { globalFilter },
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <motion.div initial={{ opacity: 0.95 }} animate={{ opacity: 1 }} className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
        <Search className="h-4 w-4 text-zinc-400" />
        <input
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          placeholder="Filter catalog titles..."
          className="w-full bg-transparent text-sm text-zinc-100 outline-none"
        />
      </div>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-900 text-xs uppercase text-zinc-400">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => (
                  <th key={header.id} className="px-4 py-3">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="hover:bg-zinc-900/60">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-3 text-zinc-300">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/src/app/catalog/page.tsx',
    `import { CATALOG_TITLES } from '@fixture/shared';
import { CatalogBrowser } from '@/components/CatalogBrowser';
${widgetImports.slice(4, 8).join('\n')}

export default function CatalogPage() {
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Full Catalog ({CATALOG_TITLES.length})</h1>
      <CatalogBrowser titles={CATALOG_TITLES} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        ${widgetElements.slice(4, 8).join('\n        ')}
      </div>
    </div>
  );
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/src/app/title/[id]/page.tsx',
    `import { notFound } from 'next/navigation';
import { Badge, Card } from '@fixture/ui';
import { CATALOG_TITLES, formatReleaseStamp, formatRuntime, getTitleById } from '@fixture/shared';

export default async function TitleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const title = getTitleById(id);
  if (!title) {
    notFound();
  }
  const related = CATALOG_TITLES.filter((t) => t.genre === title.genre && t.id !== title.id).slice(0, 3);
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
        <div className="flex items-center gap-2">
          <Badge>{title.genre}</Badge>
          <Badge variant="subtle">{formatReleaseStamp(title.year)}</Badge>
          <Badge variant="subtle">{formatRuntime(title.runtimeMin)}</Badge>
        </div>
        <h1 className="mt-3 text-2xl font-bold">{title.title}</h1>
        <p className="mt-2 text-sm text-zinc-300">{title.synopsis}</p>
        <p className="mt-4 text-xs text-zinc-400">
          Directed by {title.director} · Cast: {title.cast.join(', ')}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {related.map((item) => (
          <Card key={item.id} title={item.title} subtitle={\`Rating \${item.rating}\`} />
        ))}
      </div>
    </div>
  );
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/src/components/WatchlistClient.tsx',
    `'use client';

import { useState } from 'react';
import { Bookmark, Trash2 } from 'lucide-react';
import { Button, Card } from '@fixture/ui';
import type { CatalogTitle } from '@fixture/shared';

export function WatchlistClient({ initial }: { initial: CatalogTitle[] }) {
  const [items, setItems] = useState(initial);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-zinc-400">
        <Bookmark className="h-4 w-4 text-amber-400" />
        <span>{items.length} saved titles</span>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {items.map((item) => (
          <Card key={item.id} title={item.title} subtitle={\`\${item.genre} · \${item.year}\`}>
            <div className="mt-3">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setItems((prev) => prev.filter((x) => x.id !== item.id))}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/src/app/watchlist/page.tsx',
    `import { CATALOG_TITLES } from '@fixture/shared';
import { WatchlistClient } from '@/components/WatchlistClient';

export default function WatchlistPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Watchlist</h1>
      <WatchlistClient initial={CATALOG_TITLES.slice(0, 6)} />
    </div>
  );
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/src/app/analytics/page.tsx',
    `import { CATALOG_TITLES } from '@fixture/shared';
${widgetImports.slice(8, 12).join('\n')}

export default function AnalyticsPage() {
  const avgRating = (
    CATALOG_TITLES.reduce((acc, t) => acc + t.rating, 0) / CATALOG_TITLES.length
  ).toFixed(2);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Catalog Analytics</h1>
      <p className="text-sm text-zinc-400">
        {CATALOG_TITLES.length} total titles · Average rating {avgRating}
      </p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        ${widgetElements.slice(8, 12).join('\n        ')}
      </div>
    </div>
  );
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/src/app/settings/page.tsx',
    `import { Card } from '@fixture/ui';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  const publicEnv = process.env.NEXT_PUBLIC_APP_ENV ?? 'missing';
  const apiUrl = process.env.FIXTURE_API_URL ?? 'missing';
  const hasSecret = Boolean(process.env.FIXTURE_SERVER_SECRET);
  const appLocal = process.env.APP_LOCAL_ENV_MARKER ?? 'missing';
  const devOverride = process.env.FIXTURE_DEV_OVERRIDE ?? 'missing';

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Environment Verification</h1>
      <Card title="Resolved Environment Variables">
        <dl className="mt-3 space-y-1 font-mono text-xs text-zinc-300">
          <div>{\`NEXT_PUBLIC_APP_ENV=\${publicEnv}\`}</div>
          <div>{\`FIXTURE_API_URL=\${apiUrl}\`}</div>
          <div>{\`FIXTURE_SERVER_SECRET_SET=\${String(hasSecret)}\`}</div>
          <div>{\`APP_LOCAL_ENV_MARKER=\${appLocal}\`}</div>
          <div>{\`FIXTURE_DEV_OVERRIDE=\${devOverride}\`}</div>
        </dl>
      </Card>
    </div>
  );
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/src/app/api/health/route.ts',
    `import { NextResponse } from 'next/server';
import { UI_SENTINEL } from '@fixture/ui';
import { SHARED_MARKER } from '@fixture/shared';
import { APP_MARKER } from '@/lib/marker';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    cwd: process.cwd(),
    uiSentinel: UI_SENTINEL,
    sharedMarker: SHARED_MARKER,
    appMarker: APP_MARKER,
    env: {
      publicEnv: process.env.NEXT_PUBLIC_APP_ENV ?? null,
      serverApiUrl: process.env.FIXTURE_API_URL ?? null,
      hasServerSecret: Boolean(process.env.FIXTURE_SERVER_SECRET),
      appLocalMarker: process.env.APP_LOCAL_ENV_MARKER ?? null,
      devLocalOverride: process.env.FIXTURE_DEV_OVERRIDE ?? null,
    },
  });
}
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/src/app/api/titles/route.ts',
    `import { NextResponse } from 'next/server';
import { CATALOG_TITLES } from '@fixture/shared';

export async function GET() {
  return NextResponse.json({ count: CATALOG_TITLES.length, titles: CATALOG_TITLES });
}
`,
  );

  // Tracked .env defaults and example template (root + app-level)
  await writeTextFile(
    fixtureDir,
    '.env',
    `NEXT_PUBLIC_APP_ENV=fixture-default
ROOT_MONOREPO_DEFAULT=root-default
`,
  );

  await writeTextFile(
    fixtureDir,
    '.env.example',
    `NEXT_PUBLIC_APP_ENV=
FIXTURE_API_URL=
FIXTURE_SERVER_SECRET=
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/.env',
    `NEXT_PUBLIC_APP_ENV=fixture-default
FIXTURE_API_URL=http://127.0.0.1:9999/default
`,
  );

  await writeTextFile(
    fixtureDir,
    'apps/web/.env.example',
    `NEXT_PUBLIC_APP_ENV=
FIXTURE_API_URL=
FIXTURE_SERVER_SECRET=
`,
  );

  // Untracked/gitignored .env*.local files (must be copied by safe env copier)
  await writeTextFile(
    fixtureDir,
    '.env.local',
    `ROOT_MONOREPO_SECRET=root-local-secret-value
`,
  );
  await fs.chmod(path.join(fixtureDir, '.env.local'), 0o600);

  await writeTextFile(
    fixtureDir,
    'apps/web/.env.local',
    `FIXTURE_SERVER_SECRET=s5-simulated-secret-token-value
FIXTURE_API_URL=http://127.0.0.1:9999/local-override
APP_LOCAL_ENV_MARKER=web-app-local-loaded
`,
  );
  await fs.chmod(path.join(fixtureDir, 'apps/web/.env.local'), 0o600);

  await writeTextFile(
    fixtureDir,
    'apps/web/.env.development.local',
    `FIXTURE_DEV_OVERRIDE=dev-local-active
`,
  );
  await fs.chmod(path.join(fixtureDir, 'apps/web/.env.development.local'), 0o600);

  // Initialize git repo and install dependencies once to generate realistic pnpm-lock.yaml + warm store
  await runCommand('git', ['init', '-b', 'main', '--quiet'], { cwd: fixtureDir });
  await runCommand('git', ['config', 'user.email', 's5-benchmark@codecanvas.local'], {
    cwd: fixtureDir,
  });
  await runCommand('git', ['config', 'user.name', 'S5 Benchmark'], { cwd: fixtureDir });
  await runCommand('git', ['config', 'commit.gpgsign', 'false'], { cwd: fixtureDir });

  // First install to generate pnpm-lock.yaml and warm the global pnpm store
  const coldInstallRes = await runCommand('pnpm', ['install', '--no-frozen-lockfile'], {
    cwd: fixtureDir,
    timeoutMs: 300_000,
  });

  await runCommand('git', ['add', '-A'], { cwd: fixtureDir });
  await runCommand('git', ['commit', '-m', 'Initial Reelhouse Next.js App Router monorepo fixture', '--quiet'], {
    cwd: fixtureDir,
  });

  // Add realistic git history (20 commits with incompressible deterministic payloads so
  // .git/objects/pack is ~4 MB, reflecting a non-trivial real repository history)
  let seed = 0x5f3759df;
  const nextRand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 1; i <= 20; i += 1) {
    const words = new Uint32Array(48_000);
    for (let j = 0; j < words.length; j += 1) {
      words[j] = nextRand();
    }
    const payloadPath = path.join(fixtureDir, `docs/history/snapshot-${String(i).padStart(2, '0')}.bin`);
    await fs.mkdir(path.dirname(payloadPath), { recursive: true });
    await fs.writeFile(payloadPath, Buffer.from(words.buffer));
    await runCommand('git', ['add', 'docs/history'], { cwd: fixtureDir });
    await runCommand('git', ['commit', '-m', `docs: add sprint ${i} historical snapshot`, '--quiet'], {
      cwd: fixtureDir,
    });
  }
  // Archive bulky historical blobs out of HEAD working tree (objects remain in .git packfile)
  await fs.rm(path.join(fixtureDir, 'docs/history'), { recursive: true, force: true });
  await runCommand('git', ['add', '-A'], { cwd: fixtureDir });
  await runCommand('git', ['commit', '-m', 'chore: archive historical snapshots', '--quiet'], {
    cwd: fixtureDir,
  });
  await runCommand('git', ['gc', '--quiet'], { cwd: fixtureDir });

  // Count locked packages from pnpm-lock.yaml for fixture metadata
  const lockfileText = await fs.readFile(path.join(fixtureDir, 'pnpm-lock.yaml'), 'utf8');
  const lockfileLines = lockfileText.split('\n').length;
  const packagesMatches = lockfileText.match(/^\s{2}['"]?[^:\s][^:]*@[^:\s]+:/gm) ?? [];

  return {
    fixtureSetupMs: performance.now() - startedAt,
    coldInstallMs: coldInstallRes.elapsedMs,
    lockfileLines,
    approxPackageCount: packagesMatches.length,
  };
}
