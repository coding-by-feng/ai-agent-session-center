import { lazy, Suspense, useState, useEffect, useCallback } from 'react';
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
import QuickSessionModal from '@/components/modals/QuickSessionModal';
import ShortcutsPanel from '@/components/modals/ShortcutsPanel';
import ShortcutSettingsModal from '@/components/modals/ShortcutSettingsModal';
import GlobalSearchModal from '@/components/modals/GlobalSearchModal';
import DetailPanel from '@/components/session/DetailPanel';
import FloatingTerminalRoot from '@/components/session/FloatingTerminalRoot';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useSettingsInit } from '@/hooks/useSettingsInit';
import { useWorkspaceAutoSave } from '@/hooks/useWorkspaceAutoSave';
import { useWorkspaceAutoLoad } from '@/hooks/useWorkspaceAutoLoad';
import LiveView from '@/routes/LiveView';
import TitleBar from '@/components/layout/TitleBar';
import SavingOverlay from '@/components/ui/SavingOverlay';
import WorkspaceLoadingOverlay from '@/components/ui/WorkspaceLoadingOverlay';

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
      <QuickSessionModal />
      <ShortcutsPanel />
      <ShortcutSettingsModal />
      <GlobalSearchModal />
      <DetailPanel />
      <FloatingTerminalRoot />
    </div>
  );
}

function Dashboard({ token }: { token: string | null }) {
  useSettingsInit();
  useWebSocket(token);
  useWorkspaceAutoSave();
  useWorkspaceAutoLoad();

  const [saving, setSaving] = useState(false);

  // Listen for Electron's before-close signal to flush workspace save
  const handleBeforeClose = useCallback(async () => {
    setSaving(true);
    const { flushSave } = await import('@/lib/workspaceSnapshot');
    const { useSessionStore } = await import('@/stores/sessionStore');
    const { useRoomStore } = await import('@/stores/roomStore');
    await flushSave(
      () => useSessionStore.getState().sessions,
      () => useRoomStore.getState().rooms,
    );
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onBeforeClose) return;
    return window.electronAPI.onBeforeClose(handleBeforeClose);
  }, [handleBeforeClose]);

  return (
    <>
      {saving && <SavingOverlay />}
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
  return <Dashboard token={null} />;
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
