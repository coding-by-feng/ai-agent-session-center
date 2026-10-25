/**
 * SessionScreen — one session (AASC-39 frame; Chat AASC-41, Changes AASC-44,
 * Info AASC-46; Project and the terminal as a screen AASC-56).
 *
 *   ‹      agent-manager-2       ⋯
 *      Working · Opus 5.5 · high
 *   2 more need you ›                     only while other sessions wait
 *   [ Chat │ Changes │ Project │ Prompts │ Agents ] a plain shell: [ Terminal │ Project ]
 *                                         (the row scrolls sideways when it does not fit)
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
 * each one. A file path tapped in the terminal, or named in the chat, opens in the Project tab. While shown, the session is the
 * selected one, as the classic panel makes it.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@/types';
import { Button, EmptyState, Screen, SegmentedControl, useScreenSlot } from '../kit';
import { ChevronRightIcon, EllipsisIcon } from '../kit/kitIcons';
import { ExitFullscreenIcon } from '../phoneIcons';
import { FullscreenIcon } from '../chat/chatIcons';
import { useMoreToTheRight } from '@/hooks/useMoreToTheRight';
import { openBackLayer } from '@/lib/backLayers';
import SessionTerminal from './SessionTerminal';
import SessionProjectSegment from './SessionProjectSegment';
import SessionPromptsSegment from './SessionPromptsSegment';
import SessionAgentsSegment from './SessionAgentsSegment';
import ChatFooter from '../chat/ChatFooter';
import ConnectionBanner from './ConnectionBanner';
import ChatView from '../chat/ChatView';
import ChangesView, { ChangesBadge } from '../chat/ChangesView';
import { useSessionChangesTotal } from '@/stores/changesStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { useUiStore } from '@/stores/uiStore';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { useChatStore } from '@/stores/chatStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { sessionSubtitle } from '@/lib/chat/phoneStatus';
import { detectCli } from '@/lib/cliDetect';
import type { PeekPrompt } from '@/lib/promptPeek';
import { countLiveAgents } from '@/lib/agentFlow';
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
// A hold on the title: the recent prompts (Oct 23 2026); a tap still opens Info.
const RecentPromptsSheet = lazy(() => import('./RecentPromptsSheet'));

const LABELS: Record<SessionSegment, string> = {
  chat: 'Chat',
  changes: 'Changes',
  project: 'Project',
  prompts: 'Prompts',
  agents: 'Agents',
  terminal: 'Terminal',
};

/** The session's tabs, with how many files changed on Changes ("Changes 12") and how many agents work on Agents ("Agents 2"). */
function useSegments(sessionId: string, hasChat: boolean) {
  const total = useSessionChangesTotal(sessionId);
  const added = total?.added ?? 0;
  const removed = total?.removed ?? 0;
  const files = total?.files ?? 0;
  const agents = useSessionStore((s) => countLiveAgents(s.sessions.get(sessionId), s.sessions));
  return useMemo(
    () => segmentsFor(hasChat).map((value) => {
      if (value === 'changes' && files > 0) return { value, label: LABELS[value], badge: <ChangesBadge total={{ added, removed, files }} /> };
      if (value === 'agents' && agents > 0) return { value, label: LABELS[value], badge: <AgentsBadge count={agents} /> };
      return { value, label: LABELS[value] };
    }),
    [hasChat, added, removed, files, agents],
  );
}

/** "Agents 2": the count is seen, and read with what it counts. */
function AgentsBadge({ count }: { count: number }) {
  return (
    <>
      <span aria-hidden="true">{count}</span>
      <span className={styles.srOnly}>, {count} {count === 1 ? 'agent' : 'agents'} working</span>
    </>
  );
}

