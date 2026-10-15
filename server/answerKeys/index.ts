// answerKeys/index.ts — choice → key sequence, by CLI and kind of request (AASC-43).
//
// The answer route never types bytes from the client: it types what this returns, and
// answers 422 (open the terminal) on null.

import type { PendingRequest } from '../../src/types/session.js';
import type { Answer } from './types.js';
import { claudeAnswerKeys } from './claude.js';
import { codexAnswerKeys } from './codex.js';

export type { Answer, AnswerChoice } from './types.js';

/**
 * The keys that give `answer` to `request`, or null when AASC can't be sure what they
 * would do. A guessed wait (timer, notification) is never answered: nobody has seen
 * what the CLI asks, or that it asks anything. Nor is an ambiguous one: the CLI may be
 * showing another request's dialog.
 */
export function answerKeysFor(request: PendingRequest, answer: Answer, env: NodeJS.ProcessEnv = process.env): string | null {
  if (request.source === 'timer' || request.source === 'notification' || request.ambiguous) return null;
  if (request.cli === 'claude') return claudeAnswerKeys(request, answer);
  if (request.cli === 'codex') return codexAnswerKeys(request, answer, env);
  return null;
}
