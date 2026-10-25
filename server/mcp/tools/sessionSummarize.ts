// tools/sessionSummarize.ts — `session_summarize` (the sessions toolset, P3, Ruling P3-10): AASC summarises a session's
// conversation with Claude (`POST /sessions/:id/summarize`, which runs `claude -p --model haiku --tools ""
// --strict-mcp-config` for up to 60 s: no tools and no MCP servers, for every caller, Ruling P3-25), stores the summary
// on the card, and then ARCHIVES the card. So a central summarises ended cards only.
//
// The rails: `resolveTarget`, the card rail (`ctx.mayEdit`: scope, the kinds, hands-off), then the card has ended. One
// summarise may be in flight per central (a second is BUDGET), and its slot is held for as long as the route may still
// be running: until it answers, or for the route's full 60 s from the POST when the call stopped waiting first (C-M5).
// The route itself takes two at once (its 429 is BUDGET too). The context is the conversation as the chat reader gives
// it (`GET /sessions/:id/chat`, the newest page): the person's and the agent's messages, joined, the newest 100 000
// characters kept. The central's prompt, at most 500 characters, goes as `custom_prompt`; the route adds it to AASC's
// own summary instructions, never in place of them.
//
// The call waits up to 45 s (and never past `ctx.signal`). Then it answers `state: 'running'`: the route goes on, and
// the summary lands on the card all the same (history_get shows it). A summary that came back is fenced: the model
// wrote it from text a session wrote.

import { z } from 'zod';
import type { ChatEntry, ChatPage } from '../../../src/types/chat.js';
import type { Session } from '../../../src/types/session.js';
import type { InternalResponse } from '../client.js';
import type { ToolContext, ToolDef, ToolResult } from '../registry.js';
import { ToolError } from '../types.js';
import { defineTool, fence, isRecord, refOf, resolveTarget, seg, SESSION_REF, sessionSource, unwrap } from './define.js';

/** How long one call waits for the route (the route's own limit is 60 s). */
export const SUMMARIZE_WAIT_MS = 45_000;
/** The most characters of conversation sent as context. */
export const SUMMARIZE_CONTEXT_MAX = 100_000;
/** The longest prompt a central may give. */
export const SUMMARIZE_PROMPT_MAX = 500;
/** How long the route runs at most (its `claude -p` timeout): a slot is held that long from the POST. */
export const SUMMARIZE_ROUTE_MS = 60_000;
/** The page of the chat reader the context is read from (its largest). */
const CHAT_PAGE = 200;

/** The centrals with a summarise in flight now, or whose route may still be running. */
const inFlight = new Set<string>();
/** The timers that give a held slot back once the route's 60 s are up. */
const holds = new Map<string, ReturnType<typeof setTimeout>>();

/** Gives the slot back now, or once `ms` have passed. */
function release(centralId: string, ms = 0): void {
  if (ms <= 0) {
    inFlight.delete(centralId);
    return;
  }
  const timer = setTimeout(() => {
    holds.delete(centralId);
    inFlight.delete(centralId);
  }, ms);
  timer.unref?.();
  holds.set(centralId, timer);
}

/** @internal — test only: every slot given back, and no timer left. */
export function __resetSummarizeSlotsForTest(): void {
  for (const timer of holds.values()) clearTimeout(timer);
  holds.clear();
  inFlight.clear();
}

/** The conversation as one text: the person's and the agent's messages, oldest first, the newest characters kept. */
function contextOf(entries: readonly ChatEntry[]): string {
  const lines = entries.flatMap((e) => {
    if (e.kind === 'user') return [`User: ${e.text}`];
    if (e.kind === 'assistant') return [`Assistant: ${e.text}`];
    return [];
  });
  const text = lines.join('\n\n');
  return text.length > SUMMARIZE_CONTEXT_MAX ? text.slice(text.length - SUMMARIZE_CONTEXT_MAX) : text;
}

async function readContext(ctx: ToolContext, s: Session): Promise<string> {
  const page = unwrap<ChatPage>(await ctx.client.get(`/sessions/${seg(s.sessionId)}/chat`, { limit: CHAT_PAGE }));
  const context = contextOf(Array.isArray(page.entries) ? page.entries : []);
  if (context.trim() === '') {
    throw new ToolError('INVALID', 'AASC has no conversation of that session to summarise.', 'chat_read shows what AASC can read of it.');
  }
  return context;
}

