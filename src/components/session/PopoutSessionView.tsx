/**
 * PopoutSessionView — the entire renderer when this window is a popped-out
 * SESSION (Electron, loaded as `/?popout=session&sessionId=…`).
 *
 * Unlike PopoutTerminalView (bare terminal only), this wraps the FULL session
 * experience — `DetailPanel` with every DetailTabs tab (Project, Terminal,
 * Commands, Conversation, AI Popups, Notes, Queue) — by selecting the session in
 * this window's own store and letting `DetailPanel` render exactly as it does
 * in the main app. That reuse is deliberate: it's the same "wrap the existing
 * standalone view + inject settings/WS init" pattern PopoutProjectView already
 * established, rather than a second, drifting copy of DetailPanel's tab logic.
 *
 * The one thing genuinely new here is the return path. Neither existing popout
 * has a "back to main" affordance — closing them just closes them. A whole
 * session is different: the ask is a round trip (main → popout → back to the
 * session list), so this window needs an explicit way to hand control back,
 * which is why `returnToMain` is layered on top rather than reusing
 * `window:open-terminal`'s `popout:closed` (that channel means "re-dock the
 * in-app float", a concept that doesn't exist for a whole-session popout).
 */
import { useEffect, useMemo } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useSettingsInit } from '@/hooks/useSettingsInit';
import { useSessionStore } from '@/stores/sessionStore';
import DetailPanel from './DetailPanel';
import FileOpenChooser from './FileOpenChooser';
import styles from '@/styles/modules/PopoutSessionView.module.css';

export default function PopoutSessionView() {
  useSettingsInit();
  // Auth tokens aren't carried into the popout window — localhost Electron runs
  // without auth. (Password-protected setups would need token plumbing here,
  // same caveat as the other two popout views.)
  useWebSocket(null);

  const sessionId = useMemo(
    () => new URLSearchParams(window.location.search).get('sessionId') || '',
    [],
  );

  // Select the session in THIS window's own store. If the WS snapshot hasn't
  // arrived yet, `sessions` is still empty — DetailPanel already renders
  // `display: none` until its session resolves, so this just waits, no special
  // "loading" state needed here.
  useEffect(() => {
    if (sessionId) useSessionStore.getState().selectSession(sessionId);
  }, [sessionId]);

  const handleReturnToMain = (): void => {
    void window.electronAPI?.returnToMain?.();
  };

  return (
    <>
      <button
        type="button"
        className={styles.backBtn}
        onClick={handleReturnToMain}
        title="Back to main window"
        aria-label="Back to main window and session list"
      >
        <span aria-hidden="true">⏎</span> Back to main
      </button>
      <DetailPanel />
      <FileOpenChooser />
    </>
  );
}
