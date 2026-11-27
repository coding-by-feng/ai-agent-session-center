/**
 * sentPrompts — what the queue's History → Sent tab lists (Nov 27 2026): every prompt this session was sent,
 * newest first, whether it came from the queue, the terminal, Chat or another device.
 *
 * Two sources, merged:
 *   - the card's `promptHistory` (in memory, the last 50, `MAX_PROMPT_HISTORY_ENTRIES`): shown at once;
 *   - `GET /api/db/prompts?session=<id>&kind=mine` (the `prompts` table, every prompt ever recorded, a page at
 *     a time). `insertFullPrompt` writes the row with the same timestamp `pushPrompt` gives the card, so the
 *     two copies of one prompt share `timestamp` and are kept once.
 * Rows a person never typed (harness tags, starting with `<`) and blank rows are left out, as the database's
 * `mine` facet does (prompt-trace.md).
 */
import type { PromptEntry, PromptSearchResponse } from '@/types';

export const SENT_PAGE_SIZE = 50;

export interface SentPrompt {
  text: string;
  timestamp: number;
}

/** A row the user typed: not blank and not a harness tag. */
export function isTypedPrompt(text: string | null | undefined): boolean {
  const trimmed = (text ?? '').trimStart();
  return trimmed !== '' && !trimmed.startsWith('<');
}

/**
 * What the server appends when it shortens a card's prompt (`TRUNCATION_MARKER`, server/sessionTrim.ts): the
 * card's copy is `text.slice(0, max) + marker`, so it is only a prefix of the stored row once this is cut off.
 */
const CARD_TRUNCATION_MARKER = '\n\n[… truncated — full prompt kept in the session transcript]';

const withoutMarker = (text: string) =>
  text.endsWith(CARD_TRUNCATION_MARKER) ? text.slice(0, -CARD_TRUNCATION_MARKER.length) : text;

/** The same prompt seen twice: one timestamp, and one text a prefix of the other (the card trims long text). */
function samePrompt(a: SentPrompt, b: SentPrompt): boolean {
  const ta = withoutMarker(a.text);
  const tb = withoutMarker(b.text);
  return a.timestamp === b.timestamp && (ta.startsWith(tb) || tb.startsWith(ta));
}

/** Both lists as one, newest first, each prompt once, keeping its fuller copy (the stored row over a cut card). */
export function mergeSentPrompts(memory: readonly SentPrompt[], stored: readonly SentPrompt[]): SentPrompt[] {
  // Indexed by timestamp: only prompts that share one can be the same prompt.
  const byTime = new Map<number, SentPrompt[]>();
  for (const p of [...stored, ...memory]) {
    if (!isTypedPrompt(p.text)) continue;
    const bucket = byTime.get(p.timestamp) ?? [];
    const at = bucket.findIndex((q) => samePrompt(p, q));
    const copy = { text: p.text, timestamp: p.timestamp };
    if (at === -1) byTime.set(p.timestamp, [...bucket, copy]);
    else if (withoutMarker(p.text).length > withoutMarker(bucket[at].text).length) {
      byTime.set(p.timestamp, bucket.map((q, i) => (i === at ? copy : q)));
    }
  }
  return [...byTime.values()].flat().sort((a, b) => b.timestamp - a.timestamp);
}

/** The card's prompts in the shared shape. */
export function fromPromptHistory(history: readonly PromptEntry[] | undefined): SentPrompt[] {
  return (history ?? []).map((p) => ({ text: p.text, timestamp: p.timestamp }));
}

export interface SentPage {
  prompts: SentPrompt[];
  /** More pages are stored. */
  more: boolean;
}

export function sentPromptsUrl(sessionId: string, page: number): string {
  const params = new URLSearchParams({
    session: sessionId,
    kind: 'mine',
    sortDir: 'desc',
    page: String(page),
    pageSize: String(SENT_PAGE_SIZE),
  });
  return `/api/db/prompts?${params.toString()}`;
}

/** Read one stored page; throws on a refusal or a bad answer, so the caller can say so. */
export async function fetchSentPage(
  sessionId: string,
  page: number,
  doFetch: (url: string) => Promise<Response>,
): Promise<SentPage> {
  const res = await doFetch(sentPromptsUrl(sessionId, page));
  if (!res.ok) throw new Error(res.status === 429 ? 'Too many requests. Try again in a minute.' : `The Mac answered ${res.status}.`);
  const data = (await res.json()) as Partial<PromptSearchResponse>;
  const rows = Array.isArray(data.prompts) ? data.prompts : [];
  const prompts = rows
    .filter((r) => typeof r?.text === 'string' && typeof r?.timestamp === 'number')
    .map((r) => ({ text: r.text, timestamp: r.timestamp }));
  const total = typeof data.total === 'number' ? data.total : 0;
  return { prompts, more: page * SENT_PAGE_SIZE < total };
}
