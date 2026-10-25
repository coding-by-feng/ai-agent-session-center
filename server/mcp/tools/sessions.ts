// tools/sessions.ts — the sessions toolset, P1: list the sessions in scope, describe one, say where it runs,
// and wait for one to change (that one is in sessionWait.ts). All four only read. Later phases add the card setters
// (sessionCard.ts), relaunches (sessionLife.ts), summaries (sessionSummarize.ts) and, in P5, ending one (sessionEnd.ts).
//
// Scope: `session_list` reads `ctx.scopedSessions()`; every other tool names its session through
// `resolveTarget`.

import { z } from 'zod';
import type { Session, SessionStatus } from '../../../src/types/session.js';
import { SESSION_STATUS } from '../../constants.js';
import { normalizeFolder } from '../paths.js';
import type { ToolContext, ToolDef } from '../registry.js';
import { isWithin, shortIdOf, toSessionCard, type SessionCard } from '../scope.js';
import {
  defineTool,
  fence,
  oneLine,
  plain,
  plural,
  refOf,
  resolveTarget,
  seg,
  SESSION_REF,
  sessionSource,
  unwrap,
  visibleRooms,
} from './define.js';
import { cardTools } from './sessionCard.js';
import { endTools } from './sessionEnd.js';
import { lifeTools } from './sessionLife.js';
import { summarizeTools } from './sessionSummarize.js';
import { waitTools } from './sessionWait.js';
import {
  ago,
  cardRow,
  cardsBlock,
  compactPath,
  dataCard,
  isGuessedWait,
  requestLine,
  requestView,
  type CardView,
} from './views.js';

/** Every status a session can have (the server's own list, so a new one cannot be missed here). */
const STATUSES = Object.values(SESSION_STATUS) as [SessionStatus, ...SessionStatus[]];

// ---------------------------------------------------------------------------
// session_list
// ---------------------------------------------------------------------------

interface ListFilter {
  status?: SessionStatus;
  agent?: 'claude' | 'codex';
  room?: string;
  project?: string;
  needsYou?: boolean;
  includeEnded: boolean;
}

function matchesRoom(view: CardView, wanted: string): boolean {
  const name = wanted.trim().toLowerCase();
  return view.roomId === wanted.trim() || (view.roomName !== null && view.roomName.toLowerCase() === name);
}

function matchesFilter(view: CardView, f: ListFilter, projectRoot: string | null): boolean {
  if (f.status !== undefined && view.status !== f.status) return false;
  if (f.agent !== undefined && view.cli !== f.agent) return false;
  if (f.room !== undefined && !matchesRoom(view, f.room)) return false;
  if (projectRoot !== null && (view.project === null || !isWithin(normalizeFolder(view.project), projectRoot))) return false;
  if (f.needsYou === true && !(view.needsYou || view.guessedWait)) return false;
  return true;
}

/** The sessions a list shows before the person's filters: in scope, no AI popups, no ended cards unless asked. */
function listBase(ctx: ToolContext, f: ListFilter): Session[] {
  const withEnded = f.includeEnded || f.status === 'ended';
  return ctx.scopedSessions().filter((s) => !s.isFloating && (withEnded || s.status !== 'ended'));
}

/** A list row: the card, and whether the caller opened it itself (its own worker, P4-3) — `cleanup` closes only these. */
type ListView = CardView & { own: boolean };

function listSummary(
  views: readonly ListView[],
  total: number,
  filtered: boolean,
  now: number,
  ref: (sessionId: string) => string,
): string {
  if (total === 0) return 'No sessions in your scope.';
  if (views.length === 0) return `No sessions match those filters (${plural(total, 'session')} in your scope).`;
  const working = views.filter((v) => v.status === 'working' || v.status === 'prompting').length;
  const waiting = views.filter((v) => v.needsYou || v.guessedWait).length;
  const of = filtered ? ` of ${total}` : '';
  const head = `${plural(views.length, 'session')}${of} in your scope: ${working} working, ${waiting} waiting on you.`;
  return `${head}\n${cardsBlock(views.map((v) => cardRow(v, now, ref(v.id), v.guessedWait) + (v.own ? ' · yours' : '')))}`;
}

