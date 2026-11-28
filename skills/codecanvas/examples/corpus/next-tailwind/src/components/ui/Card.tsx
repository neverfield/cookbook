import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({
  elevated = false,
  interactive = false,
  className,
  children,
}: {
  elevated?: boolean;
  interactive?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'rounded-[var(--radius-card)] border border-line bg-card p-5',
        elevated ? 'shadow-md' : 'shadow-xs',
        interactive && 'transition-colors hover:border-brand/50',
        className
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-3', className)}>
      <div>
        <h2 className="text-base font-bold text-ink">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p> : null}
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
