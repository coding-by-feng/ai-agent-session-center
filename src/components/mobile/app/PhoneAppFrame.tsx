/**
 * PhoneAppFrame — the phone app (AASC-38/39): a stack of screens per
 * tab over a bottom tab bar (Sessions · Inbox · Queue · More).
 *
 * App.tsx renders it instead of the desktop layout on every phone-sized screen
 * (`useIsMobile()`, AASC-48), lazily, so the desktop never downloads it.
 * Everything App mounts above the layout keeps running (WebSocket, auth,
 * settings, room sync): a resize or a turn that swaps the two swaps only this,
 * never the connection or the pairing.
 *
 * While mounted it:
 *  - puts `phoneApp` on <body>, which scopes the phone tokens (phoneTokens.css)
 *    to the frame and to everything portaled to <body>;
 *  - owns the browser history through phoneNavStore (?m=<path>, a root sentinel,
 *    "Press back again to leave" on Android), and answers the app's own back
 *    button (`window.__aascNativeBack`, asked by MainActivity);
 *  - maps an old `?session=<id>&tab=…` link onto the new screens once the first
 *    snapshot says the session is visible (hidden or unknown: nothing happens);
 *  - turns any `selectSession(id)` from the views it reuses (History "Open",
 *    global search, fork / clone) into "open that session on the Sessions tab".
 *
 * On a wide, tall screen (an iPad in landscape: PHONE_SPLIT_MEDIA_QUERY) it is a
 * split view: the tab's root list and the tab bar on the left, the screens above
 * the root on the right (PhoneStack `hideRoot`), and a row opened from the list
 * replaces the right pane (`openFromRoot` through listPane.ts `useOpenScreen`;
 * the pane's own screens drill down with `push`). The stacks are the same in both
 * layouts, so crossing the line keeps what is open.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MemoryRouter } from 'react-router';
import { EmptyState, TabBar } from '../kit';
import { ScreenSlotContext } from '../kit/screenSlot';
import RouteScreen from './RouteScreen';
import { ListPaneContext } from './listPane';
import { InboxTabIcon, MoreTabIcon, QueueTabIcon, SessionsTabIcon } from '../kit/kitIcons';
import PhoneStack from './PhoneStack';
import { useKeyboardKeepsSplit, useSoftKeyboardOpen } from './useSoftKeyboardOpen';
import { useLiveActivityFeed } from './useLiveActivityFeed';
import ToastContainer, { showToast } from '@/components/ui/ToastContainer';
import NewSessionModal from '@/components/modals/NewSessionModal';
import GlobalSearchModal from '@/components/modals/GlobalSearchModal';
import FloatingTerminalRoot from '@/components/session/FloatingTerminalRoot';
import FileOpenChooser from '@/components/session/FileOpenChooser';
import { useSessionStore } from '@/stores/sessionStore';
import { usePhoneConfirmStore } from '@/stores/phoneConfirmStore';
import { useWsStore } from '@/stores/wsStore';
import {
  LEAVE_WINDOW_MS,
  browserNavHistory,
  handleSystemBack,
  installPhoneNav,
  usePhoneNavStore,
} from '@/stores/phoneNavStore';
import { inboxCount, needsYou } from '@/lib/chat/inboxModel';
import {
  legacyDeepLinkToPath,
  parsePhonePath,
  sessionHasChat,
  withoutPhonePath,
  type PhoneTab,
} from '@/lib/chat/phoneRoutes';
import { detectCli } from '@/lib/cliDetect';
import { usePhoneAppearanceOnBody } from '@/lib/chat/phoneAppearance';
import { rekeyedSessions } from '@/lib/chat/sessionRekey';
import { moveSessionRead } from '@/lib/chat/sessionReads';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { PHONE_SPLIT_MEDIA_QUERY } from '@/lib/platform';
import '@/styles/modules/mobile/phoneTokens.css';
import styles from '@/styles/modules/mobile/PhoneAppFrame.module.css';

const LEGACY_PARAMS = ['session', 'tab', 'kind'];

declare global {
  interface Window {
    /**
     * The Android app's back button (MainActivity asks it through evaluateJavascript):
     * 'handled', or 'leave' for a second back at a tab root. Absent outside the frame.
     */
    __aascNativeBack?: () => 'handled' | 'leave';
  }
}

