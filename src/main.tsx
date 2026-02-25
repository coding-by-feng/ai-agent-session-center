import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/App';
import { useQueueStore } from '@/stores/queueStore';
import '@/styles/global.css';

// Load persisted queue items from IndexedDB before rendering
useQueueStore.getState().loadFromDb();

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
