import React from 'react';
import styles from './MetricCard.module.css';
import { joinClasses } from '../utils/classNames.js';

export function MetricCard({ label, value, delta, tone = 'accent' }) {
  const toneClass = tone === 'success' ? styles.success : tone === 'warning' ? styles.warning : styles.accent;

  return (
    <article className={joinClasses(styles.card, toneClass)}>
      <div className={styles.topRow}>
        <span className="sr-caption">{label}</span>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.5 8.5L7.2 10.2L10.8 6.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
      <p className={styles.value}>{value}</p>
      <p className={styles.delta}>{delta}</p>
    </article>
  );
}
