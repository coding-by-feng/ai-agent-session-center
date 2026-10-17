/**
 * answerApi.ts — answer a waiting request from its card (AASC-43).
 *
 * `POST /api/sessions/:id/requests/:requestId/answer` with `{ choice,
 * optionIndex? }`: intent, never keystrokes and never text. The Mac answers
 * only if the session still waits on that very request (else 409 stale:
 * "Already answered on your Mac"), this phone may drive it (423 names who
 * does), and it knows which keys the CLI's dialog takes (422: only the
 * terminal can answer). Then it presses the keys itself (server/requestAnswer.ts).
 */
import type { PromptDriver } from './promptApi';

export type AnswerChoice = 'allow_once' | 'allow_always' | 'deny' | 'option';

export interface Answer {
  choice: AnswerChoice;
  /** 0-based, for `option`. */
  optionIndex?: number;
}

export type AnswerErrorCode =
  | 'stale'
  | 'unknown_prompt'
  | 'input_truncated'
  | 'control_held'
  | 'no_terminal'
  | 'agent_not_running'
  | 'not_found'
  | 'rate_limited'
  | 'invalid'
  | 'network'
  | 'failed';

export type AnswerResult =
  | { ok: true }
  | {
      ok: false;
      code: AnswerErrorCode;
      message: string;
      /** Only the terminal can answer this one: the card keeps just "Open terminal". */
      terminalOnly?: boolean;
      driver?: PromptDriver | null;
      retryAfter?: number;
    };

interface Reply {
  code?: unknown;
  driver?: unknown;
  retryAfter?: unknown;
}

function driverOf(value: unknown): PromptDriver | null {
  if (!value || typeof value !== 'object') return null;
  const { label, online } = value as Record<string, unknown>;
  return typeof label === 'string' ? { label, online: online === true } : null;
}

function failureFor(status: number, reply: Reply | null): AnswerResult {
  const code = typeof reply?.code === 'string' ? reply.code : '';
  if (status === 409 && code === 'stale') return { ok: false, code: 'stale', message: 'Already answered on your Mac' };
  if (status === 409 && code === 'no_terminal') {
    return { ok: false, code: 'no_terminal', message: 'This session has no live terminal to answer in.' };
  }
  if (status === 409 && code === 'AGENT_NOT_RUNNING') {
    return { ok: false, code: 'agent_not_running', message: 'The agent isn’t running in this session’s terminal.' };
  }
  if (status === 422 && code === 'input_truncated') {
    return {
      ok: false,
      code: 'input_truncated',
      message: 'This request is too long to show here in full. Allow it in the terminal.',
      terminalOnly: true,
    };
  }
  if (status === 422) {
    return {
      ok: false,
      code: 'unknown_prompt',
      message: 'Your Mac can’t tell which choices the agent is showing. Answer it in the terminal.',
      terminalOnly: true,
    };
  }
  if (status === 423) {
    const driver = driverOf(reply?.driver);
    return {
      ok: false,
      code: 'control_held',
      // No device holds a session any more (Oct 2026): a 423 only means the Mac didn't know this phone.
      message: 'Your Mac didn’t recognise this phone. Reload the app and try again.',
      driver,
    };
  }
  if (status === 404) return { ok: false, code: 'not_found', message: 'This session ended, or it isn’t shared with this phone any more.' };
  if (status === 429) {
    const retryAfter = typeof reply?.retryAfter === 'number' && reply.retryAfter > 0 ? Math.ceil(reply.retryAfter) : undefined;
    return {
      ok: false,
      code: 'rate_limited',
      message: retryAfter ? `Too many answers from this phone. Try again in ${retryAfter} s.` : 'Too many answers from this phone. Wait a moment.',
      retryAfter,
    };
  }
  if (status === 400) return { ok: false, code: 'invalid', message: 'Your Mac couldn’t read that answer.' };
  return { ok: false, code: 'failed', message: 'Your Mac couldn’t answer right now. Try again, or use the terminal.' };
}

/** Answer request `requestId` of session `sessionId`. Never throws. */
export async function answerRequest(sessionId: string, requestId: string, answer: Answer): Promise<AnswerResult> {
  const body: Answer = answer.choice === 'option' ? { choice: 'option', optionIndex: answer.optionIndex } : { choice: answer.choice };
  let res: Response;
  try {
    res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}/answer`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
  } catch {
    return { ok: false, code: 'network', message: 'Couldn’t reach your Mac. Check the connection and try again.' };
  }
  if (res.ok) return { ok: true };
  const reply = (await res.json().catch(() => null)) as Reply | null;
  return failureFor(res.status, reply);
}
