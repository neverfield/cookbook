'use client';

import type { ReactNode } from 'react';
import { Box, Button, Chip, Paper, Typography } from '@mui/material';
import { styled as muiStyled } from '@mui/material/styles';

export const MuiSurfaceCard = muiStyled(Paper)(({ theme }) => ({
  padding: theme.spacing(2.5),
  border: `1px solid ${theme.palette.divider}`,
  borderRadius: theme.shape.borderRadius,
  boxShadow: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: theme.spacing(1.5),
}));

export const MuiMetricTile = muiStyled('div')(({ theme }) => ({
  padding: theme.spacing(2),
  borderRadius: theme.shape.borderRadius,
  backgroundColor: theme.palette.background.paper,
  border: `1px solid ${theme.palette.divider}`,
  display: 'flex',
  flexDirection: 'column',
  gap: theme.spacing(0.5),
}));

export function MuiSxShowcaseCard({
  heading,
  caption,
  badgeLabel,
  actionLabel,
  onAction,
  children,
}: {
  heading: string;
  caption: string;
  badgeLabel: string;
  actionLabel?: string;
  onAction?: () => void;
  children?: ReactNode;
}) {
  return (
    <Box
      sx={{
        p: 2.5,
        borderRadius: 2,
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <div>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {heading}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {caption}
          </Typography>
        </div>
        <Chip
          label={badgeLabel}
          size="small"
          sx={(theme) => ({
            fontWeight: 600,
            bgcolor: theme.palette.action.selected,
          })}
        />
      </Box>
      {children}
      {actionLabel ? (
        <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
          <Button
            variant="contained"
            size="small"
            onClick={onAction}
            sx={{ textTransform: 'none', fontWeight: 600, px: 2 }}
          >
            {actionLabel}
          </Button>
        </Box>
      ) : null}
    </Box>
  );
}
