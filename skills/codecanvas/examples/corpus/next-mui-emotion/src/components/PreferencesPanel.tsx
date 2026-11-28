'use client';

import { useState } from 'react';
import { Box, FormControlLabel, Stack, Switch, Typography } from '@mui/material';
import { EmotionCssCallout, StyledObjectSurface } from '@/components/EmotionPrimitives';
import { MuiSxShowcaseCard } from '@/components/MuiStyledPrimitives';

export function PreferencesPanel() {
  const [highContrast, setHighContrast] = useState(false);

  return (
    <Stack spacing={3}>
      <StyledObjectSurface>
        <Typography variant="h6" sx={{ fontSize: 17, fontWeight: 700, mb: 1 }}>
          Emotion &amp; MUI Inspector Rules
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={highContrast}
              onChange={(event) => setHighContrast(event.target.checked)}
            />
          }
          label="Emphasize Emotion css prop callout preview"
        />
        <Box sx={{ mt: 2 }}>
          <EmotionCssCallout title="Preview banner" highlighted={highContrast}>
            Toggle switches the conditional css prop branch without touching MUI sx rules.
          </EmotionCssCallout>
        </Box>
      </StyledObjectSurface>

      <MuiSxShowcaseCard
        heading="sx Read-Only Guardrail"
        caption="MUI sx props remain read-only in v2; MUI styled() rules remain directly editable."
        badgeLabel="v2 policy"
      />
    </Stack>
  );
}
