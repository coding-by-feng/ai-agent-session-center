import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from '@/App';
import { useQueueStore } from '@/stores/queueStore';
import { useQueueHistoryStore } from '@/stores/queueHistoryStore';
import { usePromptSnippetStore } from '@/stores/promptSnippetStore';
import { installClientIdentityHeaders } from '@/lib/presenceClient';
import '@/styles/global.css';
import '@/styles/themes/cyberpunk.css';
import '@/styles/themes/dracula.css';
import '@/styles/themes/solarized.css';
import '@/styles/themes/nord.css';
import '@/styles/themes/monokai.css';
import '@/styles/themes/light.css';
import '@/styles/themes/warm.css';
import '@/styles/themes/blonde.css';
import '@/styles/themes/windows-xp.css';
import '@/styles/themes/light-overrides.css';

// Identify this device on every same-origin request. Must run BEFORE any
// module issues a fetch: the server decides who may run the (destructive)
// workspace restore and who holds each session's write baton from these
// headers, and an unstamped request reads as an anonymous device.
installClientIdentityHeaders();

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
    // Snippets have no re-key ordering requirement (they're global, not keyed
    // by sessionId), but hydrating here keeps every Dexie read on one await so
    // the picker never opens against an empty library on a cold start.
    usePromptSnippetStore.getState().loadFromDb(),
  ]);
  // Reconcile with the SERVER's shared queue after the local IndexedDB load,
  // never before: syncFromServer seeds any session the server hasn't heard of
  // from local state, so it has to see the hydrated local queues to know what
  // to seed. Deliberately NOT awaited — a slow or unreachable server must not
  // hold up first paint, and the local copy renders correctly on its own until
  // the sync lands.
  void useQueueStore.getState().syncFromServer();
  createRoot(root!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// The four render targets below are mutually exclusive — a window is either the
// dashboard, a popped-out terminal, a popped-out project browser, or a popped-
// out whole session. The popout views are imported lazily, inside their own
// branch, so the DASHBOARD never loads them: PopoutProjectView (and, through
// DetailPanel, PopoutSessionView) reaches ProjectTab, which drags in xlsx,
// react-arborist, highlight.js, DOMPurify and the react-markdown stack. That
// static import was the single biggest reason the entry chunk sat at 2.5 MB.
const popoutParams = new URLSearchParams(window.location.search);
const popoutKind = popoutParams.get('popout');
if (popoutKind === 'terminal') {
  // This window is a popped-out terminal (main / commands / fork) — render just
  // that terminal, not the whole dashboard.
  const PopoutTerminalView = lazy(() => import('@/components/session/PopoutTerminalView'));
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <Suspense fallback={null}>
          <PopoutTerminalView
            terminalId={popoutParams.get('terminalId') || ''}
            originSessionId={popoutParams.get('originSessionId') || undefined}
            label={popoutParams.get('label') || undefined}
          />
        </Suspense>
      </BrowserRouter>
    </StrictMode>,
  );
} else if (popoutKind === 'project') {
  // Popped-out PROJECT tab — render just the file browser, not the whole app.
  const PopoutProjectView = lazy(() => import('@/components/session/PopoutProjectView'));
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <Suspense fallback={null}>
          <PopoutProjectView />
        </Suspense>
      </BrowserRouter>
    </StrictMode>,
  );
} else if (popoutKind === 'session') {
  // Popped-out whole SESSION — render DetailPanel standalone (every tab), not
  // the whole dashboard. Queue automation for THIS session still needs the
  // hydrated queue stores (the same reason `bootstrap()` awaits them below), so
  // this branch awaits the same load before rendering rather than skipping it.
  void (async () => {
    await Promise.all([
      useQueueStore.getState().loadFromDb(),
      useQueueHistoryStore.getState().loadFromDb(),
      usePromptSnippetStore.getState().loadFromDb(),
    ]);
    const PopoutSessionView = lazy(() => import('@/components/session/PopoutSessionView'));
    createRoot(root!).render(
      <StrictMode>
        <BrowserRouter>
          <Suspense fallback={null}>
            <PopoutSessionView />
          </Suspense>
        </BrowserRouter>
      </StrictMode>,
    );
  })();
} else {
  void bootstrap();
}