const TABS = [
  { id: 'sessions' as const, label: 'Sessions', icon: <SessionsTabIcon /> },
  { id: 'inbox' as const, label: 'Inbox', icon: <InboxTabIcon />, badgeLabel: (n: number) => `${n} waiting for you` },
  { id: 'queue' as const, label: 'Queue', icon: <QueueTabIcon /> },
  { id: 'more' as const, label: 'More', icon: <MoreTabIcon /> },
];

/** What the split view's right pane says with nothing open. */
const SPLIT_EMPTY: Record<PhoneTab, string> = {
  sessions: 'Pick a session to open it here',
  inbox: 'Pick a waiting session to answer it here',
  queue: 'Pick a queue to open it here',
  more: 'Pick an item to open it here',
};

const noop = () => {};

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The phone tokens reach <body>, so sheets and toasts portaled there wear them too. */
function usePhoneBodyClass(): void {
  useLayoutEffect(() => {
    document.body.classList.add('phoneApp');
    return () => document.body.classList.remove('phoneApp');
  }, []);
}

/** Restore the nav and take over the history; old deep-link params never reach a history entry. */
function usePhoneNavigation(): void {
  useLayoutEffect(() => {
    const url = new URL(window.location.href);
    for (const key of LEGACY_PARAMS) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    const uninstall = installPhoneNav({
      history: browserNavHistory(),
      onLeaveAttempt: () => showToast('Press back again to leave', 'info', LEAVE_WINDOW_MS),
      search: url.search,
    });
    window.__aascNativeBack = handleSystemBack;
    return () => {
      delete window.__aascNativeBack;
      uninstall();
      window.history.replaceState(window.history.state, '', withoutPhonePath(window.location.href));
    };
  }, []);
}

/** `?session=<id>&tab=…` (a notification tap, an old link): open it once the snapshot shows it. */
function useLegacyDeepLink(search: string): void {
  const snapshotReceived = useWsStore((s) => s.snapshotReceived);
  const sessions = useSessionStore((s) => s.sessions);
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current || !snapshotReceived) return;
    handled.current = true;
    const path = legacyDeepLinkToPath(search, (id) => {
      const s = sessions.get(id);
      return !!s && needsYou(s);
    });
    const route = path ? parsePhonePath(path) : null;
    const target = route?.kind === 'session' ? sessions.get(route.sessionId) : undefined;
    if (route?.kind !== 'session' || !target) return;
    // A Claude / Codex terminal opens over its Chat, a shell's as its Terminal tab (AASC-56).
    const hasChat = sessionHasChat(detectCli(target));
    usePhoneNavStore.getState().openSession(route.sessionId, hasChat ? route.segment : 'terminal', 'sessions', hasChat);
  }, [search, snapshotReceived, sessions]);
}

/**
 * A session re-keyed (/clear, a resume): every screen of it follows the new id in
 * place, under the top too (Info, a diff, the session under them), on the same
 * segment, and its composer draft and read stamp move with it. Subscribed before
 * the selection bridge, so the selection following the new id finds the session
 * screen already renamed and opens nothing.
 */
function useSessionRekey(): void {
  useEffect(() => useSessionStore.subscribe((state, prev) => {
    for (const [oldId, newId] of rekeyedSessions(prev.sessions, state.sessions)) {
      usePhoneNavStore.getState().renameSession(oldId, newId);
      useComposerDraftStore.getState().moveDraft(oldId, newId);
      moveSessionRead(oldId, newId);
    }
  }), []);
}

/** Today's views select a session to open it; here that means pushing its screen. */
function useSelectionBridge(): void {
  useEffect(() => {
    // A selection left from the desktop layout (a window narrowed to a phone) would make
    // "Open" on that same session look like no change, and do nothing. The
    // session screen on top, if any, selected its session already (child
    // effects run first): keep that one.
    const selected = useSessionStore.getState().selectedSessionId;
    const nav = usePhoneNavStore.getState();
    const top = parsePhonePath(nav.stacks[nav.tab][nav.stacks[nav.tab].length - 1]);
    if (selected && !(top?.kind === 'session' && top.sessionId === selected)) {
      useSessionStore.getState().deselectSession();
    }
  }, []);
  useEffect(() => useSessionStore.subscribe((state, prev) => {
    const id = state.selectedSessionId;
    if (!id || id === prev.selectedSessionId) return;
    // The selection following a re-key is not an "open": useSessionRekey moved the screens.
    if (prev.selectedSessionId && state.sessions.get(id)?.replacesId === prev.selectedSessionId) return;
    const nav = usePhoneNavStore.getState();
    const stack = nav.stacks[nav.tab];
    const top = parsePhonePath(stack[stack.length - 1]);
    if (top?.kind === 'session' && top.sessionId === id) return;
    nav.openSession(id);
  }), []);
}

