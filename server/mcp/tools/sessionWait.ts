// tools/sessionWait.ts — `session_wait`, the one tool of the sessions toolset that waits: it blocks, up to 50
// seconds, until a watched session is in the state the central asked for. Read only.
//
// Scope: `session_wait` listens to ALL broadcasts and keeps only those of the sessions it was asked to watch,
// and only while they are in scope: every update is checked again (`ctx.inScope`, the same rule resolveTarget and
// `scopedSessions()` apply: a room or project central's scope plus the workers the central opened itself, which the
// worker registry (`ctx.workers`) vouches for), a re-key is followed only into a session in scope, a removal
// is reported only for a session still in scope as last seen, and the answer is built from `scopedSessions()`, so a
// session that leaves scope during the wait is neither reported nor described.

import { z } from 'zod';
import type { Session } from '../../../src/types/session.js';
import type { BroadcastMessage } from '../events.js';
import type { ToolContext, ToolDef } from '../registry.js';
import { shortIdOf, toSessionCard } from '../scope.js';
import { defineTool, plural, refOf, resolveTarget, SESSION_REF, visibleRooms } from './define.js';
import { cardRow, cardsBlock, dataCard, isGuessedWait, waitsOnPerson, type CardView } from './views.js';

const UNTIL = ['waiting', 'idle', 'request', 'ended', 'any'] as const;
type Until = (typeof UNTIL)[number];

const UNTIL_WORDS: Record<Until, string> = {
  waiting: 'waiting for a prompt',
  idle: 'idle',
  request: 'waiting on you',
  ended: 'ended',
  any: 'updated',
};

/** Does a session in this state satisfy the condition? (`any` is about the next update, so it always does.) */
function satisfies(until: Until, s: Pick<Session, 'status' | 'pendingRequest'>): boolean {
  switch (until) {
    case 'waiting':
      return s.status === 'waiting';
    case 'idle':
      return s.status === 'idle';
    case 'request':
      return waitsOnPerson(s);
    case 'ended':
      return s.status === 'ended';
    case 'any':
      return true;
  }
}

interface WaitHit {
  how: 'update' | 'removed';
  id: string;
}

/** The session a `session_update` broadcast carries, or null for a message that is not one. */
function updatedSession(m: BroadcastMessage): Session | null {
  const s = m.session;
  if (typeof s !== 'object' || s === null) return null;
  return typeof (s as { sessionId?: unknown }).sessionId === 'string' ? (s as Session) : null;
}

/**
 * The broadcast matcher for one wait. `watched` maps each id it watches (in scope when the call began) to the
 * session as last seen. Every update of a watched session is checked against the scope again: one that has
 * left it is not ours to report, whatever it says. A removal is reported only for a session that, as last
 * seen, is still in scope: one that left (by an update, or by being taken out of the room with no update at
 * all) is not followed to its end. A re-key (`replacesId`) of a watched session adds its new id, but only
 * while the new card is in scope. Everything else is ignored: the hub hands this every broadcast AASC sends.
 */
function matchBroadcast(until: Until, watched: Map<string, Session>, ctx: ToolContext): (m: BroadcastMessage) => WaitHit | null {
  return (m) => {
    if (m.type === 'session_removed') {
      const last = typeof m.sessionId === 'string' ? watched.get(m.sessionId) : undefined;
      const wantsRemoval = until === 'ended' || until === 'any';
      return last !== undefined && wantsRemoval && ctx.inScope(last) ? { how: 'removed', id: last.sessionId } : null;
    }
    if (m.type !== 'session_update') return null;
    const s = updatedSession(m);
    if (s === null) return null;
    const known = watched.has(s.sessionId);
    const prior = typeof s.replacesId === 'string' ? s.replacesId : null;
    if (!known && (prior === null || !watched.has(prior))) return null;
    if (!ctx.inScope(s)) {
      if (known) watched.set(s.sessionId, s);
      return null;
    }
    watched.set(s.sessionId, s);
    return satisfies(until, s) ? { how: 'update', id: s.sessionId } : null;
  };
}

interface WaitedSession {
  id: string;
  shortId: string;
  status: string;
  needsYou: boolean;
}

/**
 * Where each watched session stands now, from the sessions in scope. One that is not there (removed, or moved
 * out of scope: the two look alike from here, by design) is `removed`, and nothing else is said of it.
 */
