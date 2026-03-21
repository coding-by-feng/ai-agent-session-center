import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/App';
import { useQueueStore } from '@/stores/queueStore';
import '@/styles/global.css';
import '@/styles/themes/cyberpunk.css';
import '@/styles/themes/dracula.css';
import '@/styles/themes/solarized.css';
import '@/styles/themes/nord.css';
import '@/styles/themes/monokai.css';
import '@/styles/themes/light.css';
import '@/styles/themes/warm.css';
import '@/styles/themes/blonde.css';
import '@/styles/themes/light-overrides.css';

// Block Cmd+R / Ctrl+R / F5 to prevent accidental page reload
// (losing all terminal sessions and in-memory state)
window.addEventListener('keydown', (e) => {
  if (
    (e.key === 'r' && (e.metaKey || e.ctrlKey)) ||
    e.key === 'F5'
  ) {
    e.preventDefault();
  }
});

// Load persisted queue items from IndexedDB before rendering
useQueueStore.getState().loadFromDb();

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
