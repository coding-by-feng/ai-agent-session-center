import { lazy, Suspense, useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { useWebSocket } from '@/hooks/useWebSocket';
import LoginScreen from '@/components/auth/LoginScreen';
import SetupWizard from '@/components/setup/SetupWizard';
import Header from '@/components/layout/Header';
import NavBar from '@/components/layout/NavBar';
import ActivityFeed from '@/components/layout/ActivityFeed';
import ToastContainer from '@/components/ui/ToastContainer';
import SettingsPanel from '@/components/settings/SettingsPanel';
import NewSessionModal from '@/components/modals/NewSessionModal';
import QuickSessionModal from '@/components/modals/QuickSessionModal';
import ShortcutsPanel from '@/components/modals/ShortcutsPanel';
import DetailPanel from '@/components/session/DetailPanel';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useSettingsInit } from '@/hooks/useSettingsInit';
import LiveView from '@/routes/LiveView';

// Lazy-load non-default routes for code splitting
const HistoryView = lazy(() => import('@/routes/HistoryView'));
const TimelineView = lazy(() => import('@/routes/TimelineView'));
const AnalyticsView = lazy(() => import('@/routes/AnalyticsView'));
const QueueView = lazy(() => import('@/routes/QueueView'));
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
      <DetailPanel />
    </div>
  );
}

function Dashboard({ token }: { token: string | null }) {
  useSettingsInit();
  useWebSocket(token);

  return (
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
          <Route path="/history" element={<HistoryView />} />
          <Route path="/timeline" element={<TimelineView />} />
          <Route path="/analytics" element={<AnalyticsView />} />
          <Route path="/queue" element={<QueueView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function AuthGate() {
  const { token, loading, needsLogin, login } = useAuth();

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          background: '#0a0a1a',
          color: '#8888aa',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        Connecting...
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a1a', color: '#8888aa', fontFamily: "'JetBrains Mono', monospace" }}>
        Loading...
      </div>
    );
  }

  if (isSetup === false) {
    return <SetupWizard />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate />
    </QueryClientProvider>
  );
}