function standing(ctx: ToolContext, watched: Iterable<string>): WaitedSession[] {
  const present = new Map(ctx.scopedSessions().map((s) => [s.sessionId, s]));
  return [...watched].map((id) => {
    const s = present.get(id);
    return { id, shortId: shortIdOf(id), status: s?.status ?? 'removed', needsYou: s ? waitsOnPerson(s) : false };
  });
}

function waitSummary(
  how: WaitHit['how'] | 'already' | null,
  until: Until,
  seconds: number,
  matched: readonly CardView[],
  now: WaitedSession[],
  clock: number,
  ref: (sessionId: string) => string,
): string {
  if (how === null) {
    const state = now.map((w) => `${ref(w.id)} ${w.status}`).join(', ');
    return `Timed out after ${seconds} s with no change to ${until === 'any' ? 'any' : `"${until}" in any`} of them. Now: ${state}.`;
  }
  const lead =
    how === 'already'
      ? `${plural(matched.length, 'session')} already ${UNTIL_WORDS[until]}:`
      : how === 'removed'
        ? 'A watched session was removed:'
        : `A watched session is ${UNTIL_WORDS[until]}:`;
  return `${lead}\n${cardsBlock(matched.map((v) => cardRow(v, clock, ref(v.id), v.guessedWait)))}`;
}

/**
 * The card of a session in scope, or a bare one for a session that is not there to describe: removed, or no
 * longer in scope. The bare card names only the id the caller already holds.
 */
function matchedView(ctx: ToolContext, id: string): CardView {
  const rooms = visibleRooms(ctx);
  const s = ctx.scopedSessions().find((x) => x.sessionId === id);
  if (s === undefined) {
    return {
      id, shortId: shortIdOf(id), title: '', status: 'removed', cli: null, project: null, roomId: null, model: null,
      effort: null, contextPct: null, needsYou: false, queueCount: 0, isCentral: false, lastActivityAt: ctx.now(),
      started: false,
      roomName: null, guessedWait: false,
    };
  }
  const card = toSessionCard(s, rooms);
  return { ...card, roomName: rooms.find((r) => r.id === card.roomId)?.name ?? null, guessedWait: isGuessedWait(s) };
}

const sessionWait = defineTool({
  name: 'session_wait',
  toolset: 'sessions',
  title: 'Wait for sessions',
  description:
    'Waits, up to 50 seconds, until one of up to 8 sessions is waiting for a prompt, idle, waiting on you ' +
    '(an open request, or status approval/input), ended, or simply updated (until any). If one already is, it ' +
    'answers at once; pass ignoreCurrent to wait for a new change instead (for example right after you sent ' +
    'a prompt). On a timeout it says where each session stands, and you can wait again.',
  risk: 'read',
  phase: 1,
  input: {
    ids: z.array(SESSION_REF).min(1).max(8).describe('The sessions to watch (ids or short ids).'),
    until: z.enum(UNTIL).default('waiting').describe('What to wait for.'),
    timeoutSeconds: z.number().int().min(1).max(50).default(30).describe('How long to wait, 1 to 50 seconds.'),
    ignoreCurrent: z.boolean().default(false).describe('Ignore what the sessions are doing now; wait for a new update.'),
  },
  async run(args, ctx) {
    const started = ctx.now();
    const targets = [...new Map(args.ids.map((ref) => resolveTarget(ctx, ref)).map((s) => [s.sessionId, s])).values()];
    const watched = new Map(targets.map((s) => [s.sessionId, s]));
    const finish = (how: WaitHit['how'] | 'already' | null, ids: string[]) => {
      const matched = ids.map((id) => matchedView(ctx, id));
      const now = standing(ctx, watched.keys());
      return {
        data: {
          timedOut: how === null,
          until: args.until,
          how,
          waitedMs: ctx.now() - started,
          matched: matched.map(dataCard),
          watching: now,
        },
        summary: waitSummary(how, args.until, args.timeoutSeconds, matched, now, ctx.now(), refOf(ctx)),
      };
    };
    if (!args.ignoreCurrent && args.until !== 'any') {
      const already = targets.filter((s) => satisfies(args.until, s)).map((s) => s.sessionId);
      if (already.length > 0) return finish('already', already);
    }
    const hit = await ctx.events.waitFor(matchBroadcast(args.until, watched, ctx), args.timeoutSeconds * 1_000, ctx.signal);
    return hit === null ? finish(null, []) : finish(hit.how, [hit.id]);
  },
});

export const waitTools: readonly ToolDef[] = [sessionWait];
