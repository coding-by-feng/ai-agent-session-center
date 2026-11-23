// turnGate.ts — no spoken update over the person (Nov 22 2026).
//
// Everything the Mac makes the voice say goes out as `session.commentary.append`: the Voice central's answer to a
// question, and "X finished" / "X needs you". Sent the moment it was ready, it could cut into a sentence the person
// was still saying. The gate holds it while the person's turn goes on and lets it out once they have been quiet for
// QUIET_MS, judged from the input-transcript deltas (the only sign of speech the sideband gives).
//
//   heard(at)        the person said something (an input-transcript delta arrived)
//   push(update, at) an update is ready: back at once when the person is quiet, else held
//   due(at)          what may be said now: held answers first, in order, each for its own delegation, then one
//                    status line merged from every held change (each title once, its newest state), then held notes
//                    (a finished session's result, a confirmed setting), in order
//
// QUIET_MS is the transcript's own turn pause (transcriptLog.ts PAUSE_MS): a hesitation shorter than that stays
// one turn. Nothing held is ever dropped by time; only clear() (the call ended) drops it. Pure: the call owns the timer.

import { PAUSE_MS } from './transcriptLog.js';

/** How long the person must be quiet before a held update is said. */
export const QUIET_MS = PAUSE_MS;

export type TurnUpdate =
  | { kind: 'answer'; delegationId: string; content: string }
  /** Something AASC tells without being asked: a finished session's result, a setting the CLI confirmed. */
  | { kind: 'note'; content: string }
  | { kind: 'status'; finished: readonly string[]; needsUser: readonly string[] };

export interface SaidUpdate {
  delegationId: string | null;
  content: string;
}

export interface TurnGate {
  heard(at: number): void;
  push(update: TurnUpdate, at: number): SaidUpdate[];
  due(at: number): SaidUpdate[];
  /** When the held updates may next be due; null when nothing is held. */
  nextCheckAt(): number | null;
  pending(): number;
  clear(): void;
}

const quoted = (titles: readonly string[]): string => titles.map((t) => `"${t}"`).join(', ');

/** The spoken status line ("AASC update: …"); '' when there is nothing to say. */
export function statusLine(finished: readonly string[], needsUser: readonly string[]): string {
  const said: string[] = [];
  if (finished.length > 0) said.push(`${quoted(finished)} ${finished.length === 1 ? 'has' : 'have'} finished.`);
  if (needsUser.length > 0) said.push(`${quoted(needsUser)} ${needsUser.length === 1 ? 'needs' : 'need'} the user's answer.`);
  return said.length > 0 ? `AASC update: ${said.join(' ')}` : '';
}

function merge(statuses: ReadonlyArray<Extract<TurnUpdate, { kind: 'status' }>>): SaidUpdate[] {
  // Map keeps first-seen order; a later state replaces an earlier one for the same title.
  const latest = new Map<string, 'finished' | 'needs'>();
  for (const s of statuses) {
    for (const t of s.finished) { latest.delete(t); latest.set(t, 'finished'); }
    for (const t of s.needsUser) { latest.delete(t); latest.set(t, 'needs'); }
  }
  const entries = [...latest.entries()];
  const line = statusLine(entries.filter(([, v]) => v === 'finished').map(([t]) => t), entries.filter(([, v]) => v === 'needs').map(([t]) => t));
  return line ? [{ delegationId: null, content: line }] : [];
}

function release(held: readonly TurnUpdate[]): SaidUpdate[] {
  const answers = held.flatMap((u) => (u.kind === 'answer' ? [{ delegationId: u.delegationId, content: u.content }] : []));
  const notes = held.flatMap((u) => (u.kind === 'note' ? [{ delegationId: null, content: u.content }] : []));
  const statuses = held.filter((u): u is Extract<TurnUpdate, { kind: 'status' }> => u.kind === 'status');
  return [...answers, ...merge(statuses), ...notes];
}

export function createTurnGate(quietMs: number = QUIET_MS): TurnGate {
  let lastHeard: number | null = null;
  let held: TurnUpdate[] = [];
  const talking = (at: number): boolean => lastHeard !== null && at - lastHeard < quietMs;

  const due = (at: number): SaidUpdate[] => {
    if (held.length === 0 || talking(at)) return [];
    const out = release(held);
    held = [];
    return out;
  };

  return {
    heard(at) {
      lastHeard = lastHeard === null ? at : Math.max(lastHeard, at);
    },
    push(update, at) {
      held = [...held, update];
      return due(at);
    },
    due,
    nextCheckAt: () => (held.length === 0 ? null : (lastHeard ?? 0) + quietMs),
    pending: () => held.length,
    clear() {
      held = [];
    },
  };
}
