/**
 * PhoneFloatingSheet — an AI popup (a floating fork) on a phone (AASC-20, AASC-57).
 *
 *   Explain (English)                         [End] [×]
 *   1. Explain (English)  2. Translate → 中文             chips, with several popups
 *   [ Answer | Terminal ]
 *   the popup's own conversation: the answer, whole, with Copy · Read aloud · Ask AI
 *   [ Reply to Claude…                       Send ]      follow-ups, through the Mac
 *
 * The desktop floats it in a draggable window or pops it out into one; a phone has
 * neither, so it gets the full height of the screen as a sheet. Pop-out and resizing
 * have no phone meaning and are not offered. Minimizing does (Nov 2 2026): the sheet's
 * ⌄ (and a swipe, the backdrop, Escape, Android back) leaves a floating ✦ button on the
 * session's screen, with a count for several popups and a dot while one still works;
 * tapping it reopens the popup last shown, or the newest when that one has ended.
 *
 *   ‹  Exmouth Development        ⋯
 *   [ Chat | Changes | Project ]
 *      chat …                 ╭───╮●   top-right, under the bars: the bottom holds the
 *                             │ ✦ │2   composer and waiting cards of any height
 *                             ╰───╯
 *   [ Queue a message for Claude… ]
 *
 * Answer is the popup's OWN session as a chat (ChatView + ChatFooter, the session
 * screen's own pieces): its answer rows carry Copy and Read aloud, and a follow-up
 * goes to the popup's session through the prompt route (`POST /sessions/<popup>/prompt`,
 * typed and confirmed by the Mac), never into the session it came from. Terminal is
 * the popup's terminal with the phone face (key bar, compose box, actions sheet),
 * the only view before the popup's session has its first hook, and the only one for
 * a CLI without a transcript.
 *
 * The session exists before any of this is drawn (see the floating-fork
 * invariants): the sheet only shows it. Minimizing the sheet HIDES the popup and
 * leaves it running; the ✦ button or Info → AI popups ("Open") brings it back; only
 * "End" closes it, after a confirm, through the store's
 * close(), which saves the answer under AI POPUPS before the terminal is killed.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import BottomSheet, { ConfirmSheet } from '@/components/ui/BottomSheet';
import Button from '@/components/ui/Button';
import TerminalContainer from '@/components/terminal/TerminalContainer';
import { useFloatingSessionsStore, type FloatingSession } from '@/stores/floatingSessionsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { detectCli } from '@/lib/cliDetect';
import { sessionHasChat } from '@/lib/chat/phoneRoutes';
import type { Session } from '@/types';
import { EmptyState, SegmentedControl } from './kit';
import styles from '@/styles/modules/PhoneExtras.module.css';

const ChatView = lazy(() => import('./chat/ChatView'));
const ChatFooter = lazy(() => import('./chat/ChatFooter'));

export interface PhoneFloatingSheetProps {
  /** The shown session's popups, oldest first. */
  floats: readonly FloatingSession[];
}

type PopupView = 'answer' | 'terminal';

/**
 * A popup the Mac has just started is announced within moments. Until then (or for this
 * long, at most) the sheet says it is starting, rather than mounting the terminal only to
 * swap it for the answer a moment later (a subscribe, a replay and an unsubscribe for nothing).
 */
const ANNOUNCE_WAIT_MS = 3000;

/** How long ago `t` was (outside render's purity: the timer below brings the re-render). */
const msSince = (t: number): number => Date.now() - t;

const VIEWS = [
  { value: 'answer', label: 'Answer' },
  { value: 'terminal', label: 'Terminal' },
] as const;

/** A popup whose session is still producing its answer. */
const WORKING = new Set(['working', 'prompting']);

const MinimizeIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

const SparkleIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9z" />
    <path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
  </svg>
);

/** The session a popup's terminal belongs to, once the Mac has announced it. */
function sessionOfTerminal(sessions: ReadonlyMap<string, Session>, terminalId: string): Session | null {
  for (const s of sessions.values()) if (s.terminalId === terminalId) return s;
  return null;
}

