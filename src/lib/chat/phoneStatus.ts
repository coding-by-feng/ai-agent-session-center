/**
 * phoneStatus.ts — a session's status in the phone's words and colours (AASC-38).
 *
 * Plain words (principle 7: "Waiting for you", never "approval" or "baton") and
 * one of six tones the kit colours: amber approval, violet question, blue
 * working, green finished, red interrupted, grey otherwise. An interruption
 * (`session.interruption`) outranks the status: the turn stopped and waits.
 * A context compaction in progress (`session.compacting`, see sessionStatusStyle) reads
 * "Compacting" over an idle, finished or working status, never over a question, an approval or the end.
 * A finished turn whose Stop hooks still run (`isFinishingUp`) reads "Finishing up", not "Finished":
 * a prompt sent then waits until they finish (Nov 6 2026).
 */

import { formatModelLabel } from '@/lib/modelLabel';
import { BACKGROUND, COMPACTING, FINISHING_UP_LABEL, LIMIT, OUTRANK_COMPACTING, isCompacting, isFinishingUp, isUsageLimited, showsBackgroundWork, statusLabel } from '@/lib/sessionStatusStyle';
import type { Session } from '@/types';

export { COMPACTING_STALE_MS, STOP_HOOKS_STALE_MS, isCompacting, isFinishingUp } from '@/lib/sessionStatusStyle';

export type PhoneStatusTone = 'approval' | 'question' | 'working' | 'finished' | 'error' | 'idle';

export interface PhoneStatus {
  tone: PhoneStatusTone;
  label: string;
  /** The glyph to draw: a session status (StatusGlyph, 'limit' included) or 'interrupted'. */
  glyph: string;
}

const STATUS: Record<string, { tone: PhoneStatusTone; label: string }> = {
  approval: { tone: 'approval', label: 'Waiting for approval' },
  // Not a status: the P reminder (sessionStatusStyle.displayStatus) a row passes in its place.
  proceed: { tone: 'approval', label: 'Asks you to proceed' },
  input: { tone: 'question', label: 'Has a question' },
  working: { tone: 'working', label: 'Working' },
  prompting: { tone: 'working', label: 'Starting' },
  waiting: { tone: 'finished', label: 'Finished' },
  idle: { tone: 'idle', label: 'Idle' },
  connecting: { tone: 'idle', label: 'Connecting' },
  ended: { tone: 'idle', label: 'Ended' },
};

/**
 * How a session's turn was stopped: `'limit'` on the plan's usage limit, `true` on any other fault, else
 * false. A usage limit never marks a session that waits on an approval or a question, or has ended
 * (`isUsageLimited`): that status stands, as on the desktop.
 */
export function faultMark(session: { status?: string; interruption?: { kind: string; line: string; detectedAt: number } | null }): boolean | 'limit' {
  if (!session.interruption) return false;
  if (session.interruption.kind !== 'usage_limit') return true;
  return isUsageLimited({ status: session.status ?? '', interruption: session.interruption }) ? 'limit' : false;
}

const LIMITED: PhoneStatus = { tone: 'error', label: statusLabel(LIMIT), glyph: LIMIT };

/** `interrupted`: `faultMark(session)` (a plain boolean still reads as "some fault"). */
export function phoneStatus(status: string, interrupted: boolean | 'limit' = false, compacting = false, finishing = false): PhoneStatus {
  // The usage limit, handed as the display status (displayStatus) or as the fault mark: never over the end.
  if (status === LIMIT || (interrupted === 'limit' && status !== 'ended')) return LIMITED;
  if (interrupted && status !== 'ended') return { tone: 'error', label: 'Interrupted', glyph: 'interrupted' };
  // `status` may already be the display status (a row or a ring handed `displayStatus()`).
  if (status === COMPACTING || (compacting && !OUTRANK_COMPACTING.has(status))) {
    return { tone: 'working', label: 'Compacting', glyph: 'working' };
  }
  if (finishing && status === 'waiting') return { tone: 'working', label: FINISHING_UP_LABEL, glyph: 'working' };
  // The display status of a finished turn whose background shells still run (Nov 17 2026).
  if (status === BACKGROUND) return { tone: 'working', label: statusLabel(BACKGROUND), glyph: 'working' };
  const known = STATUS[status];
  return known ? { ...known, glyph: status } : { tone: 'idle', label: status || 'Unknown', glyph: 'idle' };
}

type SubtitleFields = Pick<Session, 'status' | 'interruption' | 'model' | 'runtime' | 'effortLevel' | 'compacting' | 'stopHooksSince' | 'startHeard' | 'backgroundTaskCount' | 'backgroundTasks'> & { lastActivityAt?: number };

/** A session screen's subtitle: "Working · Opus 5.5 · high" (live model and effort first). */
export function sessionSubtitle(session: SubtitleFields): string {
  // Only a start the Mac never confirmed; a card with no terminal relaunches when you send to it.
  const recovery = session.status !== 'ended' && session.status !== 'connecting' && session.startHeard === false;
  const label = recovery ? 'Needs recovery'
    : phoneStatus(showsBackgroundWork(session) ? BACKGROUND : session.status, faultMark(session), isCompacting(session), isFinishingUp(session)).label;
  // The model as people say it (`claude-opus-5-5` → `Opus 5.5`); other CLIs' names stay as they are.
  const rawModel = session.runtime?.model || session.model;
  const model = rawModel ? formatModelLabel(rawModel) : rawModel;
  const effort = session.runtime?.effort || session.effortLevel;
  return [label, model, effort].filter(Boolean).join(' · ');
}
