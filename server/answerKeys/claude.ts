// answerKeys/claude.ts — the keys that answer a Claude Code dialog (AASC-43).
//
// The permission dialog lists numbered options and a digit picks one:
//   1. Yes   2. Yes, and don't ask again for …   3. No, and tell Claude what to do differently (esc)
// When a call can't be saved as a rule there is no "don't ask again" line, and 2 is
// believed to land on "No": the safe way round. Esc is "No".
// A single-select AskUserQuestion numbers its choices the same way.
//
// NOT re-probed on the installed CLI yet. The plan (11 §3.3) wants each entry recorded
// from a tmux probe of the installed version, and test/answerKeys.test.ts pins this table:
// change a key only after such a probe. Plan approval (ExitPlanMode) changes its options
// between versions, so it stays unknown and the card sends the user to the terminal.

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
  if (request.kind === 'permission') return PERMISSION_KEYS[answer.choice] ?? null;
  if (request.kind === 'question') {
    // `options` is present only for one single-select question of at most 9 choices.
    const { optionIndex } = answer;
    if (answer.choice !== 'option' || !request.options || optionIndex === undefined) return null;
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= request.options.length) return null;
    return String(optionIndex + 1);
  }
  return null;
}
