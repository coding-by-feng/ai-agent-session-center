// tools/context.ts — `context_breakdown`: what fills a Claude session's context window. Part of the conversation
// toolset. It reads `GET /api/sessions/:id/context-breakdown`, the route the dashboard's own context view uses,
// and says what that answers. Read only.
//
// An item's label names a file, a command or a prompt the session handled, so each label is text the session
// wrote: it is fenced on its own in `data`, and the items sit in one fenced block in the text. The kinds, the
// token counts and the times are numbers and fixed words, plain.

import type { ToolDef } from '../registry.js';
import { shortIdOf } from '../scope.js';
import { ToolError } from '../types.js';
import { clipText, defineTool, fence, isRecord, plural, refOf, resolveTarget, seg, SESSION_REF, sessionSource, unwrap } from './define.js';
import { routeMissing } from './shape.js';

/** The most characters of an answer of a shape this build does not know that are handed over (as fenced JSON). */
const BREAKDOWN_MAX = 12_000;
/** The route names at most 5 items; this is a ceiling for a route that grows. */
const BREAKDOWN_ITEMS_MAX = 10;

/**
 * The kinds the route names (`ContextKind` in src/types/chat.ts of the checkout that has the route). A kind this
 * build does not know shows as `other`, so a new kind (or a hostile one) cannot put text into AASC's words.
 */
const CONTEXT_KINDS: ReadonlySet<string> = new Set([
  'system', 'tools', 'fixed', 'memory', 'skills', 'summary', 'prompts', 'replies', 'toolCalls', 'read', 'bash',
  'search', 'edits', 'subagents', 'web', 'mcp', 'otherTools', 'reminders',
]);
const kindOf = (kind: unknown): string => (typeof kind === 'string' && CONTEXT_KINDS.has(kind) ? kind : 'other');
const whole = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);

interface BreakdownView {
  tokens: number;
  requests: number;
  sinceCompaction: boolean;
  measuredAt: number;
  kinds: Array<{ kind: string; tokens: number; percent: number }>;
  items: Array<{ kind: string; label: string; tokens: number }>;
}

/**
 * The route's `ContextBreakdown` (`{ tokens, kinds[], items[], requests, sinceCompaction, measuredAt }`) as the
 * answer carries it: the data gets the kinds with their share of the window and the largest items, each label
 * (it names a file, a command or a prompt the session handled) fenced on its own; `rows` are the same items as
 * plain lines, for the one block in the text. Null for an answer of another shape.
 */
function readBreakdown(sessionId: string, found: unknown): { view: BreakdownView; rows: string[] } | null {
  if (!isRecord(found) || typeof found.tokens !== 'number' || !Array.isArray(found.kinds)) return null;
  const total = whole(found.tokens);
  const kinds = found.kinds.flatMap((k) =>
    isRecord(k) && typeof k.tokens === 'number'
      ? [{ kind: kindOf(k.kind), tokens: whole(k.tokens), percent: total > 0 ? Math.round((k.tokens / total) * 100) : 0 }]
      : [],
  );
  const view: BreakdownView = {
    tokens: total,
    requests: whole(found.requests),
    sinceCompaction: found.sinceCompaction === true,
    measuredAt: whole(found.measuredAt),
    kinds,
    items: [],
  };
  const rows: string[] = [];
  for (const item of (Array.isArray(found.items) ? found.items : []).slice(0, BREAKDOWN_ITEMS_MAX)) {
    if (!isRecord(item) || typeof item.label !== 'string' || typeof item.tokens !== 'number') continue;
    view.items.push({ kind: kindOf(item.kind), label: fence(sessionSource(sessionId), 'context-item', item.label), tokens: whole(item.tokens) });
    rows.push(`${item.label} (${whole(item.tokens)} tokens)`);
  }
  return { view, rows };
}

/** AASC's words about a breakdown (the size, the requests, each kind's share), then the items in one block. */
function breakdownText(ref: string, sessionId: string, view: BreakdownView, rows: readonly string[]): string {
  const since = view.sinceCompaction ? 'the last compaction' : 'the session began';
  const lines = [`What fills the context window of ${ref}: about ${view.tokens} tokens at the last request, ${plural(view.requests, 'request')} since ${since}.`];
  if (view.kinds.length > 0) lines.push(`By kind: ${view.kinds.map((k) => `${k.kind} ${k.percent}%`).join(', ')}.`);
  if (rows.length > 0) lines.push('Largest items:', fence(sessionSource(sessionId), 'context-items', rows.join('\n')));
  return lines.join('\n');
}

const contextBreakdown = defineTool({
  name: 'context_breakdown',
  toolset: 'conversation',
  title: 'What fills a context window',
  description:
    'Says what fills a Claude session’s context window: its size at the last request, the share of each kind ' +
    '(tool results, replies, memory, tool definitions…) and the largest single items, measured from its ' +
    'transcript. Item labels are fenced as untrusted data. Codex sessions have no breakdown.',
  risk: 'read',
  phase: 1,
  input: { id: SESSION_REF },
  async run(args, ctx) {
    const s = resolveTarget(ctx, args.id);
    const shortId = shortIdOf(s.sessionId);
    const ref = refOf(ctx)(s.sessionId);
    const answer = await ctx.client.get(`/sessions/${seg(s.sessionId)}/context-breakdown`);
    // The session exists (it was just resolved), so a missing route is a build of AASC without this route: an unknown
    // `/api` GET answers 200 with the app's own page (no JSON), not 404. Codex's answer is `{ success: true, data: null }`,
    // which has JSON and is not missing.
    if (routeMissing(answer)) {
      throw new ToolError('UNAVAILABLE', 'This build of AASC cannot break down a context window.', 'Use session_get for the context percentage.');
    }
    const found = unwrap<unknown>(answer);
    if (found === null) {
      return {
        data: { id: s.sessionId, shortId, breakdown: null },
        summary: `No breakdown for session ${ref}: its context window cannot be measured (Codex sessions have none).`,
      };
    }
    const read = readBreakdown(s.sessionId, found);
    if (read === null) {
      // An answer of a shape this build does not know: passed on whole, capped and fenced, rather than dropped.
      const clipped = clipText(JSON.stringify(found) ?? 'null', BREAKDOWN_MAX);
      const raw = fence(sessionSource(s.sessionId), 'context-breakdown', clipped.text);
      const cut = clipped.truncated ? `, cut at ${BREAKDOWN_MAX} characters` : '';
      return {
        data: { id: s.sessionId, shortId, breakdown: { raw } },
        summary: `What fills the context window of ${ref} (JSON of a shape AASC does not know${cut}):\n${raw}`,
      };
    }
    return {
      data: { id: s.sessionId, shortId, breakdown: read.view },
      summary: breakdownText(ref, s.sessionId, read.view, read.rows),
    };
  },
});

export const contextTools: readonly ToolDef[] = [contextBreakdown];
