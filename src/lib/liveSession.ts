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
import type { Session } from '@/types';

/** Shown in the session lists: not ended, not a floating AI popup. */
function isListed(s: Session): boolean {
  return s.status !== 'ended' && !s.isFloating;
}

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
 * The LIVE tab's click. Opens the panel on `pickLiveSession`'s choice, or
 * leaves the LIVE page as it is when there is nothing to open. Selects only
 * when the choice differs: re-selecting the open session would record it as
 * its own "previous" and break the switch-to-previous shortcut.
 */
export function openLiveSession(): void {
  const { sessions, selectedSessionId, lastSelectedSessionId, selectSession, deselectSession } =
    useSessionStore.getState();
  const pick = pickLiveSession(sessions, selectedSessionId, lastSelectedSessionId);
  if (!pick) {
    deselectSession();
    return;
  }
  if (pick !== selectedSessionId) selectSession(pick);
  useUiStore.getState().restoreDetailPanel();
}
