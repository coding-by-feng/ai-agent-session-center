/**
 * @module restartSession
 * The client half of the terminal toolbar's "Restart session": quit the agent in
 * this card's terminal and reconnect the same session (same id, title, model,
 * effort) in a fresh one. The work is POST /api/sessions/:id/restart-terminal
 * (server/sessionRestart.ts); this module decides when to ask first and turns the
 * reply into something a toast can say. Import-free of React and the stores so
 * the host panel and the tests share it.
 */

/** Statuses where a restart would kill a turn, a tool call or a question the user has not answered. */
const BUSY_STATUSES: ReadonlySet<string> = new Set(['prompting', 'working', 'approval', 'input']);

/** True when restarting now would throw away work in progress, so the user is asked first. */
export function restartNeedsConfirm(status: string | undefined): boolean {
  return status !== undefined && BUSY_STATUSES.has(status);
}

/** The question asked before restarting a busy session. `label` is the card's display name. */
export function restartConfirmMessage(label: string): string {
  return `Restart "${label}"?\n\nIt is running right now: the current turn is stopped. `
    + 'The session is resumed in a new terminal with the same name, model and effort.';
}

export type RestartResult =
  | { ok: true; terminalId: string | null }
  | { ok: false; error: string };

interface RestartReply {
  ok?: boolean;
  error?: string;
  terminalId?: string;
}

/** Ask the server to restart the session's terminal. Never throws: a failure comes back as `{ ok: false }`. */
export async function requestSessionRestart(sessionId: string): Promise<RestartResult> {
  try {
    // A JSON body, like kill's: a body-less POST is a "simple" cross-site request
    // that needs no preflight, so any page the user visits could fire it.
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restart-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const body: RestartReply | null = await res.json().catch(() => null);
    if (!res.ok || body?.ok === false) {
      return { ok: false, error: body?.error || `Restart failed (HTTP ${res.status})` };
    }
    return { ok: true, terminalId: body?.terminalId ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Restart failed' };
  }
}
