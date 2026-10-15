/**
 * SessionScreen — one session (AASC-39 frame; the segments' real content comes
 * with AASC-41 Chat, AASC-44 Changes, AASC-45 Terminal, AASC-46 Info).
 *
 *   ‹      agent-manager-2       ⋯
 *      Working · Opus 5.5 · high
 *   2 more need you ›                     only while other sessions wait
 *   [ Chat │ Changes │ Terminal ]
 *   …the segment…
 *
 * The segment is part of the path (`/sessions/<id>/terminal`), switched in
 * place (replace), so a reload lands on it and back still returns to the list.
 * "N more need you ›" swaps in the next waiting session (replace too): triage
 * without walking back through each one. While shown, the session is the
 * selected one, as the classic panel makes it.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@/types';
import { Button, EmptyState, Screen, SegmentedControl, useScreenSlot } from '../kit';
import { ChevronRightIcon, EllipsisIcon } from '../kit/kitIcons';
import SessionTerminal from './SessionTerminal';
import ConnectionBanner from './ConnectionBanner';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { phoneStatus, sessionSubtitle } from '@/lib/chat/phoneStatus';
import { needsYou, nextWaitingSession, waitingSessions } from '@/lib/chat/inboxModel';
import { sessionPath, type SessionSegment } from '@/lib/chat/phoneRoutes';
import styles from '@/styles/modules/mobile/Screens.module.css';

const SessionActionsSheet = lazy(() => import('../SessionActionsSheet'));

const SEGMENTS = [
  { value: 'chat', label: 'Chat' },
  { value: 'changes', label: 'Changes' },
  { value: 'terminal', label: 'Terminal' },
] as const;

function useSelectWhileShown(sessionId: string): void {
  // Only the screen on show: one sliding out (or kept under another) never selects.
  const { isTop } = useScreenSlot();
  useEffect(() => {
    if (!isTop) return;
    const store = useSessionStore.getState();
    if (store.selectedSessionId !== sessionId) store.selectSession(sessionId);
    return () => {
      const now = useSessionStore.getState();
      if (now.selectedSessionId === sessionId) now.deselectSession();
    };
  }, [sessionId, isTop]);
}

function ChatPlaceholder({ session, onTerminal }: { session: Session; onTerminal: () => void }) {
  const waiting = needsYou(session);
  return (
    <div className={styles.placeholder}>
      <EmptyState
        title={waiting ? phoneStatus(session.status, !!session.interruption).label : 'The chat view is on its way'}
        message={waiting
          ? (session.pendingToolDetail || session.waitingDetail || 'Answer it in the terminal for now.')
          : 'Read and answer this session in the terminal for now.'}
        action={<Button variant="primary" onClick={onTerminal}>Open terminal</Button>}
      />
    </div>
  );
}

function ChangesPlaceholder({ onTerminal }: { onTerminal: () => void }) {
  return (
    <div className={styles.placeholder}>
      <EmptyState
        title="Changes are on their way"
        message="The files this session edits will be listed here."
        action={<Button onClick={onTerminal}>Open terminal</Button>}
      />
    </div>
  );
}

export default function SessionScreen({ sessionId, segment }: { sessionId: string; segment: SessionSegment }) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const sessions = useSessionStore((s) => s.sessions);
  const snapshotReceived = useWsStore((s) => s.snapshotReceived);
  const pop = usePhoneNavStore((s) => s.pop);
  const replace = usePhoneNavStore((s) => s.replace);
  const [actionsOpen, setActionsOpen] = useState(false);
  const closeActions = useCallback(() => setActionsOpen(false), []);
  useSelectWhileShown(sessionId);

  const others = useMemo(
    () => waitingSessions(sessions).filter((s) => s.sessionId !== sessionId).length,
    [sessions, sessionId],
  );
  const next = useMemo(() => (others > 0 ? nextWaitingSession(sessions, sessionId) : null), [others, sessions, sessionId]);

  const show = useCallback((seg: SessionSegment) => replace(sessionPath(sessionId, seg)), [replace, sessionId]);
  const showTerminal = useCallback(() => show('terminal'), [show]);

  if (!session) {
    return (
      <Screen title="Session" onBack={pop} backLabel="Back to the list" testId="phone-session-missing">
        <EmptyState
          live={!snapshotReceived}
          title={snapshotReceived ? 'This session isn’t here' : 'Loading…'}
          message={snapshotReceived ? 'It ended, or it isn’t shared with this phone.' : undefined}
          action={snapshotReceived ? <Button onClick={pop}>Back</Button> : undefined}
        />
      </Screen>
    );
  }

  const panelId = `session-panel-${sessionId}`;
  const segmentIds = `session-segment-${sessionId}`;
  return (
    <Screen
      title={sessionDisplayTitle(session)}
      subtitle={sessionSubtitle(session)}
      onBack={pop}
      backLabel="Back to the list"
      scroll={false}
      testId="phone-session"
      actions={(
        <button type="button" className={styles.navAction} onClick={() => setActionsOpen(true)} aria-label="Session actions">
          <EllipsisIcon />
        </button>
      )}
      banner={(
        <>
          <ConnectionBanner />
          {next && (
            <button type="button" className={styles.nextWaiting} onClick={() => replace(sessionPath(next, 'chat'))}>
              <span>{others} more {others === 1 ? 'needs' : 'need'} you</span>
              <ChevronRightIcon />
            </button>
          )}
          <div className={styles.segments}>
            <SegmentedControl segments={SEGMENTS} value={segment} onChange={show} label="Session view" panelId={panelId} idPrefix={segmentIds} />
          </div>
        </>
      )}
    >
      <div id={panelId} role="tabpanel" aria-labelledby={`${segmentIds}-${segment}`} className={styles.panel}>
        {segment === 'terminal' && <SessionTerminal session={session} />}
        {segment === 'chat' && <ChatPlaceholder session={session} onTerminal={showTerminal} />}
        {segment === 'changes' && <ChangesPlaceholder onTerminal={showTerminal} />}
      </div>
      {actionsOpen && (
        <Suspense fallback={null}>
          <SessionActionsSheet sessionId={sessionId} onClose={closeActions} onOpened={closeActions} />
        </Suspense>
      )}
    </Screen>
  );
}
