// sessionRecap.ts — the session peek's Summary (Nov 18 2026): a few lines on what a session has done,
// made when asked and kept on the session (`Session.recap`) until it is asked again.
//
//   POST /api/sessions/:id/recap → request(id) → 202 at once; the result arrives as a session update
//
// Cheap by construction: the input is `recapInput` (the newest typed prompts and the last replies,
// capped at RECAP_INPUT_MAX characters), built here from what the server already holds, so a caller
// cannot choose what goes to the model. One run per session, MAX_CONCURRENT_RECAPS in all. Unlike
// `/sessions/:id/summarize` it never archives the session, and nothing is written to SQLite.
//
// The model call is injected (`runModel`): apiRouter passes the same `claude -p` run the summarizer
// uses (no tools, no MCP servers), and tests pass a fake, so no test starts a process.

import type { Session, SessionRecap } from '../src/types/session.js';
import { RECAP_INSTRUCTION, cleanRecap, recapInput } from '../src/lib/sessionRecap.js';
import log from './logger.js';

export const MAX_CONCURRENT_RECAPS = 2;

export interface RecapDeps {
  getSession: (sessionId: string) => Session | null | undefined;
  /** Store the recap on the session and tell every device. */
  setRecap: (sessionId: string, recap: SessionRecap) => void;
  /** Ask the small model; resolves with its plain-text answer. */
  runModel: (prompt: string) => Promise<string>;
  now?: () => number;
}

export type RecapRequestResult =
  | { ok: true; state: 'running' }
  | { ok: false; status: 400 | 404 | 429; error: string };

/** Words for the person: never a raw error, which can carry paths. */
function reasonOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOENT') return 'the Claude CLI isn’t installed on this Mac';
  if ((err as { killed?: unknown } | null)?.killed === true || code === 'ETIMEDOUT') return 'the summarizer took too long';
  return 'the summarizer failed';
}

export function createRecapService(deps: RecapDeps): { request: (sessionId: string) => RecapRequestResult } {
  const now = deps.now ?? Date.now;
  const running = new Set<string>();

  function request(sessionId: string): RecapRequestResult {
    const session = deps.getSession(sessionId);
    if (!session) return { ok: false, status: 404, error: 'Session not found' };
    if (running.has(sessionId)) return { ok: true, state: 'running' };
    const input = recapInput(session);
    if (!input) return { ok: false, status: 400, error: 'Nothing to summarize yet: no prompt has been typed in this session.' };
    if (running.size >= MAX_CONCURRENT_RECAPS) return { ok: false, status: 429, error: 'Two summaries are already being made. Try again in a moment.' };

    const previous = session.recap?.text ? { text: session.recap.text, promptAt: session.recap.promptAt } : null;
    const keep = previous ? { text: previous.text } : {};
    running.add(sessionId);
    deps.setRecap(sessionId, { state: 'running', ...keep, at: now(), promptAt: previous?.promptAt ?? input.promptAt });

    void deps.runModel(`${RECAP_INSTRUCTION}\n\n--- SESSION ---\n${input.text}`).then(
      (answer) => {
        const text = cleanRecap(answer);
        if (!text) {
          deps.setRecap(sessionId, { state: 'error', ...keep, error: 'the summarizer gave no answer', at: now(), promptAt: previous?.promptAt ?? input.promptAt });
          return;
        }
        deps.setRecap(sessionId, { state: 'done', text, at: now(), promptAt: input.promptAt });
      },
      (err: unknown) => {
        log.error('session-recap', `Recap failed: ${err instanceof Error ? err.message : String(err)}`);
        deps.setRecap(sessionId, { state: 'error', ...keep, error: reasonOf(err), at: now(), promptAt: previous?.promptAt ?? input.promptAt });
      },
    ).finally(() => running.delete(sessionId));
    return { ok: true, state: 'running' };
  }

  return { request };
}