/** The ended card `id` names, once the card rail let it through. */
function endedCard(ctx: ToolContext, id: string): Session {
  const s = resolveTarget(ctx, id);
  ctx.mayEdit(s);
  if (s.status !== 'ended') {
    throw new ToolError('INVALID', 'Summarising archives the card, so a central summarises ended sessions only.', 'Pick a session that has ended.');
  }
  return s;
}

/**
 * The route's call, cut off after `SUMMARIZE_WAIT_MS`; `timedOut` says whether that cap (not the central) ended it,
 * `stopped` whether either did (the route may still be running then).
 */
async function postSummarize(
  ctx: ToolContext,
  s: Session,
  body: Record<string, string>,
): Promise<{ res: InternalResponse<unknown>; timedOut: boolean; stopped: boolean }> {
  const cap = new AbortController();
  const timer = setTimeout(() => cap.abort(), SUMMARIZE_WAIT_MS);
  try {
    const signal = AbortSignal.any([ctx.signal, cap.signal]);
    const res = await ctx.client.post(`/sessions/${seg(s.sessionId)}/summarize`, body, { signal });
    const stopped = !res.ok && (cap.signal.aborted || ctx.signal.aborted);
    return { res, timedOut: stopped && !ctx.signal.aborted, stopped };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeAnswer(ctx: ToolContext, s: Session, res: InternalResponse<unknown>): ToolResult {
  if (res.status === 429) {
    throw new ToolError('BUDGET', 'AASC is already summarising as many sessions as it takes at once.', 'Try again in a minute.');
  }
  const body = unwrap<unknown>(res);
  const text = isRecord(body) && typeof body.summary === 'string' ? body.summary : '';
  const summary = fence(sessionSource(s.sessionId), 'summary', text);
  return {
    data: { sessionId: s.sessionId, state: 'done', summary },
    summary: `Summarised session ${refOf(ctx)(s.sessionId)}; AASC stored the summary on its card and archived it.\n${summary}`,
    activity: [{ summary: 'summarised a session and archived its card', targetSessionId: s.sessionId }],
  };
}

const sessionSummarize = defineTool({
  name: 'session_summarize',
  toolset: 'sessions',
  title: 'Summarise an ended session',
  description:
    'Summarises a session’s conversation with Claude (haiku, run with no tools and no MCP servers), stores the summary ' +
    'on its card, and archives the card. Ended sessions only; never a hands-off session, another central or your own, ' +
    'an AI popup, an external or an SSH session. One at a time: a second call while one runs is BUDGET, and one runs ' +
    'until it answers or for 60 s from the call when you stopped waiting. It waits up to 45 s; still running then, it ' +
    'answers state "running" and the summary lands on the card later (history_get shows it). prompt, at most 500 ' +
    'characters, says what the summary should cover: it is added to AASC’s own summary instructions, never in place of ' +
    'them.',
  risk: 'write',
  phase: 3,
  input: {
    id: SESSION_REF,
    prompt: z.string().min(1).max(SUMMARIZE_PROMPT_MAX).optional().describe('What the summary should cover (at most 500 characters).'),
  },
  async run(args, ctx) {
    const s = endedCard(ctx, args.id);
    const { centralId } = ctx.central;
    if (inFlight.has(centralId)) {
      throw new ToolError('BUDGET', 'You are already summarising a session; one runs at a time.', 'Wait for it to answer, then try again.');
    }
    inFlight.add(centralId);
    let holdMs = 0;
    try {
      const context = await readContext(ctx, s);
      const sentAt = Date.now();
      const { res, timedOut, stopped } = await postSummarize(ctx, s, { context, ...(args.prompt === undefined ? {} : { custom_prompt: args.prompt }) });
      // The call stopped waiting, not the route: it may run on until its 60 s are up, and holds the slot that long.
      if (stopped) holdMs = SUMMARIZE_ROUTE_MS - (Date.now() - sentAt);
      if (timedOut) {
        return {
          data: { sessionId: s.sessionId, state: 'running' },
          summary: `AASC is still summarising session ${refOf(ctx)(s.sessionId)}; history_get shows the summary once it lands (the card is archived then).`,
          activity: [{ summary: 'started summarising a session', targetSessionId: s.sessionId }],
        };
      }
      return summarizeAnswer(ctx, s, res);
    } finally {
      release(centralId, holdMs);
    }
  },
});

export const summarizeTools: readonly ToolDef[] = [sessionSummarize];
