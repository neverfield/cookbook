'use client';

import { useState } from 'react';
import Link from 'next/link';
import { css } from '@emotion/react';
import { Box, Button, Stack, Typography } from '@mui/material';
import type { CatalogItem } from '@/data/catalog';
import {
  EmotionCssCallout,
  StyledObjectSurface,
  StyledStatusPill,
} from '@/components/EmotionPrimitives';
import { MuiSurfaceCard, MuiSxShowcaseCard } from '@/components/MuiStyledPrimitives';

export function CatalogBrowser({ items }: { items: CatalogItem[] }) {
  const [category, setCategory] = useState<'all' | CatalogItem['category']>('all');

  const visibleItems =
    category === 'all' ? items : items.filter((item) => item.category === category);

  return (
    <Stack spacing={3}>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        {(['all', 'surface', 'input', 'feedback'] as const).map((cat) => (
          <Button
            key={cat}
            size="small"
            variant={category === cat ? 'contained' : 'outlined'}
            onClick={() => setCategory(cat)}
            sx={{ textTransform: 'capitalize' }}
          >
            {cat}
          </Button>
        ))}
      </Box>

      <div
        css={css`
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
          @media (max-width: 768px) {
            grid-template-columns: 1fr;
          }
        `}
      >
        {visibleItems.map((item) => (
          <MuiSurfaceCard key={item.id}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="h6" sx={{ fontSize: 17, fontWeight: 700 }}>
                {item.name}
              </Typography>
              <StyledStatusPill active={item.status === 'stable'}>{item.status}</StyledStatusPill>
            </Box>
            <Typography variant="body2" color="text.secondary">
              {item.summary}
            </Typography>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span css={{ fontSize: 12, color: '#4b5563' }}>
                {item.owner} · {item.emotionPattern}
              </span>
              <Link
                href={`/catalog/${item.id}`}
                css={{ fontSize: 13, fontWeight: 600, color: '#1f4fd8', textDecoration: 'none' }}
              >
                Inspect component
              </Link>
            </Box>
          </MuiSurfaceCard>
        ))}
      </div>

      <StyledObjectSurface>
        <EmotionCssCallout title="Read-only sx testing target" highlighted={category !== 'all'}>
          The card below applies styling via MUI sx props, which codecanvas v2 reports as read-only
          while allowing edits to Emotion styled, css prop, and MUI styled origins.
        </EmotionCssCallout>
        <Box sx={{ mt: 2 }}>
          <MuiSxShowcaseCard
            heading="MUI sx surface"
            caption="Styled exclusively via sx prop objects and theme callback"
            badgeLabel="sx read-only"
          />
        </Box>
      </StyledObjectSurface>
    </Stack>
  );
}
