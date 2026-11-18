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
// Several single-select questions in one call (probed on 2.1.318, Nov 6 2026) show as tabs
// "☐ Color ☐ Size ✔ Submit": a digit picks and moves on, and after the last a review screen
// offers "1. Submit answers  2. Cancel". Keys sent in one burst ("321") are dropped; each must
// arrive on its own, so this returns them as separate steps.
//
// Typed answers and multi-select (probed on 2.1.327, Nov 18 2026). Every question's list ends with
// "N+1. Type something." and "Chat about this".
//   single-select   the N+1 digit focuses the text line, the text is typed in place, Enter answers
//                   (alone: at once; among several: on to the next tab)
//   multi-select    "N. [ ] Label": a digit ticks a box and the cursor stays on row 1. Pressing the
//                   text line's digit only ticks an EMPTY box, which the review drops: the line is
//                   reached with ↓ × N and typing there fills and ticks it. Tab leaves the question
//                   (next tab, or the review), except from the text line, where Tab lands on the
//                   "Next" / "Submit" row and Enter leaves.
//   a call with tabs (several questions, or one multi-select) ends on "1. Submit answers".
//
// test/answerKeys.test.ts pins this table: change a key only after probing the installed
// CLI again. Plan approval (ExitPlanMode) changes its options between versions, so it
// stays unknown and the card sends the user to the terminal.

import type { PendingRequest, PendingRequestQuestion } from '../../src/types/session.js';
import type { Answer, QuestionAnswer } from './types.js';

const ESC = '\x1b';
/** "1. Submit answers" on the review screen after the last question. */
const SUBMIT_ANSWERS = '1';

const ENTER = '\r';
const TAB = '\t';
const DOWN = '\x1b[B';
/** The longest typed answer. */
export const TYPED_ANSWER_MAX = 500;

/**
 * A typed answer as the Mac types it: one line of printable characters. Control bytes go (an Esc
 * would cancel the dialog, an Enter would answer early), line breaks and tabs become spaces.
 */
export function cleanTypedAnswer(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, TYPED_ANSWER_MAX);
}

/** The keys that answer one question, or null. `tabs`: the call shows tabs (several questions, or a multi-select). */
function questionKeys(question: Pick<PendingRequestQuestion, 'options' | 'multiSelect'>, answer: QuestionAnswer | undefined): string[] | null {
  if (!answer || !Array.isArray(answer.picks)) return null;
  const count = question.options.length;
  const picks = answer.picks;
  if (!picks.every((p) => Number.isInteger(p) && p >= 0 && p < count) || new Set(picks).size !== picks.length) return null;
  const typed = answer.other === undefined ? '' : cleanTypedAnswer(answer.other);
  if (answer.other !== undefined && typed === '') return null;
  if (question.multiSelect) {
    if (picks.length === 0 && !typed) return null;
    const ticks = [...picks].sort((a, b) => a - b).map((p) => String(p + 1));
    return typed ? [...ticks, ...Array<string>(count).fill(DOWN), typed, TAB, ENTER] : [...ticks, TAB];
  }
  if (typed) {
    // "Type something" is choice N+1: with nine choices it has no digit.
    if (picks.length !== 0 || count + 1 > 9) return null;
    return [String(count + 1), typed, ENTER];
  }
  return picks.length === 1 ? [String(picks[0] + 1)] : null;
}

/** `answers`: one per question, in order (Nov 18 2026). */
function answersKeys(request: PendingRequest, answers: QuestionAnswer[] | undefined): string[] | null {
  if (!Array.isArray(answers)) return null;
  // One single-select question (`options`) has no tabs and no review screen.
  const alone = !request.questions && request.options ? [{ options: request.options }] : null;
  const questions = request.questions ?? alone;
  if (!questions || answers.length !== questions.length) return null;
  const keys: string[] = [];
  for (let i = 0; i < questions.length; i += 1) {
    const step = questionKeys(questions[i], answers[i]);
    if (!step) return null;
    keys.push(...step);
  }
  return alone ? keys : [...keys, SUBMIT_ANSWERS];
}

const PERMISSION_KEYS: Readonly<Record<string, string>> = {
  allow_once: '1',
  allow_always: '2',
  deny: ESC,
};

/** The keys for this answer (an array: separate steps), or null when AASC can't be sure what they would pick. */
export function claudeAnswerKeys(request: PendingRequest, answer: Answer): string | string[] | null {
  if (request.kind === 'permission') {
    if (answer.choice === 'allow_always' && request.canAlwaysAllow !== true) return null;
    return PERMISSION_KEYS[answer.choice] ?? null;
  }
  if (request.kind === 'question' && answer.choice === 'answers') return answersKeys(request, answer.answers);
  if (request.kind === 'question' && answer.choice === 'options') {
    // The older shape: one pick each, single-select questions only.
    if (request.questions?.some((q) => q.multiSelect)) return null;
    const { questions } = request;
    const picks = answer.optionIndexes;
    if (!questions || !picks || picks.length !== questions.length) return null;
    const ok = picks.every((pick, i) => Number.isInteger(pick) && pick >= 0 && pick < questions[i].options.length);
    return ok ? [...picks.map((pick) => String(pick + 1)), SUBMIT_ANSWERS] : null;
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
