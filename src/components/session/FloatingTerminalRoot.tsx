/**
 * FloatingTerminalRoot — renders the floating terminal popups that belong to
 * the *currently selected* main session.
 *
 * Mounted once in AppLayout. Subscribes to floatingSessionsStore (all open
 * floats) and to the selected session. Each float records the `originSessionId`
 * that spawned it; only the floats whose origin is currently selected are
 * rendered. The rest stay in the store with their PTYs alive server-side, so
 * switching back to their origin session re-mounts them and the terminal buffer
 * is replayed on re-attach (see useTerminal.attach).
 */
import { useEffect } from 'react';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { useSessionStore } from '@/stores/sessionStore';
import FloatingTerminalPanel from './FloatingTerminalPanel';

export default function FloatingTerminalRoot() {
  const floats = useFloatingSessionsStore((s) => s.floats);
  const poppedOut = useFloatingSessionsStore((s) => s.poppedOut);
  const close = useFloatingSessionsStore((s) => s.close);
  const setPoppedOut = useFloatingSessionsStore((s) => s.setPoppedOut);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);

  // Re-dock a float (show its in-app panel again) when its popped-out native
  // window is closed.
  useEffect(() => {
    return window.electronAPI?.onPopoutClosed?.((terminalId) => setPoppedOut(terminalId, false));
  }, [setPoppedOut]);

  // Popups belong to the session that spawned them. With nothing selected, none
  // are shown. A popped-out float lives in its own native window, so it's hidden
  // here (its store entry + PTY stay alive for re-dock).
  const visible = selectedSessionId
    ? floats.filter((f) => f.originSessionId === selectedSessionId && !poppedOut.includes(f.terminalId))
    : [];

  return (
    <>
      {visible.map((f, i) => (
        <FloatingTerminalPanel
          key={f.terminalId}
          terminalId={f.terminalId}
          label={f.label}
          // Cascade offset uses the index within the *visible* subset so a lone
          // popup renders at the default top-left, not pushed down by hidden ones.
          stackIndex={i}
          originSessionId={f.originSessionId}
          onClose={() => close(f.terminalId)}
        />
      ))}
    </>
  );
}
