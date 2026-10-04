/**
 * @module liveSession
 * What the LIVE nav tab opens. LIVE shows the session panel for the session
 * you had open; only the panel's minimize (‒) hides it. The other nav tabs
 * close the panel with deselectSession(), so "the session you had open" is
 * remembered separately (sessionStore.lastSelectedSessionId).
 */
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { lastWorkAt } from '@/lib/recentSessions';
import { isListedSession as isListed } from '@/lib/sessionSort';
import type { Session } from '@/types';

/**
 * Pure. The session to open, in order:
 *  1. the one already selected (e.g. minimized) — even if it has ended since,
 *     because you were looking at it;
 *  2. the one you last had open, if it is still listed;
 *  3. the most recently worked one. By real work (`lastWorkAt`), not
 *     `lastActivityAt`, which a workspace restore stamps on every session;
 *     `lastActivityAt` only breaks ties, e.g. before anything has worked.
 * Null when nothing is listed.
 */
export function pickLiveSession(
  sessions: ReadonlyMap<string, Session>,
  selectedId: string | null,
  lastId: string | null,
): string | null {
  const selected = selectedId ? sessions.get(selectedId) : undefined;
  if (selected && !selected.isFloating) return selected.sessionId;

  const last = lastId ? sessions.get(lastId) : undefined;
  if (last && isListed(last)) return last.sessionId;

  let best: Session | null = null;
  for (const s of sessions.values()) {
    if (!isListed(s)) continue;
    if (
      !best
      || lastWorkAt(s) > lastWorkAt(best)
      || (lastWorkAt(s) === lastWorkAt(best) && (s.lastActivityAt ?? 0) > (best.lastActivityAt ?? 0))
    ) {
      best = s;
    }
  }
  return best?.sessionId ?? null;
}

/**
 * Show one session's panel: the LIVE tab's pick, or a card on the LIVE board.
 * Selects only when it differs from the open one: re-selecting the open
 * session would record it as its own "previous" and break the
 * switch-to-previous shortcut. Then brings a minimized panel back.
 */
export function openSessionPanel(sessionId: string): void {
  const { selectedSessionId, selectSession } = useSessionStore.getState();
  if (sessionId !== selectedSessionId) selectSession(sessionId);
  useUiStore.getState().restoreDetailPanel();
}

/**
 * The LIVE tab's click. Opens the panel on `pickLiveSession`'s choice, or
 * leaves the LIVE page as it is when there is nothing to open. Returns whether
 * it opened a session (the LIVE board's tip is retired only then).
 */
export function openLiveSession(): boolean {
  const { sessions, selectedSessionId, lastSelectedSessionId, deselectSession } =
    useSessionStore.getState();
  const pick = pickLiveSession(sessions, selectedSessionId, lastSelectedSessionId);
  if (!pick) {
    deselectSession();
    return false;
  }
  openSessionPanel(pick);
  return true;
}
