// test/pendingRequests.test.ts — AASC-43: what a waiting session is asking, as a structured,
// id'd request a phone card can show and answer. Pure helpers only; the store wiring is in
// pendingRequestLifecycle.test.ts.
import { describe, it, expect } from 'vitest';
import {
  requestKindOf,
  requestCliOf,
  capRequestInput,
  answerableOptions,
  nextPendingRequest,
  guessPendingRequest,
  PENDING_INPUT_MAX_BYTES,
  PENDING_EDIT_INPUT_MAX_BYTES,
  INPUT_TRUNCATION_MARKER,
} from '../server/pendingRequests.js';
import type { PendingRequest } from '../src/types/session.js';

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');
const NOW = 1_800_000_000_000;

function next(
  current: PendingRequest | null,
  event: string,
  hook: Record<string, unknown> = {},
  cli: 'claude' | 'codex' | null = 'claude',
): PendingRequest | null {
  return nextPendingRequest(current, event, hook, cli, NOW);
}

const ask = (options: unknown[], extra: Record<string, unknown> = {}) => ({
  questions: [{ question: 'Which database?', header: 'DB', multiSelect: false, options, ...extra }],
});

describe('requestKindOf', () => {
  it('reads a question, a plan and everything else as a permission', () => {
    expect(requestKindOf('AskUserQuestion')).toBe('question');
    expect(requestKindOf('ExitPlanMode')).toBe('plan');
    expect(requestKindOf('Bash')).toBe('permission');
    expect(requestKindOf('mcp__github__create_issue')).toBe('permission');
  });
});

describe('requestCliOf', () => {
  it('knows Claude (also when the hook never said) and Codex, and nothing else', () => {
    expect(requestCliOf(undefined)).toBe('claude');
    expect(requestCliOf('claude')).toBe('claude');
    expect(requestCliOf('codex')).toBe('codex');
    expect(requestCliOf('gemini')).toBeNull();
  });
});

describe('capRequestInput', () => {
  it('keeps a small input whole, as a copy', () => {
    const input = { command: 'npm test', description: 'Run the tests' };
    const out = capRequestInput('Bash', input);
    expect(out).toEqual({ input, truncated: false });
    expect(out.input).not.toBe(input);
  });

  it('cuts a command input over 8 KB down to 8 KB and says so', () => {
    const out = capRequestInput('Bash', { command: 'x'.repeat(20_000), description: 'long' });
    expect(out.truncated).toBe(true);
    expect(bytes(out.input)).toBeLessThanOrEqual(PENDING_INPUT_MAX_BYTES);
    const command = (out.input as { command: string }).command;
    expect(command.endsWith(INPUT_TRUNCATION_MARKER)).toBe(true);
    expect((out.input as { description: string }).description).toBe('long');
  });

  it('keeps an edit whole up to 64 KB', () => {
    const input = { file_path: '/p/a.ts', old_string: 'a'.repeat(25_000), new_string: 'b'.repeat(25_000) };
    expect(capRequestInput('Edit', input)).toEqual({ input, truncated: false });
    expect(capRequestInput('Write', { file_path: '/p/b.ts', content: 'c'.repeat(60_000) }).truncated).toBe(false);
  });

  it('cuts an edit over 64 KB down to 64 KB', () => {
    const out = capRequestInput('Edit', { file_path: '/p/a.ts', old_string: 'a'.repeat(50_000), new_string: 'é'.repeat(50_000) });
    expect(out.truncated).toBe(true);
    expect(bytes(out.input)).toBeLessThanOrEqual(PENDING_EDIT_INPUT_MAX_BYTES);
    expect((out.input as { file_path: string }).file_path).toBe('/p/a.ts');
  });

  it('falls back to a cut preview when no string is long enough to cut', () => {
    const many = Array.from({ length: 5_000 }, (_, i) => i);
    const out = capRequestInput('mcp__x__y', { many });
    expect(out.truncated).toBe(true);
    expect(bytes(out.input)).toBeLessThanOrEqual(PENDING_INPUT_MAX_BYTES);
    expect(typeof (out.input as { preview: string }).preview).toBe('string');
  });

  it('has no input when the hook sent none', () => {
    expect(capRequestInput('Bash', undefined)).toEqual({ input: undefined, truncated: false });
  });
});

