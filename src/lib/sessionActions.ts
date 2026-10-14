/**
 * sessionActions — the kill and resume requests behind the desktop's kill dialog
 * and resume button and the phone's session header (AASC-18). Import-free of
 * React; each returns what a toast should say instead of throwing.
 */
import type { ApiResponse, KillSessionResponse } from '@/types';
import { closeManagedTerminal } from '@/lib/terminalTransport';

export interface SessionActionResult {
  ok: boolean;
  message: string;
  /** Something went wrong on the side of a success (a terminal that would not close). */
  warning?: string;
}

type KillReply = KillSessionResponse & ApiResponse & { killedPid?: number | null; stillAlivePid?: number };

/**
 * Kill a session (SIGTERM, then SIGKILL) and close its managed terminal.
 * `terminalId` is the card's terminal, used when the server does not name one.
 */
export async function requestSessionKill(sessionId: string, terminalId?: string | null): Promise<SessionActionResult> {
  try {
    // A JSON body: a body-less POST is a "simple" cross-site request that needs no preflight.
    const resp = await fetch(`/api/sessions/${sessionId}/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const data: KillReply = await resp.json();
    if (!data.ok) {
      // The server verified the process outlived SIGKILL: name the survivor.
      return {
        ok: false,
        message: data.stillAlivePid
          ? `Failed to kill process ${data.stillAlivePid} — it survived SIGKILL`
          : data.error || 'Kill failed',
      };
    }
    const closeId = data.terminalId === undefined ? terminalId : data.terminalId;
    let warning: string | undefined;
    if (closeId) {
      try {
        await closeManagedTerminal(closeId);
      } catch {
        warning = 'Failed to close terminal';
      }
    }
    // "Terminated a real process" vs "no live process found": never claim a phantom kill.
    const killedPid = data.killedPid ?? data.pid ?? null;
    return {
      ok: true,
      message: data.processShared
        ? 'Session terminal closed — shared Codex host left running'
        : killedPid
          ? `PID ${killedPid} terminated`
          : 'Session closed — no running process found',
      warning,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Kill failed' };
  }
}

/** Resume an ended session in its terminal. */
export async function requestSessionResume(sessionId: string, signal?: AbortSignal): Promise<SessionActionResult> {
  const resp = await fetch(`/api/sessions/${sessionId}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
  });
  const data: { ok?: boolean; error?: string } = await resp.json().catch(() => ({}));
  return data.ok
    ? { ok: true, message: 'Resuming Claude session in terminal' }
    : { ok: false, message: data.error || 'Resume failed' };
}
