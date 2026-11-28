import React from 'react';
import styles from './StatusBadge.module.css';
import { RELEASE_STATUS_META, joinClasses } from '../utils/classNames.js';

const TONE_CLASS = {
  success: styles.success,
  warning: styles.warning,
  danger: styles.danger,
};

export const StatusBadge = React.memo(function StatusBadge({
  status = 'ready',
  compact = false,
  className = '',
}) {
  const meta = RELEASE_STATUS_META[status] || RELEASE_STATUS_META.ready;
  const badgeClass = joinClasses(
    styles.badge,
    TONE_CLASS[meta.tone],
    { [styles.compact]: compact },
    className
  );

  return (
    <span className={badgeClass} data-status={status}>
      <span className={styles.dot} aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
});
