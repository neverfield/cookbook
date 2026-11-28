/** @jsxImportSource react */
import type { ReactNode } from 'react';

export function ServerCatalogHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section data-rsc-boundary="header" style={{ marginBottom: 24 }}>
      <p
        style={{
          margin: 0,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: '#4b5563',
        }}
      >
        {eyebrow}
      </p>
      <h1 style={{ margin: '6px 0 8px', fontSize: 28, lineHeight: 1.2 }}>{title}</h1>
      <p style={{ margin: 0, fontSize: 15, color: '#4b5563' }}>{description}</p>
      {children ? <div style={{ marginTop: 14 }}>{children}</div> : null}
    </section>
  );
}
