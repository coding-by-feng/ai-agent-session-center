// test/answerKeys.test.ts — AASC-43: the keys an answer presses, by CLI and kind of request.
// This test pins the tables: change a key only after probing the installed CLI.
import { describe, it, expect } from 'vitest';
import { answerKeysFor } from '../server/answerKeys/index.js';
import type { PendingRequest } from '../src/types/session.js';

const ESC = '\x1b';

function request(over: Partial<PendingRequest> = {}): PendingRequest {
  return { id: 'r1', kind: 'permission', cli: 'claude', tool: 'Bash', input: { command: 'ls' }, raisedAt: 1, source: 'permission_request', ...over };
}
const question = (over: Partial<PendingRequest> = {}) =>
  request({ kind: 'question', tool: 'AskUserQuestion', source: 'pre_tool_use', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], ...over });

// Probed on Claude Code 2.1.318 (Nov 6 2026): a digit per question, then "1. Submit answers";
// keys in one burst are dropped, so each is its own step.
describe('Claude Code: several questions in one call', () => {
  const several = () => question({
    options: undefined,
    questions: [
      { question: 'Color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }] },
      { question: 'Size?', header: 'Size', options: [{ label: 'Small' }, { label: 'Large' }] },
    ],
  });

  it('types each pick as its own step, then Submit', () => {
    expect(answerKeysFor(several(), { choice: 'options', optionIndexes: [2, 1] }, {})).toEqual(['3', '2', '1']);
  });

  it('refuses a missing, short, long or out-of-range set, and a single pick', () => {
    expect(answerKeysFor(several(), { choice: 'options' }, {})).toBeNull();
    expect(answerKeysFor(several(), { choice: 'options', optionIndexes: [0] }, {})).toBeNull();
    expect(answerKeysFor(several(), { choice: 'options', optionIndexes: [0, 0, 0] }, {})).toBeNull();
    expect(answerKeysFor(several(), { choice: 'options', optionIndexes: [0, 2] }, {})).toBeNull();
    expect(answerKeysFor(several(), { choice: 'option', optionIndex: 0 }, {})).toBeNull();
    expect(answerKeysFor(question(), { choice: 'options', optionIndexes: [0] }, {})).toBeNull();
  });
});

// Probed on Claude Code 2.1.327 (Nov 18 2026). Each dialog ends its choices with "N+1. Type something."
// and "Chat about this". Single-select: the N+1 digit focuses the text line, the text is typed there,
// Enter answers (and, among several questions, moves on). Multi-select: a digit ticks a box and the
// cursor stays on row 1; the text line is reached with ↓ × N (pressing its digit only ticks an empty
// box, which is dropped); Tab leaves the question, except from the text line, where Tab lands on the
// "Next"/"Submit" row and Enter leaves. Any call with tabs ends on "1. Submit answers".
describe('Claude Code: typed answers and multi-select (choice "answers")', () => {
  const DOWN = '\x1b[B';
  const one = () => question({ options: [{ label: 'Red' }, { label: 'Blue' }] });
  const several = () => question({
    options: undefined,
    questions: [
      { question: 'Color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] },
      { question: 'Toppings?', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese' }, { label: 'Ham' }, { label: 'Olives' }] },
      { question: 'Size?', header: 'Size', options: [{ label: 'Small' }, { label: 'Large' }] },
    ],
  });
  const multiOnly = () => question({
    options: undefined,
    questions: [{ question: 'Toppings?', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese' }, { label: 'Ham' }, { label: 'Olives' }] }],
  });

  it('one single-select question: a pick is its digit; a typed answer is the next digit, the text, Enter', () => {
    expect(answerKeysFor(one(), { choice: 'answers', answers: [{ picks: [1] }] }, {})).toEqual(['2']);
    expect(answerKeysFor(one(), { choice: 'answers', answers: [{ picks: [], other: 'Green please' }] }, {})).toEqual(['3', 'Green please', '\r']);
  });

  it('several questions: each in turn, then Submit', () => {
    const keys = answerKeysFor(several(), { choice: 'answers', answers: [{ picks: [], other: 'Teal' }, { picks: [2, 0] }, { picks: [1] }] }, {});
    expect(keys).toEqual(['3', 'Teal', '\r', '1', '3', '\t', '2', '1']);
  });

  it('a multi-select with a typed answer: ticks, ↓ to the text line, the text, Tab, Enter', () => {
    const keys = answerKeysFor(several(), { choice: 'answers', answers: [{ picks: [0] }, { picks: [1], other: 'Corn' }, { picks: [0] }] }, {});
    expect(keys).toEqual(['1', '2', DOWN, DOWN, DOWN, 'Corn', '\t', '\r', '1', '1']);
  });

  it('one multi-select question still goes through the review', () => {
    expect(answerKeysFor(multiOnly(), { choice: 'answers', answers: [{ picks: [0, 2] }] }, {})).toEqual(['1', '3', '\t', '1']);
    expect(answerKeysFor(multiOnly(), { choice: 'answers', answers: [{ picks: [], other: 'Corn' }] }, {})).toEqual([DOWN, DOWN, DOWN, 'Corn', '\t', '\r', '1']);
  });

  it('types the text as one line of plain characters: no control bytes, no line breaks, at most 500', () => {
    const typed = (other: string) => (answerKeysFor(one(), { choice: 'answers', answers: [{ picks: [], other }] }, {}) as string[])[1];
    expect(typed('  two\nlines\x1b[A\x03 here\t ')).toBe('two lines[A here');
    expect(typed('x'.repeat(900))).toHaveLength(500);
  });

  it('refuses what the dialog cannot take', () => {
    const no = (request: PendingRequest, answers: Array<{ picks: number[]; other?: string }>) =>
      expect(answerKeysFor(request, { choice: 'answers', answers }, {})).toBeNull();
    no(one(), []);                                                   // no answer
    no(one(), [{ picks: [0] }, { picks: [0] }]);                     // more answers than questions
    no(one(), [{ picks: [] }]);                                      // nothing picked or typed
    no(one(), [{ picks: [0, 1] }]);                                  // two picks in a single-select
    no(one(), [{ picks: [0], other: 'x' }]);                         // a pick and a text in a single-select
    no(one(), [{ picks: [2] }]);                                     // out of range
    no(one(), [{ picks: [], other: ' \n ' }]);                       // text that is empty once cleaned
    no(several(), [{ picks: [0] }, { picks: [] }, { picks: [0] }]);  // a multi-select with nothing
    no(several(), [{ picks: [0] }, { picks: [1, 1] }, { picks: [0] }]); // the same box twice
    // Nine choices leave no digit for "Type something" in a single-select.
    no(question({ options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })) }), [{ picks: [], other: 'x' }]);
    no(request(), [{ picks: [0] }]);                                  // not a question
    no(question({ cli: 'codex' }), [{ picks: [0] }]);                 // Codex: never probed
  });
});

describe('Claude Code', () => {
  it('permission: allow once = 1, always allow = 2, deny = Esc', () => {
    expect(answerKeysFor(request(), { choice: 'allow_once' }, {})).toBe('1');
    expect(answerKeysFor(request({ canAlwaysAllow: true }), { choice: 'allow_always' }, {})).toBe('2');
    expect(answerKeysFor(request(), { choice: 'deny' }, {})).toBe(ESC);
  });

  it('always allow is unknown when the dialog offers no "always allow" line: 2 would switch to auto mode', () => {
    // Probed on Claude Code 2.1.300: a call it can't save as a rule lists
    // 1. Yes  2. Yes, and switch to auto mode  3. No
    expect(answerKeysFor(request(), { choice: 'allow_always' }, {})).toBeNull();
    expect(answerKeysFor(request({ canAlwaysAllow: false }), { choice: 'allow_always' }, {})).toBeNull();
    expect(answerKeysFor(request(), { choice: 'allow_once' }, {})).toBe('1');
  });

  it('permission: an option is not a permission answer', () => {
    expect(answerKeysFor(request(), { choice: 'option', optionIndex: 0 }, {})).toBeNull();
  });

  it('a permission raised by PreToolUse (no dialog of its own) is answered the same', () => {
    expect(answerKeysFor(request({ source: 'pre_tool_use' }), { choice: 'allow_once' }, {})).toBe('1');
  });

  it('question: the option’s digit, 1-based', () => {
    expect(answerKeysFor(question(), { choice: 'option', optionIndex: 0 }, {})).toBe('1');
    expect(answerKeysFor(question(), { choice: 'option', optionIndex: 2 }, {})).toBe('3');
  });

  it('question: an option it does not offer, or no option at all, is unknown', () => {
    expect(answerKeysFor(question(), { choice: 'option', optionIndex: 3 }, {})).toBeNull();
    expect(answerKeysFor(question(), { choice: 'option', optionIndex: -1 }, {})).toBeNull();
    expect(answerKeysFor(question(), { choice: 'option', optionIndex: 1.5 }, {})).toBeNull();
    expect(answerKeysFor(question(), { choice: 'option' }, {})).toBeNull();
    expect(answerKeysFor(question(), { choice: 'allow_once' }, {})).toBeNull();
    expect(answerKeysFor(question(), { choice: 'deny' }, {})).toBeNull();
  });

  it('question: several questions or multi-select (no options on the request) are unknown', () => {
    expect(answerKeysFor(question({ options: undefined }), { choice: 'option', optionIndex: 0 }, {})).toBeNull();
  });

  it('plan approval is unknown for every choice', () => {
    const plan = request({ kind: 'plan', tool: 'ExitPlanMode', source: 'pre_tool_use' });
    for (const choice of ['allow_once', 'allow_always', 'deny', 'option'] as const) {
      expect(answerKeysFor(plan, { choice, optionIndex: 0 }, {})).toBeNull();
    }
  });

  it('an ambiguous request (another dialog may be showing) is never answered', () => {
    expect(answerKeysFor(request({ ambiguous: true }), { choice: 'allow_once' }, {})).toBeNull();
    expect(answerKeysFor(question({ ambiguous: true }), { choice: 'option', optionIndex: 0 }, {})).toBeNull();
    expect(answerKeysFor(request({ ambiguous: true }), { choice: 'deny' }, {})).toBeNull();
  });

  it('a guess (timer or notification) is never answered: nobody saw what it asks', () => {
    expect(answerKeysFor(request({ source: 'timer', input: undefined }), { choice: 'allow_once' }, {})).toBeNull();
    expect(answerKeysFor(request({ source: 'notification', input: undefined }), { choice: 'deny' }, {})).toBeNull();
  });
});

describe('Codex (probed on codex-cli 0.162.1; AASC_CODEX_ANSWER_KEYS=0 turns it off)', () => {
  // 1. Yes, proceed (y)  2. Yes, and don't ask again … (p for a command, a for file edits)
  // 3. No, and tell Codex what to do differently (esc)
  const codex = (over: Partial<PendingRequest> = {}) => request({ cli: 'codex', tool: 'Bash', ...over });

  it('a command: allow once = y, always = p (a saved prefix rule), deny = Esc', () => {
    expect(answerKeysFor(codex(), { choice: 'allow_once' }, {})).toBe('y');
    expect(answerKeysFor(codex(), { choice: 'allow_always' }, {})).toBe('p');
    expect(answerKeysFor(codex(), { choice: 'deny' }, {})).toBe(ESC);
  });

  it('a file edit: always = a (these files, this session)', () => {
    expect(answerKeysFor(codex({ tool: 'apply_patch' }), { choice: 'allow_once' }, {})).toBe('y');
    expect(answerKeysFor(codex({ tool: 'apply_patch' }), { choice: 'allow_always' }, {})).toBe('a');
    expect(answerKeysFor(codex({ tool: 'apply_patch' }), { choice: 'deny' }, {})).toBe(ESC);
  });

  it('always is unknown for any other tool: its dialog was never probed', () => {
    expect(answerKeysFor(codex({ tool: 'mcp__github__create_issue' }), { choice: 'allow_always' }, {})).toBeNull();
    expect(answerKeysFor(codex({ tool: 'mcp__github__create_issue' }), { choice: 'allow_once' }, {})).toBe('y');
  });

  it('AASC_CODEX_ANSWER_KEYS=0 makes every Codex answer unknown', () => {
    for (const choice of ['allow_once', 'allow_always', 'deny'] as const) {
      expect(answerKeysFor(codex(), { choice }, { AASC_CODEX_ANSWER_KEYS: '0' })).toBeNull();
    }
  });

  it('never an option, a plan or a guess', () => {
    expect(answerKeysFor(codex(), { choice: 'option', optionIndex: 0 }, {})).toBeNull();
    expect(answerKeysFor(codex({ kind: 'plan' }), { choice: 'allow_once' }, {})).toBeNull();
    expect(answerKeysFor(codex({ source: 'timer' }), { choice: 'allow_once' }, {})).toBeNull();
  });
});
