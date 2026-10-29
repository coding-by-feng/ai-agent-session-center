/**
 * An Esc ends the turn on the card, though neither CLI fires a hook for it: Claude writes
 * "[Request interrupted by user]" into its transcript and sends no Stop, Codex writes
 * `turn_aborted` into its rollout and sends nothing. The phone's Stop button is that Esc.
 * Real hook events, real files and the session runtime's real fs.watch, checked through
 * getSession().
 *
 * Real timers: the watcher is fs.watch + a short debounce, which fake timers cannot see.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Before the store is imported: never read this machine's real runtime directory or Codex home.
const paths = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? '/tmp'}/aasc-esc-stop-${process.pid}-${Date.now()}`;
  process.env.AASC_RUNTIME_DIR = `${root}/runtime`;
  process.env.CODEX_HOME = `${root}/codex`;
  return { root, runtimeDir: `${root}/runtime`, codexHome: `${root}/codex` };
});

// What the browsers and phones are told. A stub, not the real module: its first, lazy import
// races the 20 ms broadcast debounce under vite-node (half-initialized bindings).
const ws = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../server/wsManager.js', () => ({ broadcast: ws.broadcast }));

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

import {
  handleEvent as rawHandleEvent,
  getSession,
  linkTerminalToSession,
  resumeQueueAfterCancel,
  startSessionRuntime,
  stopSessionRuntime,
} from '../server/sessionStore.js';
import { onTerminalHook, type HookSignal } from '../server/hookSignals.js';
import { EVENT_TYPES } from '../server/constants.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}
/** Long enough for the watcher to have read the file (debounce + read) and done nothing. */
const settled = () => sleep(600);

const dir = mkdtempSync(join(tmpdir(), 'aasc-esc-stop-tx-'));
beforeAll(() => {
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.runtimeDir, { mode: 0o700 });
  startSessionRuntime();
});
afterAll(() => {
  stopSessionRuntime();
  rmSync(dir, { recursive: true, force: true });
  rmSync(paths.root, { recursive: true, force: true });
  delete process.env.AASC_RUNTIME_DIR;
  delete process.env.CODEX_HOME;
});

const handleEvent = (payload: Record<string, unknown>) =>
  rawHandleEvent({ tty_path: '/dev/ttys001', cwd: '/tmp/esc-stop-test', ...payload } as never);

const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';

// ---- Claude: shapes from real 2.1.3xx transcripts --------------------------------------

const claudePrompt = (promptId: string) => line({ type: 'user', promptId, message: { role: 'user', content: 'do the thing' } });
const claudeThinking = () => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } });
const claudeMarker = (promptId: string, text = '[Request interrupted by user]') => line({
  type: 'user', promptId, interruptedMessageId: 'msg_011CezSAuxTJKSogXqdBsHa6',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

/** A marker as Claude stamps it: `at` is when it was written. */
const claudeMarkerAt = (promptId: string, at: number) => line({
  type: 'user', promptId, timestamp: new Date(at).toISOString(), interruptedMessageId: 'msg_not_in_the_tail',
  message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
});
const claudeToolResult = (promptId: string) => line({
  type: 'user', promptId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Interrupted' }] },
});

/** A Claude session mid-turn on `promptId`: its transcript holds the prompt and some thinking. */
function claudeTurn(id: string, promptId: string): string {
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, claudePrompt(promptId) + claudeThinking());
  handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.SESSION_START, transcript_path: file });
  handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, prompt: 'do the thing', prompt_id: promptId, transcript_path: file });
  return file;
}

// ---- Codex: shapes from real 0.164 rollouts --------------------------------------------

const codexEvent = (type: string, payload: Record<string, unknown> = {}) =>
  line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type, ...payload } });

/** A Codex session mid-turn on `turnId`, its rollout where findCodexRollout looks. */
function codexTurn(id: string, turnId: string, before = ''): string {
  const day = join(paths.codexHome, 'sessions', '2026', '10', '27');
  mkdirSync(day, { recursive: true });
  const rollout = join(day, `rollout-2026-10-27T17-18-11-${id}.jsonl`);
  writeFileSync(rollout, before + codexEvent('task_started', { turn_id: turnId }));
  handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.SESSION_START, cli_source: 'codex', model: 'gpt-6-luna' });
  handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, cli_source: 'codex', prompt: 'do the thing', turn_id: turnId });
  return rollout;
}

