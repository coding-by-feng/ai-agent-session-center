import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from '@/App';
import PopoutTerminalView from '@/components/session/PopoutTerminalView';
import { useQueueStore } from '@/stores/queueStore';
import { useQueueHistoryStore } from '@/stores/queueHistoryStore';
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

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

// Hydrate persisted queue items from IndexedDB BEFORE rendering <App>.
// <App> mounts the WebSocket; a `session_update` carrying `replacesId`
// (a `claude --resume` re-key) calls queueStore.migrateSession() synchronously.
// If the queue map isn't hydrated yet, migrateSession sees an empty queue and
// no-ops, leaving the loop orphaned in IndexedDB under the OLD sessionId
// (invisible under the new session). Awaiting load first makes the ordering
// deterministic: load → render → WS connect → session_update. loadFromDb()
// swallows its own errors, so a failure still falls through to render.
async function bootstrap(): Promise<void> {
  await Promise.all([
    useQueueStore.getState().loadFromDb(),
    useQueueHistoryStore.getState().loadFromDb(),
  ]);
  createRoot(root!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

const popoutParams = new URLSearchParams(window.location.search);
if (popoutParams.get('popout') === 'terminal') {
  // This window is a popped-out floating terminal — render just that terminal,
  // not the whole dashboard.
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <PopoutTerminalView
          terminalId={popoutParams.get('terminalId') || ''}
          originSessionId={popoutParams.get('originSessionId') || undefined}
          label={popoutParams.get('label') || undefined}
        />
      </BrowserRouter>
    </StrictMode>,
  );
} else {
  void bootstrap();
}
