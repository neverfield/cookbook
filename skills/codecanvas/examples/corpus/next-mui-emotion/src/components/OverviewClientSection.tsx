'use client';

import Link from 'next/link';
import { Box, Button, Stack, Typography } from '@mui/material';
import type { CatalogItem } from '@/data/catalog';
import {
  EmotionCssCallout,
  StyledHeroBanner,
  StyledStatusPill,
} from '@/components/EmotionPrimitives';
import { MuiMetricTile, MuiSxShowcaseCard } from '@/components/MuiStyledPrimitives';

export function OverviewClientSection({ items }: { items: CatalogItem[] }) {
  return (
    <Stack spacing={3}>
      <StyledHeroBanner>
        <span css={{ fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Emotion Styled + MUI v7 + App Router
        </span>
        <Typography variant="h4" sx={{ fontWeight: 700, color: '#ffffff' }}>
          Component System Overview
        </Typography>
        <Typography variant="body1" sx={{ color: 'rgba(255,255,255,0.9)', maxWidth: 640 }}>
          Exercises @emotion/styled, @emotion/react css prop, MUI styled(), read-only MUI sx props,
          and React Server Component boundaries.
        </Typography>
        <Box sx={{ pt: 1, display: 'flex', gap: 1.5 }}>
          <Button
            component={Link}
            href="/catalog"
            variant="contained"
            sx={{ bgcolor: '#ffffff', color: '#1b3f9c', '&:hover': { bgcolor: '#eef2ff' } }}
          >
            Browse catalog
          </Button>
          <Button
            component={Link}
            href="/settings"
            variant="outlined"
            sx={{ borderColor: 'rgba(255,255,255,0.6)', color: '#ffffff' }}
          >
            Inspector settings
          </Button>
        </Box>
      </StyledHeroBanner>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' },
          gap: 2,
        }}
      >
        <MuiMetricTile>
          <span css={{ fontSize: 12, color: '#4b5563' }}>Catalog components</span>
          <strong css={{ fontSize: 26 }}>{items.length}</strong>
          <StyledStatusPill active>Tracked in RSC</StyledStatusPill>
        </MuiMetricTile>
        <MuiMetricTile>
          <span css={{ fontSize: 12, color: '#4b5563' }}>Editable CSS-in-JS</span>
          <strong css={{ fontSize: 26 }}>3 systems</strong>
          <StyledStatusPill active>Emotion + MUI styled</StyledStatusPill>
        </MuiMetricTile>
        <MuiMetricTile>
          <span css={{ fontSize: 12, color: '#4b5563' }}>Read-only probes</span>
          <strong css={{ fontSize: 26 }}>MUI sx</strong>
          <StyledStatusPill>Reported with reason</StyledStatusPill>
        </MuiMetricTile>
      </Box>

      <EmotionCssCallout title="Emotion css prop coverage">
        Client modules compile with jsxImportSource: &quot;@emotion/react&quot; while App Router
        pages stay React Server Components.
      </EmotionCssCallout>

      <MuiSxShowcaseCard
        heading="MUI sx prop read-only card"
        caption="Used to assert I3 read-only reporting on MUI sx objects and theme functions"
        badgeLabel="sx prop"
      />
    </Stack>
  );
}