const sessionList = defineTool({
  name: 'session_list',
  toolset: 'sessions',
  title: 'List sessions',
  description:
    'Lists the sessions in your scope, newest activity first: id, short id, title, status, CLI, folder, room, ' +
    'model, effort, context %, queue count, and whether it waits on you. A session with `handsOff: true` (shown ' +
    'as `hands-off` in the rows) is one the person keeps to themselves: you may read it, but every write to it is ' +
    'refused. `own: true` (`yours` in the rows) marks a session you opened yourself and nobody has typed into since: ' +
    'your own worker. Ended sessions and AI popups are left out unless asked for. Start here; every other tool takes the ' +
    'id or short id this gives.',
  risk: 'read',
  phase: 1,
  input: {
    status: z.enum(STATUSES).optional().describe('Only sessions in this status.'),
    agent: z.enum(['claude', 'codex']).optional().describe('Only sessions run by this CLI.'),
    room: z.string().min(1).max(200).optional().describe('Only sessions in this room (its id or its name).'),
    project: z.string().min(1).max(1024).optional().describe('Only sessions in this folder or below it.'),
    needsYou: z.boolean().optional().describe('Only sessions waiting on a person: an open request, or status approval or input.'),
    includeEnded: z.boolean().default(false).describe('Also list sessions that have ended.'),
  },
  async run(args, ctx) {
    const filter: ListFilter = args;
    const rooms = visibleRooms(ctx);
    const names = new Map(rooms.map((r) => [r.id, r.name]));
    const base = listBase(ctx, filter);
    const projectRoot = filter.project === undefined ? null : normalizeFolder(filter.project);
    const views: ListView[] = base
      .map((s) => {
        const card = toSessionCard(s, rooms);
        return {
          ...card,
          roomName: card.roomId === null ? null : (names.get(card.roomId) ?? null),
          guessedWait: isGuessedWait(s),
          own: ctx.workers.isOwn(ctx.central.centralId, s),
        };
      })
      .filter((view) => matchesFilter(view, filter, projectRoot))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id));
    const filtered = views.length !== base.length;
    return {
      // The titles are fenced in the data, one by one; the rows in the text sit in one block (listSummary).
      data: { count: views.length, total: base.length, sessions: views.map(dataCard) },
      summary: listSummary(views, base.length, filtered, ctx.now(), refOf(ctx)),
    };
  },
});

// ---------------------------------------------------------------------------
// session_get
// ---------------------------------------------------------------------------

/**
 * The words about one session. AASC's own sentences carry enums, numbers and ids written as plain words
 * (`plain`: the request id and the team id are text a hook supplied); what a session wrote sits in one block.
 */
function describeSummary(s: Session, card: SessionCard, roomName: string | null, now: number, ref: string): string {
  const facts = [`Session ${ref} is ${card.status}`];
  facts.push(`run by ${card.cli ?? 'an unknown CLI'}`);
  if (card.contextPct !== null) facts.push(`context ${card.contextPct}% full`);
  if (card.queueCount > 0) facts.push(`${card.queueCount} queued`);
  const lines = [`${facts.join(', ')}.`];
  // The refusal's own words (policy.ts HANDS_OFF), told before a write is tried.
  if (card.handsOff) lines.push('It is hands-off: you may read it, never type into it or give it work. Only the person can lift that.');
  if (s.pendingRequest) {
    const open = `a ${s.pendingRequest.kind} request ${plain(s.pendingRequest.id, 80)} is open`;
    lines.push(`It waits on you: ${open} (raised ${ago(now - s.pendingRequest.raisedAt)}).`);
  } else if (isGuessedWait(s)) {
    lines.push('Its status says it waits on a person, but no request says what for.');
  }
  if (s.teamId) lines.push(`It is in team ${plain(s.teamId, 80)}${s.teamRole ? ` (${s.teamRole})` : ''}.`);
  if (s.interruption) lines.push(`Its terminal showed a ${s.interruption.kind} banner ${ago(now - s.interruption.detectedAt)}.`);
  if ((s.backgroundTaskCount ?? 0) > 0) lines.push(`${plural(s.backgroundTaskCount ?? 0, 'background shell')} still running.`);
  const written = [
    `title ${JSON.stringify(oneLine(card.title, 120))}`,
    s.remark ? `remark ${JSON.stringify(oneLine(s.remark, 200))}` : null,
    `folder ${card.project === null ? 'none' : compactPath(card.project)}`,
    roomName === null ? null : `room ${JSON.stringify(oneLine(roomName, 80))}`,
    card.model === null ? null : `model ${oneLine(card.model, 60)}`,
    card.effort === null ? null : `effort ${oneLine(card.effort, 30)}`,
    s.pendingRequest ? requestLine(s.pendingRequest) : null,
  ].filter((p): p is string => p !== null);
  lines.push(fence(sessionSource(s.sessionId), 'session', written.join(' · ')));
  return lines.join('\n');
}

