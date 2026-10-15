/**
 * useTerminalPeek — a terminal's last lines as plain text for the chat's peek
 * (AASC-41), without an xterm instance.
 *
 * Subscribes this device's socket to the terminal's stream (`terminal_subscribe`:
 * the server replays the scrollback, then streams), feeds it to a PeekScreen
 * (lib/chat/peekScreen.ts) and hands back the last lines, at most four times a
 * second. Leaving unsubscribes only this socket (`terminal_disconnect`): other
 * devices keep their terminal (wsClients is a set, multi-device-presence.md).
 * The full terminal mounts only on the Terminal segment, never at the same time.
 */
import { useEffect, useState } from 'react';
import { useWsStore } from '@/stores/wsStore';
import { PeekScreen } from '@/lib/chat/peekScreen';

const FLUSH_MS = 250;
const KEEP_LINES = 12;

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function useTerminalPeek(terminalId: string | null, enabled: boolean): string[] {
  const ws = useWsStore((s) => s.client?.getRawSocket() ?? null);
  const connected = useWsStore((s) => s.connected);
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled || !terminalId || !ws || !connected || ws.readyState !== 1) return;
    let screen = new PeekScreen();
    const decoder = new TextDecoder();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      setLines(screen.lastLines(KEEP_LINES));
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(flush, FLUSH_MS);
    };
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string' || !event.data.includes(terminalId)) return;
      let msg: { type?: unknown; terminalId?: unknown; data?: unknown };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.terminalId !== terminalId) return;
      if (msg.type === 'terminal_output' && typeof msg.data === 'string') {
        try {
          screen.write(decoder.decode(base64Bytes(msg.data), { stream: true }));
        } catch {
          return; // not base64: nothing to show
        }
        schedule();
      } else if (msg.type === 'terminal_cleared') {
        screen = new PeekScreen();
        schedule();
      }
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ type: 'terminal_subscribe', terminalId }));
    return () => {
      ws.removeEventListener('message', onMessage);
      if (timer) clearTimeout(timer);
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'terminal_disconnect', terminalId }));
    };
  }, [enabled, terminalId, ws, connected]);

  return enabled ? lines : [];
}
