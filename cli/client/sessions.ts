/**
 * Sessions as `aasc` sees them: GET /api/sessions parsed through Zod, the `ls` order, and
 * session addressing (plan §9.1). A session is named by its number in the last `ls`, a
 * session-id prefix, or words from its title; with several servers, prefix the server:
 * `vps:2`, `vps:migrate db`.
 */
import { z } from 'zod';
import { sessionDisplayTitle } from '../../src/lib/sessionDisplayTitle.js';
import { isSendableStatus } from '../../src/lib/sendableStatus.js';
import type { LastLsEntry } from './store.js';
import { cleanText } from './sanitize.js';

export { isSendableStatus };

/** What `aasc` reads is checked; everything else the server sends is kept as is, for `ls --json`. */
const SessionSchema = z.looseObject({
  sessionId: z.string().min(1).max(256),
  status: z.string().min(1).max(32),
  title: z.string().max(10_000).nullish(),
  projectName: z.string().max(10_000).nullish(),
  terminalId: z.string().max(256).nullish(),
  cliSource: z.string().max(64).nullish(),
  source: z.string().max(64).nullish(),
  lastActivityAt: z.number().nullish(),
});

export type RemoteSession = z.infer<typeof SessionSchema>;

/** The record GET /api/sessions answers (already filtered to what this client may see). Malformed entries are skipped. */
export function parseSessions(data: unknown): RemoteSession[] {
  const record = z.record(z.string(), z.unknown()).parse(data);
  const list: RemoteSession[] = [];
  for (const value of Object.values(record)) {
    const parsed = SessionSchema.safeParse(value);
    if (parsed.success) list.push(parsed.data);
  }
  return list;
}

/** `ls` order: live sessions only, most recently active first. */
export function orderSessions(list: RemoteSession[]): RemoteSession[] {
  return list
    .filter((s) => s.status !== 'ended')
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.sessionId.localeCompare(b.sessionId));
}

export type RefResolution =
  | { ok: true; server: string; sessionId: string }
  | { ok: true; server: string | null; query: string }
  | { ok: false; error: string };

/** Split `server:rest` when `server` is a known server; otherwise the whole string is the ref. */
function splitServer(raw: string, serverNames: string[]): { server: string | null; rest: string } {
  const colon = raw.indexOf(':');
  if (colon > 0) {
    const head = raw.slice(0, colon);
    if (serverNames.includes(head)) return { server: head, rest: raw.slice(colon + 1).trim() };
  }
  return { server: null, rest: raw.trim() };
}

/** Turn what the user typed into a server + session id (a number from the last ls) or a query. */
export function resolveRef(raw: string, ctx: { serverNames: string[]; lastLs: LastLsEntry[] }): RefResolution {
  const { server, rest } = splitServer(raw, ctx.serverNames);
  if (!rest) return { ok: false, error: `Name a session: a number from aasc ls, an id prefix, or words from its title.` };
  if (/^\d+$/.test(rest)) {
    const n = Number(rest);
    const hits = ctx.lastLs.filter((e) => e.n === n && (server === null || e.server === server));
    if (hits.length === 1) return { ok: true, server: hits[0].server, sessionId: hits[0].sessionId };
    if (hits.length > 1) {
      return { ok: false, error: `Several servers have #${n}: ${hits.map((h) => `${h.server}:${n}`).join(', ')}. Name one.` };
    }
    return { ok: false, error: `Unknown session "${raw}". Run aasc ls.` };
  }
  return { ok: true, server, query: rest };
}

export type MatchResult =
  | { ok: true; session: RemoteSession }
  | { ok: false; reason: 'none' | 'ambiguous'; error: string };

/**
 * The shortest id prefix that counts as an id. Shorter, an ordinary hex-looking word ("db",
 * "cafe") could silently pick an unrelated session whose id happens to start with it.
 */
export const MIN_ID_PREFIX = 6;

/**
 * A session by id prefix (≥ MIN_ID_PREFIX characters) or by every word of its display title.
 * Exactly one session across both is a match; an id hit and a different title hit are ambiguous.
 */
export function matchSession(query: string, sessions: RemoteSession[]): MatchResult {
  const q = query.trim();
  const byId = q.length >= MIN_ID_PREFIX ? sessions.filter((s) => s.sessionId.startsWith(q)) : [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const byTitle = sessions.filter((s) => {
    const title = sessionDisplayTitle(s).toLowerCase();
    return words.length > 0 && words.every((w) => title.includes(w));
  });
  const hits = [...new Set([...byId, ...byTitle])];
  if (hits.length === 1) return { ok: true, session: hits[0] };
  if (hits.length === 0) return { ok: false, reason: 'none', error: `No session matches "${cleanText(q)}". Run aasc ls.` };
  const names = hits.slice(0, 5)
    .map((s) => `  ${cleanText(s.sessionId).slice(0, 8)}  ${cleanText(sessionDisplayTitle(s))}`).join('\n');
  return {
    ok: false,
    reason: 'ambiguous',
    error: `"${cleanText(q)}" matches ${hits.length} sessions:\n${names}\nUse more words, or the number from aasc ls.`,
  };
}