describe('an Esc ends the turn without a hook', () => {
  it('Claude: the interrupt marker in the transcript ends a running turn and holds the queue', async () => {
    const id = 'esc-claude-0001';
    const file = claudeTurn(id, 'p-1');
    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.PRE_TOOL_USE, tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, prompt_id: 'p-1' });
    expect(getSession(id)?.status).toBe('working');

    appendFileSync(file, claudeMarker('p-1'));
    expect(await waitFor(() => getSession(id)?.status === 'waiting')).toBe(true);
    const session = getSession(id)!;
    expect(session.userCancelledAt).toBeTypeOf('number');
    expect(session.pendingTool ?? null).toBeNull();
    expect(session.events.at(-1)).toMatchObject({ type: EVENT_TYPES.STOP, detail: 'Stopped by you' });
    // …and the phone hears it, which is what clears its "Stopping…".
    expect(await waitFor(() => ws.broadcast.mock.calls.some(([m]) =>
      m?.type === 'session_update' && m.session?.sessionId === id && m.session.status === 'waiting'))).toBe(true);
  });

  it('Claude: declining a tool (its "for tool use" marker) closes the dialog and ends the turn', async () => {
    const id = 'esc-claude-0002';
    const file = claudeTurn(id, 'p-2');
    handleEvent({
      session_id: id, hook_event_name: EVENT_TYPES.PERMISSION_REQUEST, tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' }, prompt_id: 'p-2',
    });
    expect(getSession(id)?.status).toBe('approval');

    appendFileSync(file, claudeMarker('p-2', '[Request interrupted by user for tool use]'));
    expect(await waitFor(() => getSession(id)?.status === 'waiting')).toBe(true);
    expect(getSession(id)?.pendingRequest ?? null).toBeNull();
    expect(getSession(id)?.waitingDetail ?? null).toBeNull();
  });

  it('Codex: turn_aborted in the rollout ends the turn it names', async () => {
    const id = '01a17b94-7ed9-7eb3-af5d-57a024d327c8';
    const rollout = codexTurn(id, 'turn-a');
    expect(getSession(id)?.status).toBe('prompting');
    await settled(); // the rollout is found and watched

    appendFileSync(rollout, codexEvent('turn_aborted', { turn_id: 'turn-a', reason: 'interrupted' }) + codexEvent('token_count'));
    expect(await waitFor(() => getSession(id)?.status === 'waiting')).toBe(true);
    expect(getSession(id)?.userCancelledAt).toBeTypeOf('number');
  });

  it('Codex: a rollout first written at the first prompt is watched at once, however long the session sat without one', async () => {
    const id = '01a17b94-0000-7000-8000-00000000000d';
    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.SESSION_START, cli_source: 'codex' });
    await settled(); // looked for its rollout: none yet, so the next look would wait
    const day = join(paths.codexHome, 'sessions', '2026', '10', '27');
    mkdirSync(day, { recursive: true });
    const rollout = join(day, `rollout-2026-10-27T19-00-00-${id}.jsonl`);
    writeFileSync(rollout, codexEvent('task_started', { turn_id: 'turn-d' }));
    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, cli_source: 'codex', prompt: 'go', turn_id: 'turn-d' });
    await settled();

    appendFileSync(rollout, codexEvent('turn_aborted', { turn_id: 'turn-d', reason: 'interrupted' }));
    expect(await waitFor(() => getSession(id)?.status === 'waiting', 3000)).toBe(true);
  });

  it('Codex: a rollout that appears just after the first prompt is found within seconds', async () => {
    const id = '01a17b94-0000-7000-8000-00000000000e';
    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.SESSION_START, cli_source: 'codex' });
    await settled();
    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, cli_source: 'codex', prompt: 'go', turn_id: 'turn-e' });
    await settled(); // looked again at the prompt: still nothing
    const day = join(paths.codexHome, 'sessions', '2026', '10', '27');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-10-27T19-30-00-${id}.jsonl`),
      codexEvent('task_started', { turn_id: 'turn-e' }) + codexEvent('turn_aborted', { turn_id: 'turn-e', reason: 'interrupted' }));
    expect(await waitFor(() => getSession(id)?.status === 'waiting', 4000)).toBe(true);
  });

  it('tells whoever waits on the terminal that the turn is over, as a Stop would', async () => {
    const id = 'esc-claude-0003';
    const file = claudeTurn(id, 'p-3');
    linkTerminalToSession(id, 'term-esc-3');
    const heard: HookSignal[] = [];
    const off = onTerminalHook('term-esc-3', (s) => heard.push(s));
    try {
      appendFileSync(file, claudeMarker('p-3'));
      expect(await waitFor(() => heard.length > 0)).toBe(true);
      expect(heard[0]).toMatchObject({ event: EVENT_TYPES.STOP, sessionId: id, status: 'waiting' });
      expect(heard[0].userCancelledAt).toBeTypeOf('number');
    } finally {
      off();
    }
  });
});

describe('only the turn that was stopped', () => {
  it('REGRESSION GUARD: a Claude marker from the turn before does not stop the prompt that runs now', async () => {
    const id = 'esc-claude-0004';
    // The user stopped p-4, then typed p-4b; Claude has not written p-4b's entry yet.
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, claudePrompt('p-4') + claudeThinking() + claudeMarker('p-4'));
    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.SESSION_START, transcript_path: file });
    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, prompt: 'try again', prompt_id: 'p-4b', transcript_path: file });
    await settled();
    appendFileSync(file, claudeThinking());
    await settled();
    expect(getSession(id)?.status).toBe('prompting');
    expect(getSession(id)?.userCancelledAt ?? null).toBeNull();
  });

  it('REGRESSION GUARD: the marker Claude writes ahead of a newly typed prompt does not stop that prompt', async () => {
    const id = 'esc-claude-0006';
    // Real 2.1.312 order: marker under the NEW promptId, its prompt entry ~200 ms later;
    // the prompt's hook can land in between.
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, claudePrompt('p-6') + claudeThinking());
    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.SESSION_START, transcript_path: file });
    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, prompt: 'first', prompt_id: 'p-6', transcript_path: file });
    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.STOP, prompt_id: 'p-6', transcript_path: file });
    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, prompt: '/update-feature-docs', prompt_id: 'p-6b', transcript_path: file });
    appendFileSync(file, claudeMarker('p-6b'));
    await settled();
    expect(getSession(id)?.status).toBe('prompting');
    expect(getSession(id)?.userCancelledAt ?? null).toBeNull();
  });

  it('REGRESSION GUARD: a Codex abort of an earlier turn does not stop the turn that runs now', async () => {
    const id = '01a17b94-0000-7000-8000-00000000000b';
    // turn-old was stopped; the hook for turn-new arrived before Codex wrote its task_started.
    const day = join(paths.codexHome, 'sessions', '2026', '10', '27');
    mkdirSync(day, { recursive: true });
    const rollout = join(day, `rollout-2026-10-27T18-00-00-${id}.jsonl`);
    writeFileSync(rollout, codexEvent('task_started', { turn_id: 'turn-old' }) + codexEvent('turn_aborted', { turn_id: 'turn-old', reason: 'interrupted' }));
    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.SESSION_START, cli_source: 'codex' });
    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, cli_source: 'codex', prompt: 'next', turn_id: 'turn-new' });
    await settled();
    appendFileSync(rollout, codexEvent('thread_settings_applied'));
    await settled();
    expect(getSession(id)?.status).toBe('prompting');
  });

  it('REGRESSION GUARD: the marker Claude writes as a typed prompt arrives belongs to that prompt, whatever the order', async () => {
    const id = 'esc-claude-0007';
    // Real 2.1.312 shape (49ccf192): typing into a busy turn cuts its tool off; the tool's result and
    // the marker carry the NEW prompt's id, and the prompt's own entry comes ~270 ms later.
    const file = claudeTurn(id, 'p-7');
    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, prompt: 'and this', prompt_id: 'p-7b', transcript_path: file });
    appendFileSync(file, claudeToolResult('p-7b') + claudeMarkerAt('p-7b', Date.now()));
    await settled();
    expect(getSession(id)?.status).toBe('prompting');
    expect(getSession(id)?.userCancelledAt ?? null).toBeNull();
  });

  it('an Esc pressed a moment after the prompt still stops it', async () => {
    const id = 'esc-claude-0008';
    const file = claudeTurn(id, 'p-8');
    await sleep(350);
    appendFileSync(file, claudeMarkerAt('p-8', Date.now()));
    expect(await waitFor(() => getSession(id)?.status === 'waiting')).toBe(true);
  });

  it('a stopped turn is ended once, even while a subagent\'s open dialog keeps the card asking', async () => {
    const id = 'esc-claude-0009';
    const file = claudeTurn(id, 'p-9');
    linkTerminalToSession(id, 'term-esc-9');
    const heard: HookSignal[] = [];
    const off = onTerminalHook('term-esc-9', (s) => heard.push(s));
    try {
      handleEvent({
        session_id: id, hook_event_name: EVENT_TYPES.PERMISSION_REQUEST, tool_name: 'Bash', tool_input: { command: 'ls' },
        prompt_id: 'p-9', claude_agent_id: 'agent-9', claude_agent_type: 'general-purpose',
      });
      expect(getSession(id)?.status).toBe('approval');
      appendFileSync(file, claudeMarker('p-9'));
      expect(await waitFor(() => heard.length > 0)).toBe(true);
      expect(getSession(id)?.status).toBe('approval'); // the subagent is still asking

      appendFileSync(file, claudeThinking());
      await settled();
      expect(heard).toHaveLength(1);
      expect(getSession(id)?.events.filter((e) => e.detail === 'Stopped by you')).toHaveLength(1);
    } finally {
      off();
    }
  });

  it('a stopped turn is ended once: lifting the hold is not undone by the next read', async () => {
    const id = 'esc-claude-0005';
    const file = claudeTurn(id, 'p-5');
    appendFileSync(file, claudeMarker('p-5'));
    expect(await waitFor(() => getSession(id)?.userCancelledAt != null)).toBe(true);

    expect(resumeQueueAfterCancel(id)).toBe(true);
    appendFileSync(file, claudeThinking());
    await settled();
    expect(getSession(id)?.status).toBe('waiting');
    expect(getSession(id)?.userCancelledAt ?? null).toBeNull();
  });

  it('a turn that finished normally is left to its Stop', async () => {
    const id = '01a17b94-0000-7000-8000-00000000000c';
    const rollout = codexTurn(id, 'turn-c');
    await settled();
    appendFileSync(rollout, codexEvent('task_complete', { turn_id: 'turn-c' }));
    await settled();
    expect(getSession(id)?.status).toBe('prompting');
    expect(getSession(id)?.userCancelledAt ?? null).toBeNull();
  });
});
