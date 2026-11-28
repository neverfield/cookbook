/** @jsxImportSource react */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ThemeRegistry } from '@/components/ThemeRegistry';
import { AppShell } from '@/components/AppShell';

export const metadata: Metadata = {
  title: 'Next MUI Emotion — Seed Corpus',
  description: 'Next.js App Router + MUI + Emotion seed corpus app for codecanvas v2',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ThemeRegistry>
          <AppShell>{children}</AppShell>
        </ThemeRegistry>
      </body>
    </html>
  );
}
