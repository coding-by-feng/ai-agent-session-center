/**
 * useTerminalPeek — a terminal's last lines as plain text for the chat's peek
 * (AASC-41), without an xterm instance.
 *
 * Subscribes this device's socket to the terminal's stream (`terminal_subscribe`:
 * the server replays the scrollback, then streams), feeds it to a PeekScreen
 * (lib/chat/peekScreen.ts) and hands back the last lines, at most four times a
 * second.
 *
 * `subscribed` (the chat is mounted and on top) decides the subscription; `shown`
 * (the strip is up) only decides whether the lines are handed back. Every new
 * subscription makes the server resend its whole replay ring (2 MB by default, up
 * to 32 MB, more once encoded), so a turn flipping the session between working and
 * waiting must never resubscribe: the stream keeps feeding the PeekScreen while the
 * strip is down, and the lines are current the moment it comes back.
 *
 * Leaving unsubscribes only this socket (`terminal_disconnect`): other devices keep
 * their terminal (wsClients is a set, multi-device-presence.md). The full terminal
 * mounts only on the Terminal segment, never at the same time as the chat.
 */
import { useEffect, useRef, useState } from 'react';
import { useWsStore } from '@/stores/wsStore';
import { PeekScreen } from '@/lib/chat/peekScreen';

const FLUSH_MS = 250;
/** The empty chat's terminal shows up to 40 lines; the working strip's peek, its last 3 or 12. */
const KEEP_LINES = 40;

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function useTerminalPeek(terminalId: string | null, subscribed: boolean, shown: boolean): string[] {
  const ws = useWsStore((s) => s.client?.getRawSocket() ?? null);
  const connected = useWsStore((s) => s.connected);
  const [lines, setLines] = useState<string[]>([]);
  const shownRef = useRef(shown);
  /** Hand the current lines back soon (set while subscribed). */
  const refresh = useRef<(() => void) | null>(null);

  useEffect(() => {
    shownRef.current = shown;
    if (shown) refresh.current?.();
  }, [shown]);

  useEffect(() => {
    if (!subscribed || !terminalId || !ws || !connected || ws.readyState !== 1) return;
    let screen = new PeekScreen();
    const decoder = new TextDecoder();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (shownRef.current) setLines(screen.lastLines(KEEP_LINES));
    };
    const schedule = (ms: number) => {
      if (!timer) timer = setTimeout(flush, ms);
    };
    refresh.current = () => schedule(0);
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
      } else if (msg.type === 'terminal_cleared') {
        screen = new PeekScreen();
      } else {
        return;
      }
      // While the strip is down the screen keeps up, but nothing re-renders.
      if (shownRef.current) schedule(FLUSH_MS);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ type: 'terminal_subscribe', terminalId }));
    return () => {
      refresh.current = null;
      ws.removeEventListener('message', onMessage);
      if (timer) clearTimeout(timer);
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'terminal_disconnect', terminalId }));
    };
  }, [subscribed, terminalId, ws, connected]);

  return subscribed && shown ? lines : [];
}
