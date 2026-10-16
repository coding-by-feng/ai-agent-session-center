/**
 * InfoPageScreen — what a session's Info opens (AASC-46): Notes, Queue, Agents,
 * AI popups, each a pushed screen with today's working phone piece inside. (Files
 * is the session's Project tab since AASC-56: Info goes back to it.)
 *
 *   Notes      NotesTab: notes, photos from the camera, delete confirms
 *   Queue      QueueTab: this session's queue, compose, chains, loops, history
 *   Agents     AgentsTab: the subagent diagram and log, a subagent's transcript
 *   AI popups  AiPopupHistory: past popups, Open on a running one
 *
 * Each loads on first use (lazy), as in the classic panel.
 */
import { lazy, Suspense, type ReactNode } from 'react';
import { Button, EmptyState, Screen } from '../../kit';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import type { InfoPage } from '@/lib/chat/phoneRoutes';
import styles from '@/styles/modules/mobile/SessionInfo.module.css';

const NotesTab = lazy(() => import('@/components/session/NotesTab'));
const QueueTab = lazy(() => import('@/components/session/QueueTab'));
const AgentsTab = lazy(() => import('@/components/session/AgentsTab'));
const AiPopupHistory = lazy(() => import('@/components/session/AiPopupHistory'));

const TITLES: Record<InfoPage, string> = {
  notes: 'Notes',
  queue: 'Queue',
  agents: 'Agents',
  popups: 'AI popups',
};

function Loading() {
  return <EmptyState live title="Loading…" />;
}

export default function InfoPageScreen({ sessionId, page }: { sessionId: string; page: InfoPage }) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const snapshotReceived = useWsStore((s) => s.snapshotReceived);
  const pop = usePhoneNavStore((s) => s.pop);
  const title = TITLES[page];

  if (!session) {
    return (
      <Screen title={title} onBack={pop} backLabel="Back to Info" testId={`phone-info-${page}-missing`}>
        <EmptyState
          live={!snapshotReceived}
          title={snapshotReceived ? 'This session isn’t here' : 'Loading…'}
          message={snapshotReceived ? 'It ended, or it isn’t shared with this phone.' : undefined}
          action={snapshotReceived ? <Button onClick={pop}>Back</Button> : undefined}
        />
      </Screen>
    );
  }

  let body: ReactNode;
  if (page === 'notes') {
    body = <div className={styles.tab}><NotesTab sessionId={sessionId} projectPath={session.projectPath} /></div>;
  } else if (page === 'queue') {
    body = (
      <div className={styles.tab}>
        <QueueTab sessionId={sessionId} sessionStatus={session.status} terminalId={session.terminalId} fullHeight />
      </div>
    );
  } else if (page === 'agents') {
    body = <div className={styles.tab}><AgentsTab sessionId={sessionId} /></div>;
  } else {
    body = <div className={styles.tab}><AiPopupHistory sessionId={sessionId} projectPath={session.projectPath} /></div>;
  }

  return (
    <Screen
      title={title}
      subtitle={sessionDisplayTitle(session)}
      onBack={pop}
      backLabel="Back to Info"
      testId={`phone-info-${page}`}
    >
      <Suspense fallback={<Loading />}>{body}</Suspense>
    </Screen>
  );
}
