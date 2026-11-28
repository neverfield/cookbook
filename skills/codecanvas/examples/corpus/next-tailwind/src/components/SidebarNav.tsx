'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/projects', label: 'Projects' },
  { href: '/settings', label: 'Settings' },
];

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <aside className="w-full border-b border-line bg-card p-5 md:w-60 md:shrink-0 md:border-r md:border-b-0">
      <div className="mb-5">
        <p className="text-sm font-bold text-ink">Token Workspace</p>
        <p className="text-xs text-ink-muted">Next.js + Tailwind CSS v4</p>
      </div>
      <nav aria-label="Workspace navigation" className="flex gap-1.5 md:flex-col">
        {LINKS.map((item) => {
          const isActive =
            item.href === '/'
              ? pathname === '/'
              : pathname === item.href || pathname.startsWith(`${item.href}/`);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-brand-soft font-semibold text-brand'
                  : 'text-ink-muted hover:bg-subtle hover:text-ink'
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
