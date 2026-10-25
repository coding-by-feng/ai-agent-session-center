// tools/agents.ts — a session's subagents and its team, P1. Part of the conversation toolset.
//
// `subagents_list` reads the session's own record. `subagent_transcript` and `team_get` wrap the routes the
// AGENTS tab uses. A team's config file names every member (with its prompt and folder), and a central must
// not learn of a session out of its scope through it: `team_get` describes a team through the sessions in
// scope only. The team's name and description are the leader's: a central that sees a teammate but not the
// leader gets neither (the config is not even asked for), and one that sees the leader gets the name, the time
// it was made and the description, fenced as untrusted.
//
// What a session or a subagent wrote (a task, a description, a target, a transcript) is fenced in `data` as
// well as in the text, each piece on its own.

import { z } from 'zod';
import type { SubagentRun } from '../../../src/types/session.js';
import type { ConversationEntry } from '../../extractPreviousAnswer.js';
import type { ToolDef } from '../registry.js';
import { shortIdOf, toSessionCard } from '../scope.js';
import { ToolError } from '../types.js';
import {
  clipText,
  defineTool,
  fence,
  notInScope,
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
import { renderConversationEntries } from './entries.js';
import { ago, cardRow, cardsBlock, dataCard } from './views.js';

// ---------------------------------------------------------------------------
// subagents_list
// ---------------------------------------------------------------------------

/**
 * One run as the data carries it: plain values, nothing shared with the session's own record. What the leader
 * wrote for it (its task) and the target of its current tool are text, so each is fenced on its own.
 */
function runView(sessionId: string, r: SubagentRun) {
  const source = sessionSource(sessionId);
  return {
    agentId: r.agentId,
    agentType: r.agentType,
    description: r.description === null ? null : fence(source, 'subagent-description', r.description),
    descriptionConfirmed: r.descriptionConfirmed,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    lastActivityAt: r.lastActivityAt,
    toolCount: r.toolCount,
    currentTool: r.currentTool,
    currentTarget: r.currentTarget === null ? null : fence(source, 'subagent-target', r.currentTarget),
  };
}

function runRow(r: SubagentRun, now: number): string {
  const doing = r.currentTool === null ? null : `now ${r.currentTool}${r.currentTarget ? ` ${oneLine(r.currentTarget, 60)}` : ''}`;
  return [
    r.agentId,
    r.agentType,
    r.status,
    r.description === null ? 'no description' : JSON.stringify(oneLine(r.description, 100)),
    `${plural(r.toolCount, 'tool call')}`,
    doing,
    `active ${ago(now - r.lastActivityAt)}`,
  ]
    .filter((p): p is string => p !== null)
    .join(' · ');
}

const subagentsList = defineTool({
  name: 'subagents_list',
  toolset: 'conversation',
  title: 'List a session’s subagents',
  description:
    'Lists the subagents (in-process helpers such as Explore or a code reviewer) a session has run, oldest ' +
    'first: id, type, task, status, how many tools each called and what it is doing now. Give an id to ' +
    'subagent_transcript to read one.',
  risk: 'read',
  phase: 1,
  input: { id: SESSION_REF },
  async run(args, ctx) {
    const s = resolveTarget(ctx, args.id);
    const ref = refOf(ctx)(s.sessionId);
    const runs = s.subagents ?? [];
    const running = runs.filter((r) => r.status === 'working').length;
    const data = {
      id: s.sessionId,
      shortId: shortIdOf(s.sessionId),
      count: runs.length,
      running,
      subagents: runs.map((r) => runView(s.sessionId, r)),
    };
    if (runs.length === 0) return { data, summary: `Session ${ref} has run no subagents.` };
    const lead = `Session ${ref} ran ${plural(runs.length, 'subagent')} (${running} working).`;
    const now = ctx.now();
    const rows = runs.map((r) => runRow(r, now)).join('\n');
    return { data, summary: `${lead}\n${fence(sessionSource(s.sessionId), 'subagents', rows)}` };
  },
});

// ---------------------------------------------------------------------------
// subagent_transcript
// ---------------------------------------------------------------------------

/** A subagent id is a file-name part (Claude's are `a<hex>` or `a<name>-<hex>`): the route's own rule. */
const AGENT_ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
/** A byte offset into the transcript file, as the route takes it. */
const OFFSET = z.string().regex(/^\d{1,15}$/);

/** The entries in a page when the caller does not say: enough to follow the work, small enough to afford. */
const DEFAULT_SUBAGENT_LIMIT = 40;
/**
 * The longest task shown. The route sends the task with every page, up to 64 KB; a central that pages back
 * would pay for it each time, so it is cut here, and said to be.
 */
const TASK_MAX = 4_000;

interface SubagentPage {
  task: string | null;
  entries: ConversationEntry[];
  start: number;
  hasEarlier: boolean;
  reset?: boolean;
}

/** What to say about entries the budget left out. A `before` from this page would skip them, so none is offered. */
function omittedNote(omitted: number, forward: boolean): string {
  if (forward) {
    return `${omitted} of the oldest entries from that offset were left out to fit one answer: read the newest page instead (without from), with a smaller limit.`;
  }
  return (
    `${plural(omitted, 'older entry', 'older entries')} of this page were left out to fit one answer. Read again with a smaller limit ` +
    `(for example ${DEFAULT_SUBAGENT_LIMIT}) to see them; paging with before now would skip them.`
  );
}

const subagentTranscript = defineTool({
  name: 'subagent_transcript',
  toolset: 'conversation',
  title: 'Read a subagent',
  description:
    'Reads one subagent’s own conversation: the task it was given (cut at 4 000 characters), then its replies, ' +
    'tool calls and results, the newest page first (40 entries by default; before pages back through history, ' +
    'from refreshes a page you hold). Fenced as untrusted data.',
  risk: 'read',
  phase: 1,
  input: {
    id: SESSION_REF,
    agentId: AGENT_ID.describe('The subagent’s id, from subagents_list.'),
    before: OFFSET.optional().describe('The start of the page you hold: read the page above it.'),
    from: OFFSET.optional().describe('The start of a page you hold: read from there to the end, to refresh it (no limit applies).'),
    limit: z.number().int().min(1).max(200).optional().describe(`Entries in the page, 1 to 200 (default ${DEFAULT_SUBAGENT_LIMIT}); not used with from.`),
  },
  async run(args, ctx) {
    if (args.before !== undefined && args.from !== undefined) {
      throw new ToolError('INVALID', 'Pass before or from, not both.', 'before reads older entries, from refreshes a page you hold.');
    }
    const s = resolveTarget(ctx, args.id);
    const ref = refOf(ctx)(s.sessionId);
    const forward = args.from !== undefined;
    // A refresh from an offset reads to the end, so a limit means nothing there.
    const query = forward
      ? { from: args.from as string }
      : { ...(args.before === undefined ? {} : { before: args.before }), limit: args.limit ?? DEFAULT_SUBAGENT_LIMIT };
    const page = unwrap<SubagentPage | null>(
      await ctx.client.get(`/sessions/${seg(s.sessionId)}/subagents/${seg(args.agentId)}/transcript`, query),
    );
    if (page === null) {
      return {
        data: {
          id: s.sessionId, shortId: shortIdOf(s.sessionId), agentId: args.agentId, task: null, taskTruncated: false, taskChars: 0,
          transcript: null, count: 0, start: null, hasEarlier: false,
        },
        summary: `Subagent ${args.agentId} of ${ref} has no transcript file (yet).`,
      };
    }
    const rendered = renderConversationEntries(Array.isArray(page.entries) ? page.entries : []);
    const taskClip = typeof page.task === 'string' && page.task !== '' ? clipText(page.task, TASK_MAX) : null;
    const task = taskClip === null ? null : fence(sessionSource(s.sessionId), 'subagent-task', taskClip.text);
    const transcript = fence(sessionSource(s.sessionId), 'subagent', rendered.text);
    // Entries left out are the oldest of the page; the page's own `start` would page past them.
    const startSkipsOmitted = rendered.omitted > 0 && !forward;
    const lines = [`Subagent ${args.agentId} of ${ref}: ${plural(rendered.count, 'entry', 'entries')}, oldest first.`];
    if (rendered.omitted > 0) lines.push(omittedNote(rendered.omitted, forward));
    if (page.reset === true) lines.push('That page was too big to refresh: this is the newest page instead; drop the pages you held.');
    if (page.hasEarlier && !startSkipsOmitted) lines.push(`Older entries exist: pass before="${page.start}".`);
    if (!startSkipsOmitted) lines.push(`To refresh this page later: pass from="${page.start}".`);
    if (task !== null && taskClip !== null) {
      lines.push(taskClip.truncated ? `The task it was given (truncated), ${TASK_MAX} of ${taskClip.length} characters:` : 'The task it was given:', task);
    }
    if (rendered.count > 0) lines.push(transcript);
    return {
      data: {
        id: s.sessionId,
        shortId: shortIdOf(s.sessionId),
        agentId: args.agentId,
        task,
        taskTruncated: taskClip?.truncated === true,
        taskChars: taskClip?.length ?? 0,
        transcript,
        count: rendered.count,
        omitted: rendered.omitted,
        start: startSkipsOmitted ? null : page.start,
        hasEarlier: page.hasEarlier === true,
        ...(page.reset === true ? { reset: true } : {}),
      },
      summary: lines.join('\n'),
    };
  },
});

// ---------------------------------------------------------------------------
// team_get
// ---------------------------------------------------------------------------

interface TeamAnswer {
  teamName?: string | null;
  config?: { description?: unknown; createdAt?: unknown } | null;
}

const teamGet = defineTool({
  name: 'team_get',
  toolset: 'conversation',
  title: 'Describe a team',
  description:
    'Describes a team of sessions (a leader and the teammates it started): the leader and members you can see, ' +
    'and, when you can see the leader, the team’s name, when it began and the description its leader gave it. ' +
    'Take the team id from session_get. Members outside your scope are not shown.',
  risk: 'read',
  phase: 1,
  input: { teamId: z.string().min(1).max(200).describe('The team’s id, from session_get.') },
  async run(args, ctx) {
    if (!ctx.sessions().some((s) => s.teamId === args.teamId)) {
      throw new ToolError('NOT_FOUND', 'No team has that id.', 'A session in a team shows its teamId in session_get.');
    }
    const mine = ctx.scopedSessions().filter((s) => s.teamId === args.teamId);
    if (mine.length === 0) throw notInScope('team');
    const rooms = visibleRooms(ctx);
    const cards = mine.map((s) => ({ session: s, card: toSessionCard(s, rooms) }));
    const leader = cards.find((c) => c.session.teamRole === 'leader')?.card ?? null;
    const members = cards.filter((c) => c.session.teamRole !== 'leader').map((c) => c.card);
    // The name, the time and the description are the leader's: only a central that sees the leader gets them.
    let teamName: string | null = null;
    let description: string | null = null;
    let createdAt: number | null = null;
    if (leader !== null) {
      const body = unwrap<TeamAnswer>(await ctx.client.get(`/teams/${seg(args.teamId)}/config`));
      const said = body.config?.description;
      description = typeof said === 'string' && said !== '' ? fence(`team:${args.teamId}`, 'team-description', said) : null;
      createdAt = typeof body.config?.createdAt === 'number' ? body.config.createdAt : null;
      teamName = typeof body.teamName === 'string' ? fence(`team:${args.teamId}`, 'team-name', body.teamName) : null;
    }
    const data = {
      teamId: args.teamId,
      teamName,
      createdAt,
      description,
      leader: leader === null ? null : dataCard(leader),
      members: members.map(dataCard),
    };
    const now = ctx.now();
    const ref = refOf(ctx);
    const rows = [...(leader === null ? [] : [cardRow(leader, now, ref(leader.id))]), ...members.map((m) => cardRow(m, now, ref(m.id)))];
    const lead = `Team ${plain(args.teamId, 80)}: ${leader === null ? '' : 'a leader and '}${plural(members.length, 'member')} you can see.`;
    const named = teamName === null ? [] : [teamName];
    return { data, summary: [lead, ...named, cardsBlock(rows), ...(description === null ? [] : [description])].join('\n') };
  },
});

export const agentTools: readonly ToolDef[] = [subagentsList, subagentTranscript, teamGet];
