/**
 * chatApi.ts — the phone chat's read of a session's conversation (AASC-41):
 *
 *   GET /api/sessions/:id/chat[?before=<cursor> | ?after=<cursor>]
 *     → { success, data: { entries, before, after, cli, hasMore, reset? } }
 *
 * The answer is checked before it is used (a page, cursors, one CLI); an entry
 * that isn't one of the known kinds with its fields is dropped, not trusted, so
 * one odd line never blanks the chat. Never throws: a failure comes back with its
 * HTTP status (0 for the network) and words a person can act on. The client-id
 * header rides on the app's own fetch (presenceClient.installClientIdentityHeaders).
 */
import { z } from 'zod';
import type { ChatEntry, ChatPage, ContextBreakdown, ContextKind } from '@/types/chat';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

const base = { key: z.string().min(1), timestamp: z.number() };
const systemKinds = z.enum(['compacted', 'cancelled', 'model', 'resumed', 'notification', 'context', 'info']);

const entrySchema = z.discriminatedUnion('kind', [
  z.looseObject({ ...base, kind: z.literal('user'), text: z.string(), images: z.number().optional(), truncated: z.boolean().optional() }),
  z.looseObject({ ...base, kind: z.literal('assistant'), text: z.string(), truncated: z.boolean().optional() }),
  z.looseObject({ ...base, kind: z.literal('thinking'), length: z.number(), durationMs: z.number().optional() }),
  z.looseObject({ ...base, kind: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown(), inputTruncated: z.boolean().optional() }),
  z.looseObject({ ...base, kind: z.literal('tool_result'), toolUseId: z.string(), isError: z.boolean(), output: z.string(), truncated: z.boolean() }),
  z.looseObject({ ...base, kind: z.literal('todo'), id: z.string(), items: z.array(z.object({ text: z.string(), status: z.string() })) }),
  z.looseObject({
    ...base,
    kind: z.literal('subagent'),
    id: z.string(),
    description: z.string(),
    agentType: z.string().optional(),
    prompt: z.string(),
    background: z.boolean().optional(),
    truncated: z.boolean().optional(),
  }),
  z.looseObject({ ...base, kind: z.literal('command'), name: z.string(), args: z.string().optional(), output: z.string().optional() }),
  z.looseObject({ ...base, kind: z.literal('system'), system: systemKinds, label: z.string().optional(), text: z.string().optional(), truncated: z.boolean().optional() }),
]);

const pageSchema = z.object({
  entries: z.array(z.unknown()),
  before: z.string().nullable(),
  after: z.string().nullable(),
  cli: z.enum(['claude', 'codex']).nullable(),
  hasMore: z.boolean(),
  reset: z.boolean().optional(),
});

const envelope = z.object({ success: z.literal(true), data: z.unknown() });

/** The entries of a page that read as entries; the rest are dropped. */
export function validEntries(raw: readonly unknown[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  for (const item of raw) {
    const parsed = entrySchema.safeParse(item);
    if (parsed.success) out.push(parsed.data as ChatEntry);
  }
  return out;
}

/** Words for a failed read of `what` ("the conversation", "what this session changed"). */
export function messageFor(status: number, serverError?: string, what = 'the conversation'): string {
  if (status === 0) return 'Couldn’t reach your Mac. Check the connection and try again.';
  if (status === 404) return 'This session isn’t available on this phone.';
  if (status === 400) return 'The conversation changed on the Mac. Reload it.';
  return serverError || `The Mac couldn’t read ${what} (HTTP ${status}).`;
}

/** GET a JSON `{ success, data }` route and hand back `data`. */
export async function getData(url: string, signal?: AbortSignal, what?: string): Promise<ApiResult<unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    return { ok: false, status: 0, message: messageFor(0, undefined, what) };
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) {
    return { ok: false, status: res.status, message: messageFor(res.status, typeof body?.error === 'string' ? body.error : undefined, what) };
  }
  const parsed = envelope.safeParse(body);
  if (!parsed.success) return { ok: false, status: res.status, message: 'The Mac sent an answer this phone can’t read.' };
  return { ok: true, data: parsed.data.data };
}

export interface PageCursor {
  before?: string;
  after?: string;
}

export async function fetchChatPage(sessionId: string, cursor: PageCursor = {}, signal?: AbortSignal): Promise<ApiResult<ChatPage>> {
  const params = new URLSearchParams();
  if (cursor.before) params.set('before', cursor.before);
  else if (cursor.after) params.set('after', cursor.after);
  const query = params.toString();
  const result = await getData(`/api/sessions/${encodeURIComponent(sessionId)}/chat${query ? `?${query}` : ''}`, signal);
  if (!result.ok) return result;
  const page = pageSchema.safeParse(result.data);
  if (!page.success) return { ok: false, status: 200, message: 'The Mac sent a conversation this phone can’t read.' };
  return { ok: true, data: { ...page.data, entries: validEntries(page.data.entries) } };
}

const CONTEXT_KINDS = [
  'system', 'tools', 'fixed', 'memory', 'skills', 'summary', 'prompts', 'replies', 'toolCalls',
  'read', 'bash', 'search', 'edits', 'subagents', 'web', 'mcp', 'otherTools', 'reminders',
] as const satisfies readonly ContextKind[];

const breakdownSchema = z.object({
  tokens: z.number().nonnegative(),
  kinds: z.array(z.object({ kind: z.enum(CONTEXT_KINDS), tokens: z.number().nonnegative() })),
  items: z.array(z.object({ kind: z.enum(CONTEXT_KINDS), label: z.string().max(200), tokens: z.number().nonnegative() })),
  requests: z.number().int().nonnegative(),
  sinceCompaction: z.boolean(),
  measuredAt: z.number(),
});

/**
 * What fills the session's context window (Oct 22 2026):
 *   GET /api/sessions/:id/context-breakdown → { success, data: ContextBreakdown | null }
 * null: a Codex session, no transcript, or no request yet.
 */
export async function fetchContextBreakdown(sessionId: string, signal?: AbortSignal): Promise<ApiResult<ContextBreakdown | null>> {
  const what = 'what fills the context window';
  const result = await getData(`/api/sessions/${encodeURIComponent(sessionId)}/context-breakdown`, signal, what);
  if (!result.ok) return result;
  if (result.data === null) return { ok: true, data: null };
  const parsed = breakdownSchema.safeParse(result.data);
  if (!parsed.success) return { ok: false, status: 200, message: 'The Mac sent an answer this phone can’t read.' };
  return { ok: true, data: parsed.data };
}
