/**
 * phoneStatus.ts — a session's status in the phone's words and colours (AASC-38).
 *
 * Plain words (principle 7: "Waiting for you", never "approval" or "baton") and
 * one of six tones the kit colours: amber approval, violet question, blue
 * working, green finished, red interrupted, grey otherwise. An interruption
 * (`session.interruption`) outranks the status: the turn stopped and waits.
 * A context compaction in progress (`session.compacting`) reads "Compacting" over
 * an idle, finished or working status, never over a question, an approval or the end.
 */

import { formatModelLabel } from '@/lib/modelLabel';
import type { Session } from '@/types';

export type PhoneStatusTone = 'approval' | 'question' | 'working' | 'finished' | 'error' | 'idle';

export interface PhoneStatus {
  tone: PhoneStatusTone;
  label: string;
  /** The glyph to draw: a session status (StatusGlyph) or 'interrupted'. */
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

/** How long a compaction may show without its end hook: a lost hook must not leave it up for good. */
export const COMPACTING_STALE_MS = 10 * 60_000;

/** Is the session compacting its context right now (PreCompact seen, no end yet, not stale)? */
export function isCompacting(session: Pick<Session, 'compacting'>, now = Date.now()): boolean {
  const c = session.compacting;
  return !!c && now - c.since < COMPACTING_STALE_MS;
}

const OUTRANK_COMPACTING = new Set(['approval', 'input', 'ended']);

export function phoneStatus(status: string, interrupted = false, compacting = false): PhoneStatus {
  if (interrupted && status !== 'ended') return { tone: 'error', label: 'Interrupted', glyph: 'interrupted' };
  if (compacting && !OUTRANK_COMPACTING.has(status)) return { tone: 'working', label: 'Compacting', glyph: 'working' };
  const known = STATUS[status];
  return known ? { ...known, glyph: status } : { tone: 'idle', label: status || 'Unknown', glyph: 'idle' };
}

type SubtitleFields = Pick<Session, 'status' | 'interruption' | 'model' | 'runtime' | 'effortLevel' | 'compacting'>;

/** A session screen's subtitle: "Working · Opus 5.5 · high" (live model and effort first). */
export function sessionSubtitle(session: SubtitleFields): string {
  const { label } = phoneStatus(session.status, !!session.interruption, isCompacting(session));
  // The model as people say it (`claude-opus-5-5` → `Opus 5.5`); other CLIs' names stay as they are.
  const rawModel = session.runtime?.model || session.model;
  const model = rawModel ? formatModelLabel(rawModel) : rawModel;
  const effort = session.runtime?.effort || session.effortLevel;
  return [label, model, effort].filter(Boolean).join(' · ');
}
