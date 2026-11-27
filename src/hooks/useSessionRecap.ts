/**
 * useSessionRecap — one rule for a session's AI Summary button (Nov 27 2026), read by the desktop's hover
 * peek (`SessionPromptPeek`) and by the phone's Recent prompts sheet and long-press menu, so their labels
 * and states never drift apart.
 *
 * `POST /api/sessions/:id/recap` answers 202 at once; the run and its answer live on the session
 * (`Session.recap`), so they arrive as a session update, survive the peek or sheet closing and show on
 * every device. Never asked on its own: each run spends tokens on the Mac.
 */
import { useState } from 'react';
import type { Session, SessionRecap } from '@/types/session';
import { useSessionStore } from '@/stores/sessionStore';
import { recapIsStale } from '@/lib/sessionRecap';
import { showToast } from '@/components/ui/ToastContainer';

export type RecapActionKind = 'new' | 'running' | 'error' | 'stale' | 'current';

export interface RecapAction {
  kind: RecapActionKind;
  /** The button's words. */
  label: string;
  /** Its accessible name: what a press does. */
  name: string;
}

/** The one button, named for what a press does now; a current summary can be made again (Nov 23 2026). */
export function recapAction(recap: SessionRecap | undefined, stale: boolean, asking: boolean): RecapAction {
  if (asking || recap?.state === 'running') return { kind: 'running', label: 'Summarizing…', name: 'Summarizing this session' };
  if (!recap) return { kind: 'new', label: 'Summary', name: 'Summarize what this session has done' };
  if (recap.state === 'error') return { kind: 'error', label: 'Try again', name: 'Try the summary again' };
  if (stale) return { kind: 'stale', label: 'Update', name: 'Update the summary' };
  return { kind: 'current', label: 'Resummarize', name: 'Summarize this session again' };
}

/** Whether a kept summary is older than the newest typed prompt. */
export function recapStale(session: Pick<Session, 'promptHistory' | 'recap'>): boolean {
  const recap = session.recap;
  return !!recap && recap.state !== 'running' && recapIsStale(session, recap);
}

/** Ask the Mac for a summary. True when it took the request; a refusal or no answer is said in a toast. */
export async function requestRecap(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/recap`, { method: 'POST' });
    if (res.ok) return true;
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    showToast(typeof body?.error === 'string' ? body.error : 'Couldn’t summarize this session.', 'error');
  } catch {
    showToast('Couldn’t reach the Mac to summarize this session.', 'error');
  }
  return false;
}

export interface SessionRecapState {
  recap: SessionRecap | undefined;
  running: boolean;
  stale: boolean;
  action: RecapAction;
  ask: () => void;
}

/**
 * The live session's summary and its button. Reads the store, not a prop: a card's peek is drawn from a
 * memoised list, and the answer arrives as a session update while it is open.
 */
export function useSessionRecap(session: Session): SessionRecapState {
  const live = useSessionStore((s) => s.sessions.get(session.sessionId)) ?? session;
  const [asking, setAsking] = useState(false);
  const recap = live.recap;
  const stale = recapStale(live);
  const action = recapAction(recap, stale, asking);
  const ask = () => {
    setAsking(true);
    void requestRecap(session.sessionId).finally(() => setAsking(false));
  };
  return { recap, running: action.kind === 'running', stale, action, ask };
}