/** The split view's left pane: the shown tab's root screen, always on top (it owns the tab bar's scroll-to-top). */
function ListPane({ path, registerScroller }: { path: string; registerScroller: (el: HTMLElement | null) => void }) {
  const slot = useMemo(() => ({ isTop: true, registerScroller }), [registerScroller]);
  return (
    <div className={styles.listPane} data-testid="phone-list-pane">
      <ListPaneContext.Provider value>
        <ScreenSlotContext.Provider value={slot}>
          <RouteScreen path={path} />
        </ScreenSlotContext.Provider>
      </ListPaneContext.Provider>
    </div>
  );
}

/** Tell the nav store whether the split view shows, before a tap can push. */
function useSplitView(): boolean {
  // The keyboard shrinks the WebView under the split's minimum height: it must not
  // collapse the split, or the remount blurs the field and the keyboard flickers.
  const keyboardKeepsSplit = useKeyboardKeepsSplit();
  const split = useMediaQuery(PHONE_SPLIT_MEDIA_QUERY) || keyboardKeepsSplit;
  useLayoutEffect(() => {
    usePhoneNavStore.getState().setSplit(split);
  }, [split]);
  useEffect(() => () => usePhoneNavStore.getState().setSplit(false), []);
  return split;
}

export default function PhoneAppFrame() {
  const [initialSearch] = useState(() => window.location.search);
  usePhoneBodyClass();
  // More → Settings → Appearance: System, or Light / Dark kept on this phone (AASC-47).
  usePhoneAppearanceOnBody();
  usePhoneNavigation();
  useLegacyDeepLink(initialSearch);
  useSessionRekey();
  useSelectionBridge();
  // The lock-screen Live Activity (iOS app only).
  useLiveActivityFeed();
  const split = useSplitView();

  const tab = usePhoneNavStore((s) => s.tab);
  const stack = usePhoneNavStore((s) => s.stacks[s.tab]);
  const pop = usePhoneNavStore((s) => s.pop);
  // The Inbox badge counts the sessions waiting on the person and the central confirmations this phone may answer.
  const confirmsWaiting = usePhoneConfirmStore((s) => s.confirms.length);
  const waiting = useSessionStore((s) => inboxCount(s.sessions)) + confirmsWaiting;
  const keyboardOpen = useSoftKeyboardOpen();

  const scroller = useRef<HTMLElement | null>(null);
  const registerScroller = useCallback((el: HTMLElement | null) => {
    scroller.current = el;
  }, []);

  const onSelectTab = useCallback((next: PhoneTab) => {
    const nav = usePhoneNavStore.getState();
    if (next !== nav.tab) {
      nav.switchTab(next);
      return;
    }
    // The active tab again: back to the top first, then back to the tab's root.
    const el = scroller.current;
    if (el && el.scrollTop > 0) {
      if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      else el.scrollTop = 0;
      return;
    }
    nav.popToRoot();
  }, []);

  const top = parsePhonePath(stack[stack.length - 1]);
  // Hidden inside a session and on every screen pushed from it (Info, a diff): the composer
  // owns the bottom there, and the bar shouldn't come back one level deeper.
  // In the split view the composer is in the right pane: the bar stays under the list.
  const tabBarHidden = keyboardOpen
    || (!split && (top?.kind === 'session' || top?.kind === 'session-info' || top?.kind === 'diff'));
  const items = TABS.map((t) => (t.id === 'inbox' ? { ...t, badge: waiting } : t));

  return (
    <MemoryRouter>
      <div
        className={styles.frame}
        data-testid="phone-app"
        data-split={split ? '' : undefined}
        data-tabbar-hidden={tabBarHidden ? '' : undefined}
      >
        {split && <ListPane key={`list-${tab}`} path={stack[0]} registerScroller={registerScroller} />}
        <PhoneStack
          key={tab}
          stack={stack}
          registerScroller={split ? noop : registerScroller}
          onBack={pop}
          hideRoot={split}
          empty={<div className={styles.splitEmpty}><EmptyState title={SPLIT_EMPTY[tab]} /></div>}
        />
        <TabBar items={items} active={tab} onSelect={onSelectTab} hidden={tabBarHidden} />
        <ToastContainer className={styles.toasts} />
        <NewSessionModal />
        <GlobalSearchModal />
        <FloatingTerminalRoot />
        <FileOpenChooser />
      </div>
    </MemoryRouter>
  );
}
