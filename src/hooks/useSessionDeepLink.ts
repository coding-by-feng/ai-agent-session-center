/**
 * useSessionDeepLink — open the session a notification pointed at (AASC-17).
 *
 * Waits for the first snapshot, then selects the session if this device can see
 * it. A hidden or unknown session does nothing: remote devices never receive
 * hidden sessions, so the store simply doesn't have it, and nothing tells the
 * difference between "hidden" and "no such session".
 *
 * `enabled` false (the new phone app, AASC-39, which maps the link onto its own
 * screens): never acts, now or later, and leaves the URL to the app.
 */
import { useEffect, useRef, useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { parseSessionDeepLink, stripSessionDeepLink } from '@/lib/deepLink';

/** DetailTabs restores its tab from this key when the panel mounts. */
const ACTIVE_TAB_KEY = 'active-tab';

export function useSessionDeepLink(enabled = true): void {
  const [link] = useState(() =>
    typeof window === 'undefined' ? null : parseSessionDeepLink(window.location.search));
  const snapshotReceived = useWsStore((s) => s.snapshotReceived);
  const sessions = useSessionStore((s) => s.sessions);
  const handled = useRef(false);

  useEffect(() => {
    if (!enabled) handled.current = true;
    if (!link || handled.current || !snapshotReceived) return;
    handled.current = true;
    window.history.replaceState(window.history.state, '', stripSessionDeepLink(window.location.href));
    if (!sessions.has(link.sessionId)) return;
    try {
      localStorage.setItem(ACTIVE_TAB_KEY, link.tab);
    } catch {
      /* storage unavailable: the panel opens on its default tab */
    }
    useSessionStore.getState().selectSession(link.sessionId);
  }, [enabled, link, snapshotReceived, sessions]);
}
