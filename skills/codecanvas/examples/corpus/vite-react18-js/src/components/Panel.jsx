import React from 'react';
import styles from './Panel.module.css';

const BASE_BODY_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

export function Panel({
  title,
  subtitle,
  actions = null,
  elevated = false,
  className = '',
  bodyStyle = null,
  children,
}) {
  const panelClass = `${styles.panel} ${elevated ? styles.elevated : ''} ${className}`.trim();

  return (
    <section className={panelClass}>
      {title ? (
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>{title}</h2>
            {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
          </div>
          {actions ? <div>{actions}</div> : null}
        </header>
      ) : null}
      <div className={styles.body} style={bodyStyle ? { ...BASE_BODY_STYLE, ...bodyStyle } : BASE_BODY_STYLE}>
        {children}
      </div>
    </section>
  );
}
