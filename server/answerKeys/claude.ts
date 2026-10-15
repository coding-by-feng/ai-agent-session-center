// answerKeys/claude.ts — the keys that answer a Claude Code dialog (AASC-43).
//
// Probed in tmux on Claude Code 2.1.300 (Oct 16 2026). The permission dialog numbers its
// options and a digit picks one at once:
//   1. Yes   2. Yes, and always allow …   3. Yes, and switch to auto mode   4. No
// A call it can't save as a rule (its PermissionRequest has no permission_suggestions)
// drops the "always allow" line, and then 2 is "Yes, and switch to auto mode": so 2 is
// sent only for a request marked `canAlwaysAllow`. Esc cancels: the call is refused and
// Claude waits for what to do instead. A single-select AskUserQuestion numbers its
// choices the same way, and a digit picks and submits.
//
// test/answerKeys.test.ts pins this table: change a key only after probing the installed
// CLI again. Plan approval (ExitPlanMode) changes its options between versions, so it
// stays unknown and the card sends the user to the terminal.

import type { PendingRequest } from '../../src/types/session.js';
import type { Answer } from './types.js';

const ESC = '\x1b';

const PERMISSION_KEYS: Readonly<Record<string, string>> = {
  allow_once: '1',
  allow_always: '2',
  deny: ESC,
};

/** The keys for this answer, or null when AASC can't be sure what they would pick. */
export function claudeAnswerKeys(request: PendingRequest, answer: Answer): string | null {
  if (request.kind === 'permission') {
    if (answer.choice === 'allow_always' && request.canAlwaysAllow !== true) return null;
    return PERMISSION_KEYS[answer.choice] ?? null;
  }
  if (request.kind === 'question') {
    // `options` is present only for one single-select question of at most 9 choices.
    const { optionIndex } = answer;
    if (answer.choice !== 'option' || !request.options || optionIndex === undefined) return null;
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= request.options.length) return null;
    return String(optionIndex + 1);
  }
  return null;
}
