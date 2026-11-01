/**
 * Feeds the iOS Live Activity (mobile/ios/AascLiveActivity) from this page's session list.
 *
 * The Mac page, not the shell, is what runs while a Mac is open, so it posts the card to the
 * native `aascLiveActivity` message handler. The app accepts it only from a paired Mac's origin
 * and adds the Mac's name itself. Nothing is sent before the first snapshot: the store starts empty,
 * and an empty card ends the activity, so every page load would end the card and start a new one.
 * Identical cards are skipped and posts are spaced at least LIVE_ACTIVITY_GAP_MS apart (the last
 * change always goes out). Elsewhere (Android, a browser) there is no handler and this does nothing.
 */
import { useEffect } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { buildLiveActivityCard, sameLiveActivityCard, type LiveActivityCard } from '@/lib/liveActivityCard';

export const LIVE_ACTIVITY_GAP_MS = 2_000;

interface MessageHandler { postMessage(body: unknown): void }

function liveActivityHandler(): MessageHandler | null {
  const w = window as unknown as { webkit?: { messageHandlers?: Record<string, MessageHandler | undefined> } };
  return w.webkit?.messageHandlers?.aascLiveActivity ?? null;
}

export function useLiveActivityFeed(): void {
  useEffect(() => {
    const handler = liveActivityHandler();
    if (!handler) return;
    let sent: LiveActivityCard | null = null;
    let sentAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const post = (force = false) => {
      timer = null;
      if (!useWsStore.getState().snapshotReceived) return;
      const card = buildLiveActivityCard(useSessionStore.getState().sessions.values());
      if (!force && sameLiveActivityCard(sent, card)) return;
      try {
        handler.postMessage(card);
        sent = card;
        sentAt = Date.now();
      } catch {
        // The handler went away with the page: nothing to update.
      }
    };
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(post, Math.max(0, sentAt + LIVE_ACTIVITY_GAP_MS - Date.now()));
    };
    // Back from the background: the card may have gone stale, so send it again even if unchanged.
    const onVisible = () => { if (document.visibilityState === 'visible') post(true); };

    post();
    const unsubscribe = useSessionStore.subscribe((state, prev) => {
      if (state.sessions !== prev.sessions) schedule();
    });
    const unsubscribeWs = useWsStore.subscribe((state, prev) => {
      if (state.snapshotReceived && !prev.snapshotReceived) schedule();
    });
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsubscribe();
      unsubscribeWs();
      document.removeEventListener('visibilitychange', onVisible);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
