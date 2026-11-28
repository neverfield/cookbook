import React from 'react';
import { NavLink } from 'react-router-dom';
import styles from './ShellLayout.module.css';
import { joinClasses } from '../utils/classNames.js';

const NAV_ITEMS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/releases', label: 'Releases', end: false },
  { to: '/settings', label: 'Settings', end: true },
];

export function ShellLayout({ compact = false, children }) {
  return (
    <div className={joinClasses('app-shell', styles.shell, compact && 'density-compact')}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <p className={styles.brandName}>Release Studio</p>
          <p className={styles.brandTag}>Vite + React 18 Classic JSX</p>
        </div>
        <nav className={styles.nav} aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                joinClasses('sidebar-link', styles.navLink, isActive && styles.navLinkActive)
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
