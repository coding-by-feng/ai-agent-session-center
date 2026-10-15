/**
 * phoneStatus.ts — a session's status in the phone's words and colours (AASC-38).
 *
 * Plain words (principle 7: "Waiting for you", never "approval" or "baton") and
 * one of six tones the kit colours: amber approval, violet question, blue
 * working, green finished, red interrupted, grey otherwise. An interruption
 * (`session.interruption`) outranks the status: the turn stopped and waits.
 */

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
  input: { tone: 'question', label: 'Has a question' },
  working: { tone: 'working', label: 'Working' },
  prompting: { tone: 'working', label: 'Starting' },
  waiting: { tone: 'finished', label: 'Finished' },
  idle: { tone: 'idle', label: 'Idle' },
  connecting: { tone: 'idle', label: 'Connecting' },
  ended: { tone: 'idle', label: 'Ended' },
};

export function phoneStatus(status: string, interrupted = false): PhoneStatus {
  if (interrupted && status !== 'ended') return { tone: 'error', label: 'Interrupted', glyph: 'interrupted' };
  const known = STATUS[status];
  return known ? { ...known, glyph: status } : { tone: 'idle', label: status || 'Unknown', glyph: 'idle' };
}

type LineFields = Pick<Session, 'status' | 'interruption' | 'projectName'>;
type SubtitleFields = Pick<Session, 'status' | 'interruption' | 'model' | 'runtime' | 'effortLevel'>;

/** A list row's second line: "Working · agent-manager". */
export function sessionStatusLine(session: LineFields): string {
  const { label } = phoneStatus(session.status, !!session.interruption);
  return [label, session.projectName].filter(Boolean).join(' · ');
}

/** A session screen's subtitle: "Working · Opus 5.5 · high" (live model and effort first). */
export function sessionSubtitle(session: SubtitleFields): string {
  const { label } = phoneStatus(session.status, !!session.interruption);
  const model = session.runtime?.model || session.model;
  const effort = session.runtime?.effort || session.effortLevel;
  return [label, model, effort].filter(Boolean).join(' · ');
}
