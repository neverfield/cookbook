import React, { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { ShellLayout } from './components/ShellLayout.jsx';
import { OverviewScreen } from './screens/OverviewScreen.jsx';
import { ReleasesScreen } from './screens/ReleasesScreen.jsx';
import { ReleaseDetailScreen } from './screens/ReleaseDetailScreen.jsx';
import { SettingsScreen } from './screens/SettingsScreen.jsx';

export function App() {
  const [compact, setCompact] = useState(false);

  return (
    <ShellLayout compact={compact}>
      <Routes>
        <Route path="/" element={<OverviewScreen />} />
        <Route path="/releases" element={<ReleasesScreen />} />
        <Route path="/releases/:id" element={<ReleaseDetailScreen />} />
        <Route
          path="/settings"
          element={<SettingsScreen compact={compact} onToggleCompact={setCompact} />}
        />
      </Routes>
    </ShellLayout>
  );
}
