/**
 * sessionContentSearch.ts — search what the sessions said and did: prompts, answers,
 * tool calls and events, in the session objects already in memory (no request).
 *
 * One search for the desktop's ⇧⌘F modal (GlobalSearchModal) and the phone's Sessions
 * search, where matches show under "In conversations" (Oct 20 2026). It matches with
 * textHighlight's predicate, so a row's highlight always agrees with why it was listed.
 */
import type { Session } from '@/types/session';
import { matchesQuery, normalizeQuery } from '@/lib/textHighlight';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';

export type ContentField = 'prompt' | 'response' | 'tool' | 'event';

export interface ContentHit {
  sessionId: string;
  sessionTitle: string;
  sessionStatus: string;
  field: ContentField;
  snippet: string;
  timestamp: number;
}

/** Working sessions first: what is happening now outranks what happened. */
const STATUS_ORDER: Record<string, number> = { working: 0, prompting: 1, approval: 2, input: 2, waiting: 3, idle: 4, connecting: 5, ended: 6 };

export const CONTENT_SEARCH_LIMIT = 100;

export function searchSessionContent(sessions: Iterable<Session>, query: string, limit = CONTENT_SEARCH_LIMIT): ContentHit[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const hits: ContentHit[] = [];
  for (const session of sessions) {
    const base = {
      sessionId: session.sessionId,
      sessionTitle: sessionDisplayTitle(session),
      sessionStatus: session.status,
    };
    const add = (field: ContentField, snippet: string, timestamp: number) => {
      if (matchesQuery(snippet, q)) hits.push({ ...base, field, snippet, timestamp });
    };
    for (const p of session.promptHistory ?? []) add('prompt', p.text, p.timestamp);
    for (const r of session.responseLog ?? []) add('response', r.text ?? '', r.timestamp);
    for (const t of session.toolLog ?? []) add('tool', `${t.tool} ${t.input ?? ''}`, t.timestamp);
    for (const e of session.events ?? []) add('event', `${e.type} ${e.detail ?? ''}`, e.timestamp);
  }
  hits.sort((a, b) => ((STATUS_ORDER[a.sessionStatus] ?? 5) - (STATUS_ORDER[b.sessionStatus] ?? 5)) || b.timestamp - a.timestamp);
  return hits.slice(0, limit);
}
