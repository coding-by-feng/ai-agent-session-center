import { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
import SetupWizard from '@/components/setup/SetupWizard';
import Header from '@/components/layout/Header';
import NavBar from '@/components/layout/NavBar';
import ActivityFeed from '@/components/layout/ActivityFeed';
import ToastContainer from '@/components/ui/ToastContainer';
import SettingsPanel from '@/components/settings/SettingsPanel';
import NewSessionModal from '@/components/modals/NewSessionModal';
import ShortcutsPanel from '@/components/modals/ShortcutsPanel';
import ShortcutSettingsModal from '@/components/modals/ShortcutSettingsModal';
import GlobalSearchModal from '@/components/modals/GlobalSearchModal';
import DetailPanel from '@/components/session/DetailPanel';
import FloatingTerminalRoot from '@/components/session/FloatingTerminalRoot';
import FileOpenChooser from '@/components/session/FileOpenChooser';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useAuth } from '@/hooks/useAuth';
import LoginScreen from '@/components/auth/LoginScreen';
import { useSettingsInit } from '@/hooks/useSettingsInit';
import { useWorkspaceAutoSave } from '@/hooks/useWorkspaceAutoSave';
import { useWorkspaceAutoLoad } from '@/hooks/useWorkspaceAutoLoad';
import { useGlobalQueueScheduler } from '@/hooks/useGlobalQueueScheduler';
import LiveView from '@/routes/LiveView';
import TitleBar from '@/components/layout/TitleBar';
import SavingOverlay from '@/components/ui/SavingOverlay';
import WorkspaceLoadingOverlay from '@/components/ui/WorkspaceLoadingOverlay';
import RestorePickerModal from '@/components/modals/RestorePickerModal';

// Lazy-load non-default routes for code splitting
const HistoryView = lazy(() => import('@/routes/HistoryView'));
const QueueView = lazy(() => import('@/routes/QueueView'));
const AgendaView = lazy(() => import('@/routes/AgendaView'));
const ReviewView = lazy(() => import('@/routes/ReviewView'));
const ProjectBrowserView = lazy(() => import('@/routes/ProjectBrowserView'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

function AppLayout() {
  useKeyboardShortcuts();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header />
      <NavBar />
      <main style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        <Suspense fallback={<div style={{ padding: '2rem', color: '#8888aa', textAlign: 'center' }}>Loading...</div>}>
          <Outlet />
        </Suspense>
      </main>
      <ActivityFeed />
      <ToastContainer />
      <SettingsPanel />
      <NewSessionModal />
      <ShortcutsPanel />
      <ShortcutSettingsModal />
      <GlobalSearchModal />
      <DetailPanel />
      <FloatingTerminalRoot />
      <FileOpenChooser />
    </div>
  );
}

function Dashboard({ token }: { token: string | null }) {
  useSettingsInit();
  useWebSocket(token);
  useWorkspaceAutoSave();
  useWorkspaceAutoLoad();
  useGlobalQueueScheduler();

  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState(0);
  const creepRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Listen for Electron's before-close signal to flush workspace save
  const handleBeforeClose = useCallback(async () => {
    setSaving(true);
    setSaveProgress(8);

    // Slow "creep" toward 90% so the bar always reads as in-progress while the
    // save runs. The real completion below snaps it to 100%.
    if (creepRef.current) clearInterval(creepRef.current);
    creepRef.current = setInterval(() => {
      setSaveProgress((p) => (p < 90 ? p + Math.max(1, (90 - p) * 0.12) : p));
    }, 120);

    try {
      const { flushSave } = await import('@/lib/workspaceSnapshot');
      const { useSessionStore } = await import('@/stores/sessionStore');
      const { useRoomStore } = await import('@/stores/roomStore');
      await flushSave(
        () => useSessionStore.getState().sessions,
        () => useRoomStore.getState().rooms,
      );
    } finally {
      if (creepRef.current) {
        clearInterval(creepRef.current);
        creepRef.current = null;
      }
      setSaveProgress(100);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (creepRef.current) clearInterval(creepRef.current);
    };
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onBeforeClose) return;
    return window.electronAPI.onBeforeClose(handleBeforeClose);
  }, [handleBeforeClose]);

  return (
    <>
      {saving && (
        <SavingOverlay
          progress={saveProgress}
          label="Quitting"
          detail={saveProgress >= 100 ? 'Saved — closing…' : 'Saving workspace & config…'}
        />
      )}
      <RestorePickerModal />
      <WorkspaceLoadingOverlay />
      <BrowserRouter>
        <Routes>
          {/* Standalone route — no AppLayout chrome */}
          <Route path="/project-browser" element={
            <Suspense fallback={<div style={{ padding: '2rem', color: '#8888aa', background: '#0a0a1a', height: '100vh' }}>Loading...</div>}>
              <ProjectBrowserView />
            </Suspense>
          } />
          <Route element={<AppLayout />}>
            <Route path="/" element={<LiveView />} />
            <Route path="/agenda" element={<AgendaView />} />
            <Route path="/history" element={<HistoryView />} />
            <Route path="/queue" element={<QueueView />} />
            <Route path="/review" element={<ReviewView />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </>
  );
}

function AuthGate() {
  // Wire the real auth flow. The previous stub always rendered the Dashboard
  // with token=null, so on a password-protected server the WS handshake was
  // closed with 4001, the client gave up reconnecting, and the app bricked with
  // no login UI and no workspace restore. useAuth probes /api/auth/status,
  // listens for the `ws-auth-failed` event wsClient fires on 4001, and flips
  // `needsLogin` so a fresh login can re-establish the session. When no password
  // is configured (the default), `needsLogin` stays false and this behaves
  // exactly like before (Dashboard with a null/absent token).
  const { token, loading, needsLogin, login } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a1a', color: '#8888aa', fontFamily: "'JetBrains Mono', monospace" }}>
        Connecting…
      </div>
    );
  }

  if (needsLogin) {
    return <LoginScreen onLogin={login} />;
  }

  return <Dashboard token={token} />;
}

export default function App() {
  const [isSetup, setIsSetup] = useState<boolean | null>(null);

  useEffect(() => {
    if (!window.electronAPI) {
      // Web mode: skip setup gate entirely
      setIsSetup(true);
      return;
    }
    window.electronAPI.isSetup().then(setIsSetup);
  }, []);

  if (isSetup === null) {
    return (
      <>
        <TitleBar />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a1a', color: '#8888aa', fontFamily: "'JetBrains Mono', monospace" }}>
          Loading...
        </div>
      </>
    );
  }

  if (isSetup === false) {
    return (
      <>
        <TitleBar />
        <SetupWizard />
      </>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TitleBar />
      <AuthGate />
    </QueryClientProvider>
  );
}
