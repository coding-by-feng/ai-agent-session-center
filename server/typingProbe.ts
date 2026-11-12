/**
 * The server's half of the typing probe (src/lib/typingProbe.ts).
 *
 * A client with the probe on tags one keystroke with `probe: <id>`. The server
 * notes when it arrived, and when that terminal next prints, it tells the same
 * socket how long the PTY write plus the CLI's redraw took — just before the
 * output itself, so the client has the number when the echo lands. Clients that
 * never send `probe` never see a `terminal_probe` message.
 */
import type WebSocket from 'ws';

export const PROBE_EXPIRE_MS = 2000;

interface PendingProbe {
  client: WebSocket;
  id: number;
  at: number;
}

const pending = new Map<string, PendingProbe>();

export function noteInputProbe(terminalId: string, client: WebSocket, id: unknown, now = performance.now()): void {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return;
  pending.set(terminalId, { client, id, at: now });
}

/** Called on a terminal's output: sends any waiting probe reply to its socket. */
export function flushOutputProbe(terminalId: string, now = performance.now()): void {
  if (pending.size === 0) return;
  const probe = pending.get(terminalId);
  if (!probe) return;
  pending.delete(terminalId);
  const serverMs = now - probe.at;
  if (serverMs > PROBE_EXPIRE_MS || probe.client.readyState !== 1) return;
  try {
    probe.client.send(JSON.stringify({ type: 'terminal_probe', terminalId, id: probe.id, serverMs }));
  } catch {
    /* the socket closed between the check and the send */
  }
}

export function forgetProbe(terminalId: string): void {
  pending.delete(terminalId);
}
