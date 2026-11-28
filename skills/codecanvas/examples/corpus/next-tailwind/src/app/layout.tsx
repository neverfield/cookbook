import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { SidebarNav } from '@/components/SidebarNav';

export const metadata: Metadata = {
  title: 'Next Tailwind — Seed Corpus',
  description: 'Next.js App Router + Tailwind CSS seed corpus app for codecanvas v2',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <div className="flex min-h-screen flex-col md:flex-row">
          <SidebarNav />
          <main className="mx-auto w-full max-w-5xl flex-1 p-6 md:p-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
