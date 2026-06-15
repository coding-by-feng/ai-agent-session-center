/**
 * PopoutTerminalView — the entire renderer when this window is a popped-out
 * floating terminal (Electron, loaded as `/?popout=terminal&terminalId=…`).
 *
 * It connects its own WebSocket + settings and hosts a single TerminalContainer
 * attached to the existing server PTY by id. While a float is popped out its
 * in-app panel is hidden, so this window is the sole WS subscriber; closing it
 * re-docks the in-app float (FloatingTerminalRoot listens for popout:closed).
 */
import { useMemo } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useSettingsInit } from '@/hooks/useSettingsInit';
import { useWsStore } from '@/stores/wsStore';
import TerminalContainer from '@/components/terminal/TerminalContainer';
import FileOpenChooser from '@/components/session/FileOpenChooser';
import styles from '@/styles/modules/PopoutTerminalView.module.css';

interface Props {
  terminalId: string;
  originSessionId?: string;
  label?: string;
}

export default function PopoutTerminalView({ terminalId, originSessionId, label }: Props) {
  useSettingsInit();
  // Auth tokens aren't carried into the popout window — localhost Electron runs
  // without auth. (Password-protected setups would need token plumbing here.)
  useWebSocket(null);
  const client = useWsStore((s) => s.client);
  // Re-derive the raw socket whenever the connection re-establishes. The
  // WsClient instance is stable across reconnects (it swaps its internal
  // socket in place), so memoizing on `client` alone pins every WS-transport
  // terminal to the dead pre-reconnect socket — output stops and input is
  // swallowed with no error. `connected` flips on each reconnect, forcing a
  // fresh getRawSocket() that useTerminal's [ws] effect then re-subscribes on.
  const connected = useWsStore((s) => s.connected);
  const ws = useMemo(() => client?.getRawSocket() ?? null, [client, connected]);

  return (
    <div className={styles.root}>
      {label && <div className={styles.titlebar} title={label}>{label}</div>}
      <div className={styles.body}>
        <TerminalContainer
          terminalId={terminalId}
          ws={ws}
          showReconnect={false}
          originSessionId={originSessionId ?? null}
        />
      </div>
      <FileOpenChooser />
    </div>
  );
}
