/** Real Resources UI and production notes lifecycle, without Dashboard sessions/PTY startup. */
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router';
import ResourcesView from '../../src/routes/ResourcesView';
import { startNotesSync, useSkillNotesStore } from '../../src/stores/skillNotesStore';
import '../../src/styles/global.css';
// Test entry only: lets tests await durable state and perform the same public store actions as UI.
Object.assign(window, { cloudAcceptanceNotes: useSkillNotesStore });
function Fixture() {
  useEffect(() => startNotesSync(), []);
  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <p style={{ margin: 0, padding: 8 }}>
        Isolated acceptance · real local cloud services · synthetic account
      </p>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Routes>
          <Route path="/resources" element={<ResourcesView />} />
          <Route path="/project-browser" element={<p>Fixture project-browser boundary</p>} />
        </Routes>
      </div>
    </div>
  );
}
document.body.dataset.theme = 'windows-xp';
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Fixture />
  </BrowserRouter>,
);
