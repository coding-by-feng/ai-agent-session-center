/**
 * SessionTerminal — the session screen's Terminal segment (AASC-39; AASC-45
 * makes it phone-native: fit / pan, pinch, sticky Ctrl).
 *
 * Today's phone terminal stack, as DetailPanel mounts it on a phone:
 * TerminalContainer in viewer mode with PhoneTerminalInput under it (compose box,
 * key bar, and the control banner when another device drives). The phone never
 * resizes the shared PTY (`mayDrivePtyGeometry` is false on phones), never pops
 * out, and never opens a plain shell on the Mac.
 */
import { useCallback } from 'react';
import type { Session } from '@/types';
import TerminalContainer from '@/components/terminal/TerminalContainer';
import { useWsStore } from '@/stores/wsStore';
import { copySession } from '@/lib/sessionCopy';
import { detectCli } from '@/lib/cliDetect';
import styles from '@/styles/modules/mobile/Screens.module.css';

export default function SessionTerminal({ session }: { session: Session }) {
  // Re-read on every store change: the client is stable but swaps its socket on a
  // reconnect (and flips `connected`), so a cached socket would freeze the terminal.
  const ws = useWsStore((s) => s.client?.getRawSocket() ?? null);

  const { sessionId } = session;
  const terminalId = session.terminalId ?? null;
  const canReconnect = session.source === 'ssh' || !!session.startupCommand;
  const cli = detectCli(session);

  const reconnect = useCallback(() => {
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/reconnect-terminal`, { method: 'POST' }).catch(() => {});
  }, [sessionId]);
  const fork = useCallback(() => { void copySession(sessionId, 'fork'); }, [sessionId]);
  const clone = useCallback(() => { void copySession(sessionId, 'clone'); }, [sessionId]);

  return (
    <div className={styles.terminal} data-testid="phone-session-terminal">
      <TerminalContainer
        terminalId={terminalId}
        ws={ws}
        showReconnect={canReconnect && session.status === 'ended' && !terminalId}
        onReconnect={canReconnect ? reconnect : undefined}
        onFork={cli === 'claude' || cli === 'codex' ? fork : undefined}
        onClone={clone}
        projectPath={session.projectPath}
        originSessionId={sessionId}
        controlSessionId={sessionId}
      />
    </div>
  );
}
