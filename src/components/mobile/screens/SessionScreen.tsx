/**
 * SessionScreen — one session (AASC-39 frame; Chat AASC-41, Changes AASC-44,
 * Info AASC-46; Project and the terminal as a screen AASC-56).
 *
 *   ‹      agent-manager-2       ⋯
 *      Working · Opus 5.5 · high
 *   2 more need you ›                     only while other sessions wait
 *   [ Chat │ Changes │ Project ]          a plain shell: [ Terminal │ Project ]
 *   …the segment…
 *
 * The segment is part of the path (`/sessions/<id>/project`), switched in place
 * (replace), so a reload lands on it and back still returns to the list.
 *
 * A Claude / Codex session's terminal is not a tab: `/sessions/<id>/terminal` is a
 * screen pushed over its Chat (Chat's "Open terminal", ⋯ → Terminal, the waiting
 * card), full screen without the tabs, and Back returns to Chat. A shell has no
 * Chat, so its Terminal is a tab, and a path to its Chat or Changes shows it.
 *
 * "N more need you ›" swaps in the next waiting session (in place of this one's
 * screens, its terminal and Chat included): triage without walking back through
 * each one. A file path tapped in the terminal opens in the Project tab. While shown, the session is the
 * selected one, as the classic panel makes it.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@/types';
import { Button, EmptyState, Screen, SegmentedControl, useScreenSlot } from '../kit';
import { ChevronRightIcon, EllipsisIcon } from '../kit/kitIcons';
import SessionTerminal from './SessionTerminal';
import SessionProjectSegment from './SessionProjectSegment';
import ChatFooter from '../chat/ChatFooter';
import ConnectionBanner from './ConnectionBanner';
import ChatView from '../chat/ChatView';
import ChangesView, { ChangesBadge } from '../chat/ChangesView';
import { useSessionChangesTotal } from '@/stores/changesStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { useUiStore } from '@/stores/uiStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { sessionSubtitle } from '@/lib/chat/phoneStatus';
import { detectCli } from '@/lib/cliDetect';
import { nextWaitingSession, waitingSessions } from '@/lib/chat/inboxModel';
import {
  infoPath,
  segmentsFor,
  sessionHasChat,
  sessionPath,
  sessionRunOnTop,
  shownSegment,
  type SessionSegment,
} from '@/lib/chat/phoneRoutes';
import styles from '@/styles/modules/mobile/Screens.module.css';

// The ⋯ menu's actions (AASC-46); the title opens Info, which has the rest.
const SessionMenuSheet = lazy(() => import('./info/SessionMenuSheet'));

const LABELS: Record<SessionSegment, string> = {
  chat: 'Chat',
  changes: 'Changes',
  project: 'Project',
  terminal: 'Terminal',
};

/** The session's tabs, with its edit total on Changes ("Changes +42 −7"). */
function useSegments(sessionId: string, hasChat: boolean) {
  const total = useSessionChangesTotal(sessionId);
  const added = total?.added ?? 0;
  const removed = total?.removed ?? 0;
  return useMemo(
    () => segmentsFor(hasChat).map((value) => (value === 'changes' && (added || removed)
      ? { value, label: LABELS[value], badge: <ChangesBadge total={{ added, removed }} /> }
      : { value, label: LABELS[value] })),
    [hasChat, added, removed],
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

/**
 * A Claude / Codex terminal stands over its Chat. One left without it (a stack
 * saved before AASC-56, a CLI detected after the screen opened as a shell's
 * Terminal) gets its Chat put back under it, so Back returns to Chat.
 */
function useChatUnderTerminal(sessionId: string, terminalScreen: boolean): void {
  const { isTop } = useScreenSlot();
  useEffect(() => {
    if (!isTop || !terminalScreen) return;
    const { tab, stacks, openTerminal } = usePhoneNavStore.getState();
    const stack = stacks[tab];
    // Only from the screen really on top of the stack (not one sliding out after a Back).
    if (stack[stack.length - 1] !== sessionPath(sessionId, 'terminal')) return;
    if (stack[stack.length - 2] !== sessionPath(sessionId, 'chat')) openTerminal(sessionId, true);
  }, [isTop, terminalScreen, sessionId]);
}

/** A file path tapped in the terminal opens in the Project tab, whose browser takes the request. */
function useFileLinksToProject(session: Session, hasChat: boolean, onTerminal: boolean): void {
  const { isTop } = useScreenSlot();
  const { sessionId, projectPath } = session;
  useEffect(() => {
    if (!isTop || !onTerminal || !projectPath) return;
    return useUiStore.subscribe((state, prev) => {
      const request = state.pendingFileOpen;
      if (!request || request === prev.pendingFileOpen) return;
      if (request.projectPath && request.projectPath !== projectPath) return;
      const nav = usePhoneNavStore.getState();
      const top = nav.stacks[nav.tab][nav.stacks[nav.tab].length - 1];
      if (top !== sessionPath(sessionId, 'terminal')) return; // not this screen any more
      nav.showSegment(sessionId, 'project', hasChat);
    });
  }, [isTop, onTerminal, projectPath, sessionId, hasChat]);
}

function MissingSession({ onBack }: { onBack: () => void }) {
  const snapshotReceived = useWsStore((s) => s.snapshotReceived);
  return (
    <Screen title="Session" onBack={onBack} backLabel="Back to the list" testId="phone-session-missing">
      <EmptyState
        live={!snapshotReceived}
        title={snapshotReceived ? 'This session isn’t here' : 'Loading…'}
        message={snapshotReceived ? 'It ended, or it isn’t shared with this phone.' : undefined}
        action={snapshotReceived ? <Button onClick={onBack}>Back</Button> : undefined}
      />
    </Screen>
  );
}

export default function SessionScreen({ sessionId, segment }: { sessionId: string; segment: SessionSegment }) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const pop = usePhoneNavStore((s) => s.pop);
  useSelectWhileShown(sessionId);
  if (!session) return <MissingSession onBack={pop} />;
  return <SessionFrame session={session} segment={segment} />;
}

function SessionFrame({ session, segment }: { session: Session; segment: SessionSegment }) {
  const { sessionId } = session;
  const sessions = useSessionStore((s) => s.sessions);
  const pop = usePhoneNavStore((s) => s.pop);
  const popScreens = usePhoneNavStore((s) => s.popScreens);
  const replace = usePhoneNavStore((s) => s.replace);
  const replaceSession = usePhoneNavStore((s) => s.replaceSession);
  const push = usePhoneNavStore((s) => s.push);
  const openTerminalIn = usePhoneNavStore((s) => s.openTerminal);
  const [actionsOpen, setActionsOpen] = useState(false);
  const closeActions = useCallback(() => setActionsOpen(false), []);
  const hasChat = sessionHasChat(detectCli(session));
  const shown = shownSegment(segment, hasChat);
  const terminalScreen = hasChat && shown === 'terminal';
  const segments = useSegments(sessionId, hasChat);
  useChatUnderTerminal(sessionId, terminalScreen);
  useFileLinksToProject(session, hasChat, shown === 'terminal');

  const others = useMemo(
    () => waitingSessions(sessions).filter((s) => s.sessionId !== sessionId).length,
    [sessions, sessionId],
  );
  const next = useMemo(() => (others > 0 ? nextWaitingSession(sessions, sessionId) : null), [others, sessions, sessionId]);

  const show = useCallback((seg: SessionSegment) => replace(sessionPath(sessionId, seg)), [replace, sessionId]);
  const openTerminal = useCallback(() => openTerminalIn(sessionId, hasChat), [openTerminalIn, sessionId, hasChat]);
  // Back from a tab leaves the session: past any other screen of it left under this
  // one (a shell's chat path under its Terminal, from a link).
  const leave = useCallback(() => {
    const { tab, stacks } = usePhoneNavStore.getState();
    popScreens(Math.max(1, sessionRunOnTop(stacks[tab], sessionId)));
  }, [popScreens, sessionId]);

  const panelId = `session-panel-${sessionId}`;
  const segmentIds = `session-segment-${sessionId}`;
  return (
    <Screen
      title={sessionDisplayTitle(session)}
      subtitle={terminalScreen ? `Terminal · ${sessionSubtitle(session)}` : sessionSubtitle(session)}
      onBack={terminalScreen ? pop : leave}
      backLabel={terminalScreen ? 'Back to Chat' : 'Back to the list'}
      onTitlePress={() => push(infoPath(sessionId))}
      scroll={false}
      testId={terminalScreen ? 'phone-session-terminal' : 'phone-session'}
      actions={(
        <button type="button" className={styles.navAction} onClick={() => setActionsOpen(true)} aria-label="Session actions" aria-haspopup="dialog">
          <EllipsisIcon />
        </button>
      )}
      banner={(
        <>
          <ConnectionBanner />
          {next && (
            <button type="button" className={styles.nextWaiting} onClick={() => replaceSession(sessionId, sessionPath(next, 'chat'))}>
              <span>{others} more {others === 1 ? 'needs' : 'need'} you</span>
              <ChevronRightIcon />
            </button>
          )}
          {!terminalScreen && (
            <div className={styles.segments}>
              <SegmentedControl segments={segments} value={shown} onChange={show} label="Session view" panelId={panelId} idPrefix={segmentIds} />
            </div>
          )}
        </>
      )}
    >
      {terminalScreen ? (
        <div className={styles.panel}><SessionTerminal session={session} /></div>
      ) : (
        <div id={panelId} role="tabpanel" aria-labelledby={`${segmentIds}-${shown}`} className={styles.panel}>
          {shown === 'terminal' && <SessionTerminal session={session} />}
          {shown === 'chat' && <ChatView session={session} onTerminal={openTerminal} />}
          {shown === 'changes' && <ChangesView session={session} onTerminal={openTerminal} />}
          {shown === 'project' && <SessionProjectSegment session={session} />}
        </div>
      )}
      {shown === 'chat' && <ChatFooter session={session} onTerminal={openTerminal} />}
      {actionsOpen && (
        <Suspense fallback={null}>
          <SessionMenuSheet sessionId={sessionId} onClose={closeActions} onTerminal={shown === 'terminal' ? undefined : openTerminal} />
        </Suspense>
      )}
    </Screen>
  );
}
