/**
 * The server half of "a user cancel holds the prompt queue".
 *
 * Esc fires a real Stop, so the hook stream alone makes a cancelled turn look
 * finished and the queue would send its next prompt into it. After every Stop
 * the store reads the transcript's tail for Claude Code's interruption marker
 * (see transcriptInterrupt.ts); this file drives real hook events against real
 * transcript files and checks what the store does.
 *
 * Real timers: the check reads files asynchronously 150 ms and 600 ms after
 * the Stop, which fake timers cannot see through.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooks = vi.hoisted(() => ({
  onFault: null as null | ((terminalId: string, fault: { kind: string; line: string }) => void),
}));

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
}));

vi.mock('../server/sshManager.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/sshManager.js')>();
  return {
    ...mod,
    registerTerminalFaultCallback: (cb: (terminalId: string, fault: { kind: string; line: string }) => void) => {
      hooks.onFault = cb;
    },
  };
});

import {
  handleEvent as rawHandleEvent,
  getSession,
  linkTerminalToSession,
  registerSessionAlias,
  resumeQueueAfterCancel,
} from '../server/sessionStore.js';
import { EVENT_TYPES } from '../server/constants.js';

const dir = mkdtempSync(join(tmpdir(), 'aasc-cancel-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const handleEvent = (payload: Record<string, unknown>) =>
  rawHandleEvent({ tty_path: '/dev/ttys001', cwd: '/tmp/cancel-test', ...payload } as never);

const MARKER = (promptId: string) => JSON.stringify({
  type: 'user', promptId, interruptedMessageId: 'msg_011CezSAuxTJKSogXqdBsHa6',
  message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
});

/** One turn's transcript; `interrupted` appends Claude Code's marker. */
function transcript(id: string, promptId: string, interrupted: boolean): string {
  const file = join(dir, `${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'user', promptId, message: { role: 'user', content: 'do the thing' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } }),
  ];
  if (interrupted) lines.push(MARKER(promptId));
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function runningTurn(id: string, promptId: string, extra: Record<string, unknown> = {}): void {
  handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.SESSION_START, ...extra });
  handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, prompt: 'do the thing', prompt_id: promptId });
}

const stop = (id: string, file: string, promptId: string, extra: Record<string, unknown> = {}) =>
  handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.STOP, transcript_path: file, prompt_id: promptId, ...extra });

const held = (id: string) => vi.waitFor(() => expect(getSession(id)?.userCancelledAt).toBeTypeOf('number'), { timeout: 2000 });
/** Past both reads (150 ms + 600 ms). */
const afterChecks = () => new Promise((r) => setTimeout(r, 800));

describe('user cancel → queue hold (server)', () => {
  it('a Stop whose transcript shows the interruption holds the queue', async () => {
    runningTurn('uc-1', 'p1');
    stop('uc-1', transcript('uc-1', 'p1', true), 'p1');
    await held('uc-1');
  });

  it('a turn that finished normally does not', async () => {
    runningTurn('uc-2', 'p2');
    stop('uc-2', transcript('uc-2', 'p2', false), 'p2');
    await afterChecks();
    expect(getSession('uc-2')?.userCancelledAt ?? null).toBeNull();
  });

  it('a marker written a moment after the Stop is caught by the second read', async () => {
    runningTurn('uc-3', 'p3');
    const file = transcript('uc-3', 'p3', false);
    stop('uc-3', file, 'p3');
    setTimeout(() => appendFileSync(file, MARKER('p3') + '\n'), 300);
    await held('uc-3');
  });

  it('the user\'s next prompt clears the hold', async () => {
    runningTurn('uc-4', 'p4');
    stop('uc-4', transcript('uc-4', 'p4', true), 'p4');
    await held('uc-4');
    handleEvent({ session_id: 'uc-4', hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, prompt: 'try this instead', prompt_id: 'p4b' });
    expect(getSession('uc-4')?.userCancelledAt ?? null).toBeNull();
  });

  it('a prompt sent before the check runs makes it moot', async () => {
    runningTurn('uc-5', 'p5');
    stop('uc-5', transcript('uc-5', 'p5', true), 'p5');
    handleEvent({ session_id: 'uc-5', hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, prompt: 'never mind', prompt_id: 'p5b' });
    await afterChecks();
    expect(getSession('uc-5')?.userCancelledAt ?? null).toBeNull();
  });

  it('a tool call does NOT clear it — only the user acting does', async () => {
    runningTurn('uc-6', 'p6');
    stop('uc-6', transcript('uc-6', 'p6', true), 'p6');
    await held('uc-6');
    handleEvent({ session_id: 'uc-6', hook_event_name: EVENT_TYPES.PRE_TOOL_USE, tool_name: 'Read' });
    expect(getSession('uc-6')?.userCancelledAt).toBeTypeOf('number');
  });

  it('clears an earlier fault, so auto-resume cannot continue the cancelled turn', async () => {
    runningTurn('uc-7', 'p7');
    linkTerminalToSession('uc-7', 'term-uc-7');
    hooks.onFault!('term-uc-7', { kind: 'api_error', line: 'API Error: 529 Overloaded' });
    expect(getSession('uc-7')?.interruption).toBeTruthy();
    stop('uc-7', transcript('uc-7', 'p7', true), 'p7');
    await held('uc-7');
    expect(getSession('uc-7')?.interruption ?? null).toBeNull();
  });

  it('skips Codex sessions (their transcripts never carry this marker)', async () => {
    runningTurn('uc-8', 'p8', { startup_command: 'codex --full-auto' });
    stop('uc-8', transcript('uc-8', 'p8', true), 'p8');
    await afterChecks();
    expect(getSession('uc-8')?.userCancelledAt ?? null).toBeNull();
  });

  it('Resume clears the hold once — through an old id too — and reports when there was nothing to resume', async () => {
    runningTurn('uc-9', 'p9');
    stop('uc-9', transcript('uc-9', 'p9', true), 'p9');
    await held('uc-9');
    registerSessionAlias('uc-9-old', 'uc-9');
    expect(resumeQueueAfterCancel('uc-9-old')).toBe(true);
    expect(getSession('uc-9')?.userCancelledAt ?? null).toBeNull();
    expect(resumeQueueAfterCancel('uc-9')).toBe(false);
    expect(resumeQueueAfterCancel('no-such-session')).toBe(false);
  });
});

describe('subagent count (what the queue\'s subagent hold reads)', () => {
  const start = (id: string) => handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.SUBAGENT_START, agent_type: 'general-purpose' });

  it('SessionStart resets a count stuck by a lost SubagentStop', () => {
    runningTurn('sa-1', 'q1');
    start('sa-1');
    expect(getSession('sa-1')?.subagentCount).toBe(1);
    handleEvent({ session_id: 'sa-1', hook_event_name: EVENT_TYPES.SESSION_START });
    expect(getSession('sa-1')?.subagentCount).toBe(0);
  });

  it('every Stop resets it from the background work Claude Code reports', () => {
    runningTurn('sa-2', 'q2');
    start('sa-2');
    start('sa-2');
    const file = transcript('sa-2', 'q2', false);
    stop('sa-2', file, 'q2', { background_tasks: [
      { id: 'a1', type: 'subagent', status: 'running', description: 'review' },
      { id: 'b1', type: 'shell', status: 'running', description: 'npm run dev' },
    ] });
    expect(getSession('sa-2')?.subagentCount).toBe(1);
    stop('sa-2', file, 'q2', { background_tasks: [] });
    expect(getSession('sa-2')?.subagentCount).toBe(0);
  });

  it('keeps the count when the CLI sends no background_tasks (older versions)', () => {
    runningTurn('sa-3', 'q3');
    start('sa-3');
    stop('sa-3', transcript('sa-3', 'q3', false), 'q3');
    expect(getSession('sa-3')?.subagentCount).toBe(1);
  });

  it('SessionEnd resets it', () => {
    runningTurn('sa-4', 'q4');
    start('sa-4');
    handleEvent({ session_id: 'sa-4', hook_event_name: EVENT_TYPES.SESSION_END, reason: 'exit' });
    expect(getSession('sa-4')?.subagentCount).toBe(0);
  });
});
