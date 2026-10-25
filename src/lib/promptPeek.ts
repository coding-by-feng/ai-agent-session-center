/**
 * @module promptPeek
 * The last few prompts a person typed into a session, newest first: what the
 * session strip's cards and the panel header show on hover, and the phone's
 * session title on a long press (Oct 23 2026), so sessions can be told apart and
 * reviewed without opening them.
 *
 * "Typed" leaves out what the harness put in through the same hook: `<…>` tags
 * (task notifications, command names) and the plain-text injections
 * `classifyInjection` recognises (skill bodies, "Use the `…` skill on the request
 * below", re-invocations, reminders). A queued prompt counts: the user wrote it.
 *
 * Pure, and import-light on purpose: the strip is in the eager chunk.
 */
import { classifyInjection } from '@/lib/commandMessage';
import type { Session } from '@/types';

/** How many prompts a peek lists. */
export const PEEK_PROMPT_COUNT = 5;

/** How long the pointer rests on a session before its peek opens: running down the rail flashes none. */
export const PEEK_HOVER_DELAY_MS = 500;

/** The most characters of a prompt a peek keeps; CSS clamps it to two lines from there. */
export const PEEK_PROMPT_MAX_CHARS = 200;

export interface PeekPrompt {
  text: string;
  /** When it was sent (ms). */
  at: number;
}

function isTyped(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return trimmed !== '' && !trimmed.startsWith('<') && classifyInjection(trimmed) === null;
}

/** One line: runs of whitespace (line breaks included) become one space, cut at the cap. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PEEK_PROMPT_MAX_CHARS ? `${flat.slice(0, PEEK_PROMPT_MAX_CHARS)}…` : flat;
}

/**
 * The newest `count` prompts the user typed, newest first. With no history yet,
 * the prompt in flight (`currentPrompt`) stands in, as on the LIVE board's note.
 */
export function typedPrompts(session: Session, count: number = PEEK_PROMPT_COUNT): PeekPrompt[] {
  const out: PeekPrompt[] = [];
  const history = Array.isArray(session.promptHistory) ? session.promptHistory : [];
  for (let i = history.length - 1; i >= 0 && out.length < count; i--) {
    const entry = history[i];
    if (isTyped(entry?.text)) out.push({ text: oneLine(entry.text), at: entry.timestamp });
  }
  if (history.length === 0 && isTyped(session.currentPrompt)) {
    out.push({ text: oneLine(session.currentPrompt), at: session.lastActivityAt ?? 0 });
  }
  return out;
}

/** How long ago, as the LIVE board says it: `<1m`, `14m`, `3h`, `2d`; empty for a bad time. */
export function promptAge(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