export default function PhoneFloatingSheet({ floats }: PhoneFloatingSheetProps) {
  const shownId = useFloatingSessionsStore((s) => s.phoneShown);
  const setShown = useFloatingSessionsStore((s) => s.setPhoneShown);
  const closeFloat = useFloatingSessionsStore((s) => s.close);
  const shown = floats.find((f) => f.terminalId === shownId) ?? null;
  const [confirmEnd, setConfirmEnd] = useState(false);
  // Which view each popup is on (per popup: the chips switch between them).
  const [views, setViews] = useState<Record<string, PopupView>>({});

  // Same socket rule as FloatingTerminalPanel: re-derive on reconnect.
  const client = useWsStore((s) => s.client);
  const connected = useWsStore((s) => s.connected);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `connected` swaps the socket inside the stable client
  const ws = useMemo(() => client?.getRawSocket() ?? null, [client, connected]);

  // The popup's own session drives the baton (typing from a phone), its chat and read-aloud.
  const own = useSessionStore((s) => (shown ? sessionOfTerminal(s.sessions, shown.terminalId) : null));
  const root = useSessionStore((s) => (shown ? s.sessions.get(shown.originSessionId) : undefined));
  const ownSessionId = own?.sessionId ?? null;
  // A popup runs its root's CLI; until its own session says which, the root's does.
  const hasChat = !!own && sessionHasChat(detectCli(own) ?? (root ? detectCli(root) : null));
  const view: PopupView = shown && hasChat ? views[shown.terminalId] ?? 'answer' : 'terminal';
  // Which just-started popup has waited out ANNOUNCE_WAIT_MS without its session showing up.
  const [waitedFor, setWaitedFor] = useState<string | null>(null);
  const shownTerminalId = shown?.terminalId ?? null;
  const fresh = !!shown && !own && waitedFor !== shown.terminalId && msSince(shown.createdAt) < ANNOUNCE_WAIT_MS;
  useEffect(() => {
    if (!fresh || !shownTerminalId || !shown) return undefined;
    const timer = setTimeout(() => setWaitedFor(shownTerminalId), Math.max(0, ANNOUNCE_WAIT_MS - msSince(shown.createdAt)));
    return () => clearTimeout(timer);
  }, [fresh, shownTerminalId, shown]);

  // The popup the ✦ button reopens: the one last shown, while it still runs.
  const lastShown = useRef<string | null>(null);
  useEffect(() => {
    if (shownTerminalId) lastShown.current = shownTerminalId;
  }, [shownTerminalId]);
  const floatIds = floats.map((f) => f.terminalId).join(',');
  const anyWorking = useSessionStore((s) => {
    if (!floatIds) return false;
    const ids = new Set(floatIds.split(','));
    for (const session of s.sessions.values()) {
      if (session.terminalId && ids.has(session.terminalId) && WORKING.has(session.status)) return true;
    }
    return false;
  });
  const reopen = useCallback(() => {
    const last = lastShown.current;
    const target = floats.some((f) => f.terminalId === last) ? last : floats.at(-1)?.terminalId ?? null;
    if (target) setShown(target);
  }, [floats, setShown]);

  // Stable: BottomSheet re-runs its focus effect whenever onClose changes.
  const hide = useCallback(() => setShown(null), [setShown]);
  const cancelEnd = useCallback(() => setConfirmEnd(false), []);
  const end = useCallback(() => {
    setConfirmEnd(false);
    if (shown) closeFloat(shown.terminalId);
  }, [shown, closeFloat]);
  const showView = useCallback((next: PopupView) => {
    if (shown) setViews((v) => ({ ...v, [shown.terminalId]: next }));
  }, [shown]);
  const toTerminal = useCallback(() => showView('terminal'), [showView]);

  return (
    <>
      <BottomSheet
        open={!!shown}
        onClose={hide}
        title={shown?.label ?? 'AI popup'}
        fullHeight
        flush
        closeLabel="Minimize"
        closeIcon={<MinimizeIcon />}
        headerAction={(
          <Button variant="danger" className={styles.floatEnd} onClick={() => setConfirmEnd(true)}>
            End
          </Button>
        )}
      >
        {shown && (
          <div className={styles.floatBody} data-testid="phone-float-sheet">
            {floats.length > 1 && (
              <div className={styles.floatBar}>
                <div className={styles.floatChips} role="group" aria-label="AI popups">
                  {floats.map((f, i) => (
                    <button
                      key={f.terminalId}
                      type="button"
                      className={styles.floatChip}
                      aria-pressed={f.terminalId === shown.terminalId}
                      onClick={() => setShown(f.terminalId)}
                      title={f.label}
                    >
                      {i + 1}. {f.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {hasChat && (
              <div className={styles.floatBar}>
                <SegmentedControl segments={VIEWS} value={view} onChange={showView} label="AI popup view" />
              </div>
            )}
            {fresh ? (
              <div className={styles.floatAnswer}>
                <EmptyState live title="Starting the AI popup…" message="Your Mac is opening it. The answer shows up here." />
              </div>
            ) : view === 'answer' && own ? (
              <div className={styles.floatAnswer} data-testid="phone-float-answer">
                <Suspense fallback={null}>
                  <ChatView
                    key={own.sessionId}
                    session={own}
                    onTerminal={toTerminal}
                    popup={{ rootSessionId: shown.originSessionId, terminalId: shown.terminalId }}
                  />
                  <ChatFooter session={own} onTerminal={toTerminal} />
                </Suspense>
              </div>
            ) : (
              <div className={styles.floatTerminal}>
                <TerminalContainer
                  terminalId={shown.terminalId}
                  ws={ws}
                  showReconnect={false}
                  // The ROOT session, as on the desktop: lookups and float scoping.
                  originSessionId={shown.originSessionId}
                  controlSessionId={ownSessionId}
                  inSheet
                />
              </div>
            )}
          </div>
        )}
      </BottomSheet>
      {!shown && floats.length > 0 && createPortal(
        <button
          type="button"
          className={styles.floatFab}
          onClick={reopen}
          aria-label={floats.length > 1 ? `Open AI popups (${floats.length})` : 'Open AI popup'}
          title={floats.length > 1 ? `${floats.length} AI popups` : floats[0].label}
          data-testid="phone-float-fab"
        >
          <SparkleIcon />
          {floats.length > 1 && <span className={styles.floatFabCount} aria-hidden="true">{floats.length}</span>}
          {anyWorking && <span className={styles.floatFabLive} aria-hidden="true" />}
        </button>,
        document.body,
      )}
      <ConfirmSheet
        open={confirmEnd && !!shown}
        title="End this AI popup?"
        message="Its terminal closes. The answer so far is kept under AI POPUPS."
        confirmLabel="End popup"
        danger
        onConfirm={end}
        onCancel={cancelEnd}
      />
    </>
  );
}