describe('answerableOptions', () => {
  it('lists the choices of one single-select question', () => {
    expect(answerableOptions(ask([{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite' }]))).toEqual([
      { label: 'Postgres', description: 'Relational' },
      { label: 'SQLite' },
    ]);
  });

  it('has none for a multi-select question, several questions, or more than 9 choices', () => {
    expect(answerableOptions(ask([{ label: 'A' }, { label: 'B' }], { multiSelect: true }))).toBeUndefined();
    expect(answerableOptions({ questions: [ask([{ label: 'A' }]).questions[0], ask([{ label: 'B' }]).questions[0]] })).toBeUndefined();
    expect(answerableOptions(ask(Array.from({ length: 10 }, (_, i) => ({ label: `O${i}` }))))).toBeUndefined();
    expect(answerableOptions(ask(Array.from({ length: 9 }, (_, i) => ({ label: `O${i}` }))))?.length).toBe(9);
  });

  it('has none for a malformed question', () => {
    expect(answerableOptions(ask([]))).toBeUndefined();
    expect(answerableOptions(ask([{ description: 'no label' }]))).toBeUndefined();
    expect(answerableOptions({ questions: 'nope' })).toBeUndefined();
    expect(answerableOptions(null)).toBeUndefined();
  });

  it('reads the older single-question shape too', () => {
    expect(answerableOptions({ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] })).toEqual([{ label: 'A' }, { label: 'B' }]);
  });
});

describe('nextPendingRequest: raised', () => {
  it('a PermissionRequest raises a permission with the tool, its input and the hook’s call id', () => {
    const req = next(null, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' }, tool_use_id: 'toolu_1' });
    expect(req).toEqual({
      id: 'toolu_1',
      toolUseId: 'toolu_1',
      kind: 'permission',
      cli: 'claude',
      tool: 'Bash',
      input: { command: 'rm -rf dist' },
      raisedAt: NOW,
      source: 'permission_request',
    });
  });

  it('without a call id it gets a server id of its own', () => {
    const req = next(null, 'PermissionRequest', { tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } });
    expect(req?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(req?.toolUseId).toBeUndefined();
  });

  it('Codex raises one too, and the request says which CLI asked', () => {
    expect(next(null, 'PermissionRequest', { tool_name: 'shell', tool_input: { command: ['ls'] } }, 'codex')?.cli).toBe('codex');
  });

  it('a PermissionRequest for AskUserQuestion is a question, not a permission', () => {
    expect(next(null, 'PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: ask([{ label: 'A' }]) })?.kind).toBe('question');
  });

  it('PreToolUse of AskUserQuestion raises a question with its choices', () => {
    const req = next(null, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ask([{ label: 'A' }, { label: 'B' }]), tool_use_id: 'toolu_q' });
    expect(req).toMatchObject({ id: 'toolu_q', kind: 'question', tool: 'AskUserQuestion', source: 'pre_tool_use' });
    expect(req?.options).toEqual([{ label: 'A' }, { label: 'B' }]);
  });

  it('PreToolUse of ExitPlanMode raises a plan approval', () => {
    const req = next(null, 'PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: '1. do it' } });
    expect(req).toMatchObject({ kind: 'plan', tool: 'ExitPlanMode', input: { plan: '1. do it' }, source: 'pre_tool_use' });
  });

  it('PreToolUse of any other tool raises nothing and keeps what waits', () => {
    expect(next(null, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeNull();
    const waiting = next(null, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(next(waiting, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' } })).toBe(waiting);
  });

  it('a CLI it does not know raises nothing', () => {
    expect(next(null, 'PermissionRequest', { tool_name: 'Bash', tool_input: {} }, null)).toBeNull();
  });

  it('the PermissionRequest of a question already raised keeps the question’s id', () => {
    const input = ask([{ label: 'A' }, { label: 'B' }]);
    const asked = next(null, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: input, tool_use_id: 'toolu_q' });
    const again = next(asked, 'PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: input });
    expect(again).toBe(asked);
  });

  it('a newer request replaces the one before, even for the same tool', () => {
    const first = next(null, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'make a' } });
    const second = next(first, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'make b' } });
    expect(second?.id).not.toBe(first?.id);
    expect(second?.input).toEqual({ command: 'make b' });
  });

  it('two calls with different ids are different requests, inputs alike', () => {
    const first = next(null, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_a' });
    expect(next(first, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_b' })?.id).toBe('toolu_b');
  });

  it('ignores an id or tool name that is not a sane string', () => {
    const req = next(null, 'PermissionRequest', { tool_name: { evil: 1 }, tool_input: {}, tool_use_id: 'x'.repeat(500) });
    expect(req?.tool).toBe('Unknown');
    expect(req?.toolUseId).toBeUndefined();
  });
});

describe('nextPendingRequest: cleared', () => {
  const waiting = (): PendingRequest =>
    next(null, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1' }) as PendingRequest;
  const unnumbered = (): PendingRequest =>
    next(null, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }) as PendingRequest;

  it.each(['PostToolUse', 'PostToolUseFailure'])('%s of the same call clears it', (event) => {
    expect(next(waiting(), event, { tool_name: 'Bash', tool_use_id: 'toolu_1' })).toBeNull();
  });

  it('a PostToolUse of another call keeps it', () => {
    const req = waiting();
    expect(next(req, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_2' })).toBe(req);
    expect(next(req, 'PostToolUse', { tool_name: 'Read' })).toBe(req);
  });

  it('without ids on both sides, the same tool’s PostToolUse clears it (early, never late)', () => {
    expect(next(unnumbered(), 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_9' })).toBeNull();
    expect(next(waiting(), 'PostToolUse', { tool_name: 'Bash' })).toBeNull();
    expect(next(waiting(), 'PostToolUse', {})).toBeNull();
  });

  it.each(['UserPromptSubmit', 'Stop', 'SessionEnd', 'SessionStart'])('%s clears it', (event) => {
    expect(next(waiting(), event)).toBeNull();
  });

  it('other events keep it', () => {
    const req = waiting();
    for (const event of ['SubagentStart', 'SubagentStop', 'Notification', 'PreCompact']) expect(next(req, event)).toBe(req);
  });
});

describe('guessPendingRequest', () => {
  it('a timer guess carries the tool but no input, and is kind by tool', () => {
    expect(guessPendingRequest(null, 'Bash', 'timer', 'claude', NOW)).toMatchObject({ kind: 'permission', tool: 'Bash', source: 'timer', cli: 'claude' });
    expect(guessPendingRequest(null, 'AskUserQuestion', 'timer', 'claude', NOW)).toMatchObject({ kind: 'question', source: 'timer' });
    expect(guessPendingRequest(null, 'Bash', 'notification', 'claude', NOW)?.input).toBeUndefined();
  });

  it('never replaces a request the CLI raised; a raised request replaces a guess', () => {
    const raised = next(null, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(guessPendingRequest(raised, 'Bash', 'timer', 'claude', NOW)).toBe(raised);
    const guess = guessPendingRequest(null, 'Bash', 'timer', 'claude', NOW);
    const real = next(guess, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(real?.source).toBe('permission_request');
    expect(real?.id).not.toBe(guess?.id);
  });

  it('a CLI it does not know gets no guess either', () => {
    expect(guessPendingRequest(null, 'Bash', 'timer', null, NOW)).toBeNull();
  });
});
