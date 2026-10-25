// ledgerApi.ts — the ledger's three /api calls, made over the loopback client of the central the task is for (so
// each carries `mcp:<centralId>`): the prompt it types (POST /sessions/:id/prompt, the shared AASC-42 submitter),
// how that send went (GET /sessions/:id/prompt/:key, with why the route stopped a central's send), and the task's
// turn it reads back (GET /sessions/:id/chat with `assistantCap`, so the answer comes whole up to ANSWER_MAX: Ruling
// 48). The route logic stays the routes'; this only reads their answers.
//
// What reaches a task record is the routes' own words (a refusal's code and error); a call that got no answer at
// all is said in fixed words, its details only in the server log.

import type { ChatEntry, ChatPage } from '../../src/types/chat.js';
import log from '../logger.js';
import type { InternalClient, InternalResponse } from './client.js';
import { ANSWER_MAX } from './ledgerTurn.js';
import type { LedgerDeps, PromptOutcomeState, PromptOutcomeView, PromptStopReason, SubmitAnswer } from './ledgerTypes.js';
import { isRecord, nonEmptyString, oneLine, seg, unwrap } from './tools/define.js';

const OUTCOMES: ReadonlySet<string> = new Set<PromptOutcomeState>(['submitted', 'unconfirmed', 'stopped', 'gave-up', 'failed']);
const STOP_REASONS: ReadonlySet<string> = new Set<PromptStopReason>(['hands-off', 'person']);
const WORDS_MAX = 200;
/** Pages read back at most for one answer: a turn longer than that is read from its send time on. */
export const CHAT_PAGES_MAX = 5;

/** A refused send in the route's words: `code: error` when it gave a code. */
function refusalWords(r: InternalResponse<unknown>): string {
  const body = isRecord(r.data) ? r.data : {};
  const code = nonEmptyString(body.code);
  const words = oneLine(r.error ?? `HTTP ${r.status}`, WORDS_MAX);
  return code === null ? words : `${oneLine(code, 40)}: ${words}`;
}

/** Have the pages read reached the task's own prompt (it begins with `head`), or gone back past its send time? */
function reachedTurnStart(entries: readonly ChatEntry[], head: string, since: number): boolean {
  if (entries.some((e) => e.kind === 'user' && e.text.trimStart().startsWith(head))) return true;
  return entries.length > 0 && entries[0].timestamp < since;
}

/**
 * The ledger's /api deps over `clientFor(centralId)`: that central's loopback client, or null once it is no longer
 * live (then nothing is called, and a read throws).
 */
export function ledgerApi(
  clientFor: (centralId: string) => InternalClient | null,
): Pick<LedgerDeps, 'submit' | 'promptOutcome' | 'readChat'> {
  return {
    async submit(sessionId, text, key, centralId): Promise<SubmitAnswer> {
      const client = clientFor(centralId);
      if (client === null) return { accepted: false, error: 'The central is no longer live.' };
      const r = await client.post(`/sessions/${seg(sessionId)}/prompt`, { text, key, mode: 'now' });
      if (r.ok) return { accepted: true, error: null };
      if (r.status === 0) {
        log.warn('mcp', `A task prompt for central ${centralId} got no answer: ${r.error ?? 'no detail'}`);
        return { accepted: false, error: 'AASC could not be reached.' };
      }
      return { accepted: false, error: refusalWords(r) };
    },

    async promptOutcome(sessionId, key, centralId): Promise<PromptOutcomeView | null> {
      const client = clientFor(centralId);
      if (client === null) return null;
      const r = await client.get(`/sessions/${seg(sessionId)}/prompt/${seg(key)}`);
      // 404: the key is gone (it is kept 5 minutes) or the session with it; the ledger waits on its hooks instead.
      if (!r.ok) return null;
      const data = unwrap<unknown>(r);
      const state = isRecord(data) ? data.state : null;
      if (typeof state !== 'string' || !OUTCOMES.has(state)) return null;
      const by = isRecord(data) ? data.stoppedBy : null;
      return typeof by === 'string' && STOP_REASONS.has(by)
        ? { state: state as PromptOutcomeState, stoppedBy: by as PromptStopReason }
        : { state: state as PromptOutcomeState };
    },

    async readChat(sessionId, head, since, centralId): Promise<readonly ChatEntry[]> {
      const client = clientFor(centralId);
      if (client === null) throw new Error('The central is no longer live.');
      let entries: readonly ChatEntry[] = [];
      let before: string | undefined;
      for (let page = 0; page < CHAT_PAGES_MAX; page += 1) {
        const query = { assistantCap: String(ANSWER_MAX), ...(before === undefined ? {} : { before }) };
        const read = unwrap<ChatPage>(await client.get(`/sessions/${seg(sessionId)}/chat`, query));
        const got = Array.isArray(read.entries) ? read.entries : [];
        // A reset is the newest page of a new file (a /clear): what was read before belongs to the old one.
        entries = read.reset === true ? got : [...got, ...entries];
        if (read.reset === true || reachedTurnStart(entries, head, since) || !read.hasMore || read.before === null) break;
        before = read.before;
      }
      return entries;
    },
  };
}
