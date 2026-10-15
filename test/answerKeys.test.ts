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
