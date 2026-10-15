// answerKeys/codex.ts — the keys that answer a Codex CLI approval (AASC-43).
//
// Probed in tmux on codex-cli 0.162.1 (Oct 16 2026). The approval overlay names a key
// per choice:
//   1. Yes, proceed (y)
//   2. Yes, and don't ask again for commands that start with `…` (p)   a command (Bash)
//      Yes, and don't ask again for these files (a)                    a file edit (apply_patch)
//   3. No, and tell Codex what to do differently (esc)
// `p` saves a prefix rule to ~/.codex/rules/default.rules, so it holds in every project;
// `a` lasts for the session. Its PermissionRequest names a command `Bash` and an edit
// `apply_patch`. Any other tool's overlay was never probed, so Always is unknown there.
// AASC_CODEX_ANSWER_KEYS=0 turns every Codex answer off (the card sends the user to the
// terminal). test/answerKeys.test.ts pins this table: probe again before changing it.

import type { PendingRequest } from '../../src/types/session.js';
import type { Answer } from './types.js';

const ESC = '\x1b';

/** "Don't ask again", by the tool the PermissionRequest names. */
const ALWAYS_KEYS: Readonly<Record<string, string>> = {
  Bash: 'p',
  apply_patch: 'a',
};

/** The keys for this answer, or null when AASC can't be sure what they would pick. */
export function codexAnswerKeys(request: PendingRequest, answer: Answer, env: NodeJS.ProcessEnv): string | null {
  if (env.AASC_CODEX_ANSWER_KEYS === '0' || request.kind !== 'permission') return null;
  if (answer.choice === 'allow_once') return 'y';
  if (answer.choice === 'deny') return ESC;
  if (answer.choice === 'allow_always') return ALWAYS_KEYS[request.tool] ?? null;
  return null;
}
