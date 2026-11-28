'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Box, Button, Stack, Typography } from '@mui/material';
import type { CatalogItem } from '@/data/catalog';
import {
  EmotionCssCallout,
  StyledHeroBanner,
  StyledStatusPill,
} from '@/components/EmotionPrimitives';
import { MuiMetricTile, MuiSxShowcaseCard } from '@/components/MuiStyledPrimitives';

export function ItemInspector({ item }: { item: CatalogItem }) {
  const [highlighted, setHighlighted] = useState(false);

  return (
    <Stack spacing={3}>
      <StyledHeroBanner>
        <span css={{ fontSize: 12, opacity: 0.85, textTransform: 'uppercase' }}>
          Pattern: {item.emotionPattern}
        </span>
        <Typography variant="h5" sx={{ fontWeight: 700, color: '#ffffff' }}>
          {item.name}
        </Typography>
        <Typography variant="body2" sx={{ color: 'rgba(255,255,255,0.88)' }}>
          {item.summary}
        </Typography>
      </StyledHeroBanner>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
          gap: 2,
        }}
      >
        <MuiMetricTile>
          <span css={{ fontSize: 12, color: '#4b5563' }}>Owning team</span>
          <strong css={{ fontSize: 18 }}>{item.owner}</strong>
          <StyledStatusPill active={item.status === 'stable'}>{item.status}</StyledStatusPill>
        </MuiMetricTile>

        <MuiSxShowcaseCard
          heading="Interactive highlight"
          caption="Toggle the Emotion css prop conditional branch below"
          badgeLabel={highlighted ? 'accent' : 'default'}
          actionLabel={highlighted ? 'Reset highlight' : 'Highlight callout'}
          onAction={() => setHighlighted((prev) => !prev)}
        />
      </Box>

      <EmotionCssCallout title="Live css prop origin" highlighted={highlighted}>
        This callout mixes a base template-literal rule with a conditional object rule via the
        Emotion css prop.
      </EmotionCssCallout>

      <Box>
        <Button component={Link} href="/catalog" variant="outlined" size="small">
          Back to catalog
        </Button>
      </Box>
    </Stack>
  );
}
