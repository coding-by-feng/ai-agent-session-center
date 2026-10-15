// answerKeys/codex.ts — the keys that answer a Codex CLI approval (AASC-43).
//
// UNVERIFIED. Codex's approval overlay is believed to take y (approve once), a (approve
// for the session) and Esc (deny), but nobody has checked that against the installed
// CLI, and a wrong key here types into the agent's prompt. So every Codex answer is
// unknown (the card sends the user to the terminal) unless AASC_CODEX_ANSWER_KEYS=1.
// Before turning that on, or on by default, verify each key with a tmux probe of the
// installed codex and pin the result in test/answerKeys.test.ts.

import type { PendingRequest } from '../../src/types/session.js';
import type { Answer } from './types.js';

const ESC = '\x1b';

const PERMISSION_KEYS: Readonly<Record<string, string>> = {
  allow_once: 'y',
  allow_always: 'a',
  deny: ESC,
};

/** The keys for this answer, or null when AASC can't be sure what they would pick. */
export function codexAnswerKeys(request: PendingRequest, answer: Answer, env: NodeJS.ProcessEnv): string | null {
  if (env.AASC_CODEX_ANSWER_KEYS !== '1') return null;
  return request.kind === 'permission' ? PERMISSION_KEYS[answer.choice] ?? null : null;
}
