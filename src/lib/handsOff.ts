/**
 * @module handsOff
 * The browser half of the hands-off switch (server/mcp/http.ts: PUT /api/mcp/sessions/:id/hands-off): the person's
 * way to keep every central from typing into one session, handing it a task or queuing work for it. The server
 * answers 404 to anyone but this Mac (and with central sessions off), and 403 to a central's own calls.
 *
 * No optimistic flip: a switch that says "on" while the server did not take it is a protection that is not
 * there. The caller waits for the answer and shows what the server says.
 */

/** Why a change did not go through: not offered here (404), not allowed (401/403), or it failed (anything else). */
export type HandsOffFailure = 'unavailable' | 'refused' | 'failed';

export type HandsOffResult = { ok: true; handsOff: boolean } | { ok: false; reason: HandsOffFailure };

/** Sets or clears the switch on a session. Never throws. */
export async function putHandsOff(sessionId: string, on: boolean): Promise<HandsOffResult> {
  try {
    const res = await fetch(`/api/mcp/sessions/${encodeURIComponent(sessionId)}/hands-off`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    if (res.ok) {
      // The state the server says it set; the one asked for when its answer says nothing.
      const body = (await res.json().catch(() => null)) as { handsOff?: unknown } | null;
      return { ok: true, handsOff: typeof body?.handsOff === 'boolean' ? body.handsOff : on };
    }
    if (res.status === 404) return { ok: false, reason: 'unavailable' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'refused' };
    return { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** What a failed change says to the person, in one sentence. */
export function handsOffFailureText(reason: HandsOffFailure): string {
  if (reason === 'unavailable') return 'Hands off could not be changed: central sessions are off, or the session is gone.';
  if (reason === 'refused') return 'Hands off could not be changed: this window is not allowed to. Sign in again.';
  return 'Hands off could not be changed. Try again.';
}