const sessionGet = defineTool({
  name: 'session_get',
  toolset: 'sessions',
  title: 'Describe a session',
  description:
    'Describes one session: status, CLI, model, effort, context %, the open request it waits on (its input ' +
    'fenced as untrusted), any API-fault banner, background shells, subagents, queue count, room and flags ' +
    '(pinned, muted, shared with the phone, external, has a terminal). Its card says `handsOff: true` when the ' +
    'person keeps the session to themselves: you may read it, but every write to it is refused. `started: false` ' +
    'means it has not reported in yet: prompts to it are refused and tasks wait.',
  risk: 'read',
  phase: 1,
  input: { id: SESSION_REF },
  async run(args, ctx) {
    const s = resolveTarget(ctx, args.id);
    const rooms = visibleRooms(ctx);
    const card = toSessionCard(s, rooms);
    const roomName = rooms.find((r) => r.id === card.roomId)?.name ?? null;
    const subagents = s.subagents ?? [];
    const guessed = isGuessedWait(s);
    const waiting = guessed ? (s.waitingDetail ?? s.pendingToolDetail ?? null) : null;
    const data = {
      card: dataCard(card),
      roomName,
      remark: s.remark ? fence(sessionSource(s.sessionId), 'remark', s.remark) : null,
      pendingRequest: s.pendingRequest ? requestView(s.sessionId, s.pendingRequest) : null,
      guessedWait: guessed,
      waitingDetail: waiting === null ? null : fence(sessionSource(s.sessionId), 'waiting', waiting),
      interruption: s.interruption ? { kind: s.interruption.kind, detectedAt: s.interruption.detectedAt } : null,
      compacting: s.compacting ? { since: s.compacting.since, trigger: s.compacting.trigger } : null,
      userCancelledAt: s.userCancelledAt ?? null,
      backgroundShells: s.backgroundTaskCount ?? 0,
      subagents: { running: subagents.filter((r) => r.status === 'working').length, total: subagents.length },
      permissionMode: s.permissionMode ?? null,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      flags: {
        pinned: s.pinned === true,
        muted: s.muted === true,
        alerted: s.alerted === true,
        shared: s.remoteVisible === true,
        external: s.isExternal === true,
        fork: s.isFork === true,
        floating: s.isFloating === true,
        hasTerminal: !!s.terminalId,
      },
      team: s.teamId ? { teamId: s.teamId, role: s.teamRole ?? null } : null,
      central: s.central ? { centralId: s.central.centralId, kind: s.central.kind } : null,
    };
    return { data, summary: describeSummary(s, card, roomName, ctx.now(), refOf(ctx)(s.sessionId)) };
  },
});

// ---------------------------------------------------------------------------
// session_source
// ---------------------------------------------------------------------------

const sessionWhere = defineTool({
  name: 'session_source',
  toolset: 'sessions',
  title: 'Where a session runs',
  description: 'Says where a session was started from: a terminal, VS Code, JetBrains, tmux or another app.',
  risk: 'read',
  phase: 1,
  input: { id: SESSION_REF },
  async run(args, ctx) {
    const s = resolveTarget(ctx, args.id);
    const body = unwrap<{ source?: unknown }>(await ctx.client.get(`/sessions/${seg(s.sessionId)}/source`));
    const source = typeof body.source === 'string' && body.source !== '' ? plain(body.source, 30) : 'unknown';
    return {
      data: { id: s.sessionId, shortId: shortIdOf(s.sessionId), source },
      summary: `Session ${refOf(ctx)(s.sessionId)} runs in: ${source}.`,
    };
  },
});

export const sessionTools: readonly ToolDef[] = [sessionList, sessionGet, sessionWhere, ...waitTools, ...cardTools, ...lifeTools, ...summarizeTools, ...endTools];
