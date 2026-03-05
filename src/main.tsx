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

// Apply macOS traffic-light clearance before React mounts (synchronous, before first paint)
if (window.electronAPI?.platform === 'darwin') {
  document.documentElement.classList.add('electron-mac');
}

// Load persisted queue items from IndexedDB before rendering
useQueueStore.getState().loadFromDb();

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
