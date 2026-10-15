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
import { Button, EmptyState, Screen, SegmentedControl, useScreenSlot } from '../kit';
import { ChevronRightIcon, EllipsisIcon } from '../kit/kitIcons';
import SessionTerminal from './SessionTerminal';
import ChatFooter from '../chat/ChatFooter';
import ConnectionBanner from './ConnectionBanner';
import ChatView from '../chat/ChatView';
import ChangesView, { ChangesBadge } from '../chat/ChangesView';
import { useSessionChangesTotal } from '@/stores/changesStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { sessionSubtitle } from '@/lib/chat/phoneStatus';
import { nextWaitingSession, waitingSessions } from '@/lib/chat/inboxModel';
import { infoPath, sessionPath, type SessionSegment } from '@/lib/chat/phoneRoutes';
import styles from '@/styles/modules/mobile/Screens.module.css';

// The ⋯ menu's four actions (AASC-46); the title opens Info, which has the rest.
const SessionMenuSheet = lazy(() => import('./info/SessionMenuSheet'));

const SEGMENTS = [
  { value: 'chat', label: 'Chat' },
  { value: 'changes', label: 'Changes' },
  { value: 'terminal', label: 'Terminal' },
] as const;

/** The segments, with the session's edit total on Changes ("Changes +42 −7"). */
function useSegments(sessionId: string) {
  const total = useSessionChangesTotal(sessionId);
  const added = total?.added ?? 0;
  const removed = total?.removed ?? 0;
  return useMemo(
    () => SEGMENTS.map((s) => (s.value === 'changes' && (added || removed)
      ? { ...s, badge: <ChangesBadge total={{ added, removed }} /> }
      : s)),
    [added, removed],
  );
}

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

export default function SessionScreen({ sessionId, segment }: { sessionId: string; segment: SessionSegment }) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const sessions = useSessionStore((s) => s.sessions);
  const snapshotReceived = useWsStore((s) => s.snapshotReceived);
  const pop = usePhoneNavStore((s) => s.pop);
  const replace = usePhoneNavStore((s) => s.replace);
  const push = usePhoneNavStore((s) => s.push);
  const [actionsOpen, setActionsOpen] = useState(false);
  const closeActions = useCallback(() => setActionsOpen(false), []);
  useSelectWhileShown(sessionId);
  const segments = useSegments(sessionId);

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
      onTitlePress={() => push(infoPath(sessionId))}
      scroll={false}
      testId="phone-session"
      actions={(
        <button type="button" className={styles.navAction} onClick={() => setActionsOpen(true)} aria-label="Session actions" aria-haspopup="dialog">
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
            <SegmentedControl segments={segments} value={segment} onChange={show} label="Session view" panelId={panelId} idPrefix={segmentIds} />
          </div>
        </>
      )}
    >
      <div id={panelId} role="tabpanel" aria-labelledby={`${segmentIds}-${segment}`} className={styles.panel}>
        {segment === 'terminal' && <SessionTerminal session={session} />}
        {segment === 'chat' && <ChatView session={session} onTerminal={showTerminal} />}
        {segment === 'changes' && <ChangesView session={session} onTerminal={showTerminal} />}
      </div>
      {segment === 'chat' && <ChatFooter session={session} onTerminal={showTerminal} />}
      {actionsOpen && (
        <Suspense fallback={null}>
          <SessionMenuSheet sessionId={sessionId} onClose={closeActions} />
        </Suspense>
      )}
    </Screen>
  );
}
