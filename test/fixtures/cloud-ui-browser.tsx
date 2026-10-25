/** Task12 isolated themed production UI. Fixture owns the notes lifecycle; no app startup. */
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router';
import ResourcesView from '../../src/routes/ResourcesView';
import { startNotesSync } from '../../src/stores/skillNotesStore';
import '../../src/styles/global.css';
function Fixture() {
  useEffect(() => startNotesSync(), []);
  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <p style={{ padding: '8px', margin: 0, fontSize: 12 }}>
        Cloud acceptance fixture · synthetic API · no local files or Git modified
      </p>
      <div style={{ flex: 1, minHeight: 0, display: 'block' }}>
        <Routes>
          <Route path="/resources" element={<ResourcesView />} />
          <Route path="/project-browser" element={<p>Fixture checkout opened</p>} />
        </Routes>
      </div>
    </div>
  );
}
// `?theme=` picks the theme (empty = command-center, the default with no attribute).
const theme = new URLSearchParams(location.search).get('theme') ?? 'windows-xp';
if (theme) document.body.dataset.theme = theme;
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Fixture />
  </BrowserRouter>,
);
