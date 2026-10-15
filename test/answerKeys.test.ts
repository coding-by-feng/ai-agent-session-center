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

describe('Claude Code', () => {
  it('permission: allow once = 1, always allow = 2, deny = Esc', () => {
    expect(answerKeysFor(request(), { choice: 'allow_once' }, {})).toBe('1');
    expect(answerKeysFor(request(), { choice: 'allow_always' }, {})).toBe('2');
    expect(answerKeysFor(request(), { choice: 'deny' }, {})).toBe(ESC);
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

describe('Codex (unverified: off unless AASC_CODEX_ANSWER_KEYS=1)', () => {
  const codex = (over: Partial<PendingRequest> = {}) => request({ cli: 'codex', tool: 'shell', ...over });

  it('is unknown for every choice by default', () => {
    for (const choice of ['allow_once', 'allow_always', 'deny'] as const) {
      expect(answerKeysFor(codex(), { choice }, {})).toBeNull();
      expect(answerKeysFor(codex(), { choice }, { AASC_CODEX_ANSWER_KEYS: 'true' })).toBeNull();
    }
  });

  it('with the switch on: allow once = y, always = a, deny = Esc', () => {
    const env = { AASC_CODEX_ANSWER_KEYS: '1' };
    expect(answerKeysFor(codex(), { choice: 'allow_once' }, env)).toBe('y');
    expect(answerKeysFor(codex(), { choice: 'allow_always' }, env)).toBe('a');
    expect(answerKeysFor(codex(), { choice: 'deny' }, env)).toBe(ESC);
    expect(answerKeysFor(codex(), { choice: 'option', optionIndex: 0 }, env)).toBeNull();
    expect(answerKeysFor(codex({ kind: 'plan' }), { choice: 'allow_once' }, env)).toBeNull();
    expect(answerKeysFor(codex({ source: 'timer' }), { choice: 'allow_once' }, env)).toBeNull();
  });
});