/** Keeps the selected tab in the row's view when the row scrolls (a reload on Agents, a tap on a half-shown tab). */
function useSelectedTabInView(trackId: string, shown: SessionSegment): void {
  useEffect(() => {
    const tab = document.getElementById(`${trackId}-${shown}`);
    tab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [trackId, shown]);
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
  const [recentOpen, setRecentOpen] = useState(false);
  const closeRecent = useCallback(() => setRecentOpen(false), []);
  // The prompt the recent list asked the Prompts tab to open (a new object per tap, so a second tap reopens it).
  const [promptToOpen, setPromptToOpen] = useState<PeekPrompt | null>(null);
  const hasChat = sessionHasChat(detectCli(session));
  const shown = shownSegment(segment, hasChat);
  const terminalScreen = hasChat && shown === 'terminal';
  // The Chat read full screen (Oct 21 2026: in landscape the conversation got a thin strip
  // between the bar, the tabs and the box): no bar, no tabs, no footer; ⤡ or Back leaves it.
  const [chatFull, setChatFull] = useState(false);
  // Tabs past the right edge: the track fades there, so the cut by ⛶ reads as "scroll" (Oct 24 2026).
  const [segmentsRef, moreSegments] = useMoreToTheRight<HTMLDivElement>();
  const full = chatFull && shown === 'chat' && !terminalScreen;
  const { isTop: onTop } = useScreenSlot();
  useEffect(() => (full && onTop ? openBackLayer(() => setChatFull(false)) : undefined), [full, onTop]);
  // The footer (and its waiting card) is hidden: the way out says when the agent waits on you.
  const needsYou = session.status === 'approval' || session.status === 'input';
  const segments = useSegments(sessionId, hasChat);
  useChatUnderTerminal(sessionId, terminalScreen);
  useFileLinksToProject(session, hasChat, shown === 'terminal');

  const others = useMemo(
    () => waitingSessions(sessions).filter((s) => s.sessionId !== sessionId).length,
    [sessions, sessionId],
  );
  const next = useMemo(() => (others > 0 ? nextWaitingSession(sessions, sessionId) : null), [others, sessions, sessionId]);

  const show = useCallback((seg: SessionSegment) => {
    // Leaving Prompts ends a request from the recent list: back on the tab it is just the list.
    if (seg !== 'prompts') setPromptToOpen(null);
    replace(sessionPath(sessionId, seg));
  }, [replace, sessionId]);
  const openTerminal = useCallback(() => openTerminalIn(sessionId, hasChat), [openTerminalIn, sessionId, hasChat]);
  // ⋯ → "Search this chat" (Oct 21 2026): to Chat if another tab shows, then that chat opens its bar
  // (a request the chat takes when it mounts, as Info → Model reaches the composer).
  const searchChat = useCallback(() => {
    if (shown !== 'chat') show('chat');
    useChatStore.getState().requestSearch(sessionId);
  }, [shown, show, sessionId]);
  // A file the chat names opens in the Project tab, whose browser takes the request (as from the terminal).
  const { projectPath } = session;
  // "Use again" in Prompts: the text back in this session's composer (never sent), on Chat.
  const useAgain = useCallback((text: string) => {
    useComposerDraftStore.getState().setDraft(sessionId, text);
    show('chat');
  }, [sessionId, show]);
  const openPrompt = useCallback((prompt: PeekPrompt) => {
    setRecentOpen(false);
    setPromptToOpen({ ...prompt });
    show('prompts');
  }, [show]);
  const promptOpened = useCallback(() => setPromptToOpen(null), []);
  const allPrompts = useCallback(() => {
    setRecentOpen(false);
    setPromptToOpen(null);
    show('prompts');
  }, [show]);
  const openFile = useCallback((relPath: string) => {
    if (!projectPath) return;
    useUiStore.getState().openFileInProject(`${projectPath.replace(/\/+$/, '')}${relPath}`, projectPath);
    show('project');
  }, [projectPath, show]);
  // Back from a tab leaves the session: past any other screen of it left under this
  // one (a shell's chat path under its Terminal, from a link).
  const leave = useCallback(() => {
    const { tab, stacks } = usePhoneNavStore.getState();
    popScreens(Math.max(1, sessionRunOnTop(stacks[tab], sessionId)));
  }, [popScreens, sessionId]);

  const panelId = `session-panel-${sessionId}`;
  const segmentIds = `session-segment-${sessionId}`;
  useSelectedTabInView(segmentIds, shown);
  return (
    <Screen
      title={sessionDisplayTitle(session)}
      subtitle={terminalScreen ? `Terminal · ${sessionSubtitle(session)}` : sessionSubtitle(session)}
      onBack={terminalScreen ? pop : leave}
      backLabel={terminalScreen ? 'Back to Chat' : 'Back to the list'}
      onTitlePress={() => push(infoPath(sessionId))}
      // A plain shell has no Prompts tab and no prompts: no hold.
      onTitleLongPress={hasChat ? () => setRecentOpen(true) : undefined}
      titleLongPressHint={hasChat ? 'Hold for recent prompts' : undefined}
      scroll={false}
      chrome={!full}
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
              <div ref={segmentsRef} className={styles.segmentsTrack} data-more={moreSegments ? '' : undefined}>
                <SegmentedControl segments={segments} value={shown} onChange={show} label="Session view" panelId={panelId} idPrefix={segmentIds} size="compact" />
              </div>
              {shown === 'chat' && (
                <button type="button" className={styles.fullEnter} onClick={() => setChatFull(true)} aria-label="Read the chat full screen">
                  <FullscreenIcon size={18} />
                </button>
              )}
            </div>
          )}
        </>
      )}
    >
      {terminalScreen ? (
        <div className={styles.panel}><SessionTerminal session={session} /></div>
      ) : (
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={full ? undefined : `${segmentIds}-${shown}`}
          aria-label={full ? 'Chat' : undefined}
          className={styles.panel}
          data-full={full ? '' : undefined}
        >
          {shown === 'terminal' && <SessionTerminal session={session} />}
          {shown === 'chat' && <ChatView session={session} onTerminal={openTerminal} onOpenFile={openFile} />}
          {full && (
            <button
              type="button"
              className={styles.fullExit}
              data-needs-you={needsYou ? '' : undefined}
              onClick={() => setChatFull(false)}
              aria-label={needsYou ? `Leave full screen: ${sessionDisplayTitle(session)} needs you` : 'Leave full screen'}
            >
              <ExitFullscreenIcon />
              <span>{needsYou ? 'Needs you' : 'Exit'}</span>
            </button>
          )}
          {shown === 'changes' && <ChangesView session={session} onTerminal={openTerminal} />}
          {shown === 'project' && <SessionProjectSegment session={session} />}
          {shown === 'prompts' && <SessionPromptsSegment sessionId={sessionId} onUseAgain={useAgain} openAt={promptToOpen} onOpenAtDone={promptOpened} />}
          {shown === 'agents' && <SessionAgentsSegment sessionId={sessionId} />}
        </div>
      )}
      {shown === 'chat' && !full && <ChatFooter session={session} onTerminal={openTerminal} />}
      {recentOpen && (
        <Suspense fallback={null}>
          <RecentPromptsSheet sessionId={sessionId} onClose={closeRecent} onOpenPrompt={openPrompt} onAllPrompts={allPrompts} />
        </Suspense>
      )}
      {actionsOpen && (
        <Suspense fallback={null}>
          <SessionMenuSheet
            sessionId={sessionId}
            onClose={closeActions}
            onTerminal={shown === 'terminal' ? undefined : openTerminal}
            onSearch={hasChat ? searchChat : undefined}
          />
        </Suspense>
      )}
    </Screen>
  );
}
