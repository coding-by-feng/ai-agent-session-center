/**
 * PopoutQueueView — the entire renderer when this window is a floated QUEUE
 * (Electron, or a browser popup; loaded as `/?popout=queue&sessionId=…`).
 *
 * The same "wrap the existing view, add the boot the full <App> would give it"
 * pattern as PopoutProjectView / PopoutSessionView: it renders QueueTab itself,
 * so the float is not a second, drifting copy of the queue UI. What this shell adds:
 *
 *  - the user's settings (theme) and a token-less WebSocket, so the session store
 *    fills and the main window's `queue_update` pushes arrive. They are APPLIED,
 *    not dropped as an echo, because the echo guard is per window — see
 *    `queueStore.applyRemoteQueue`;
 *  - its own ToastContainer. Toasts publish to whichever container is mounted and
 *    only the main window's layout mounts one, so without this every
 *    "Auto-send enabled" in this window would vanish silently;
 *  - the window title, kept in step with the session's name.
 *
 * It deliberately does NOT tick the queue scheduler (that lives in the main
 * window's Dashboard): two schedulers would fire every item twice. Loops and
 * schedules therefore keep firing only while the main window is open.
 */
import { useEffect, useMemo } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useSettingsInit } from '@/hooks/useSettingsInit';
import { useSessionStore } from '@/stores/sessionStore';
import { queuePopoutTitle } from '@/lib/queuePopout';
import ToastContainer from '@/components/ui/ToastContainer';
import QueueTab from './QueueTab';
import styles from '@/styles/modules/PopoutQueueView.module.css';

export default function PopoutQueueView() {
  useSettingsInit();
  // Auth tokens aren't carried into the popout window — localhost Electron runs
  // without auth. (Password-protected setups would need token plumbing here,
  // same caveat as the other popout views.)
  useWebSocket(null);

  const requestedId = useMemo(
    () => new URLSearchParams(window.location.search).get('sessionId') || '',
    [],
  );
  // Select it in THIS window's own store, as PopoutSessionView does. The store moves
  // the selection along when the session is re-keyed — a new session's `term-*`
  // placeholder becoming its real id on the first hook, or a `claude --resume` —
  // which the URL's id cannot. Selecting before the WS snapshot has arrived is fine:
  // the selection simply waits for the session.
  useEffect(() => {
    if (requestedId) useSessionStore.getState().selectSession(requestedId);
  }, [requestedId]);
  const selectedId = useSessionStore((s) => s.selectedSessionId);
  const sessionId = selectedId || requestedId;
  // Until the WS snapshot arrives this is undefined, and so it is again if the
  // session is closed while the window stays open.
  const session = useSessionStore((s) => (sessionId ? s.sessions.get(sessionId) : undefined));

  const title = queuePopoutTitle(session);
  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <div className={styles.root}>
      {session ? (
        <div className={styles.body}>
          <QueueTab
            sessionId={session.sessionId}
            sessionStatus={session.status}
            terminalId={session.terminalId}
            fullHeight
            floating
          />
        </div>
      ) : (
        <p role="status" className={styles.notice}>
          {requestedId
            ? "This session isn't available yet — it may still be loading, or it was closed."
            : 'No session was specified for this window.'}
        </p>
      )}
      <ToastContainer />
    </div>
  );
}
