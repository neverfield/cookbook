'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { css } from '@emotion/react';
import { Box, Container, Stack } from '@mui/material';

const navLinkStyle = (active: boolean) => css`
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: ${active ? 600 : 500};
  text-decoration: none;
  color: ${active ? '#1f4fd8' : '#374151'};
  background-color: ${active ? '#e8efff' : 'transparent'};
  &:hover {
    background-color: #eef2fa;
  }
`;

const NAV_LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/catalog', label: 'Catalog' },
  { href: '/settings', label: 'Settings' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <header
        css={css`
          background-color: #ffffff;
          border-bottom: 1px solid #e5e7eb;
        `}
      >
        <Container maxWidth="lg">
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ py: 1.5 }}
          >
            <Link
              href="/"
              css={{
                fontWeight: 700,
                fontSize: 16,
                color: '#111827',
                textDecoration: 'none',
              }}
            >
              MUI + Emotion Corpus
            </Link>
            <nav aria-label="Primary" css={{ display: 'flex', gap: 6 }}>
              {NAV_LINKS.map((item) => {
                const active =
                  item.href === '/'
                    ? pathname === '/'
                    : pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Link key={item.href} href={item.href} css={navLinkStyle(active)}>
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </Stack>
        </Container>
      </header>
      <Container maxWidth="lg" sx={{ py: 4 }}>
        {children}
      </Container>
    </Box>
  );
}
