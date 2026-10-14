/**
 * The store half of the session header's model · effort chip: real hook events, real
 * transcript files and real status-line snapshots, checked through getSession().
 *
 * Real timers: the watchers are fs.watch + a short debounce, which fake timers cannot see.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Before the store is imported: never read this machine's real runtime directory.
const paths = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? '/tmp'}/aasc-runtime-store-${process.pid}-${Date.now()}`;
  process.env.AASC_RUNTIME_DIR = `${root}/runtime`;
  process.env.CODEX_HOME = `${root}/codex`;
  return { root, runtimeDir: `${root}/runtime`, codexHome: `${root}/codex` };
});

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
  startSessionRuntime,
  stopSessionRuntime,
} from '../server/sessionStore.js';
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

const dir = mkdtempSync(join(tmpdir(), 'aasc-runtime-tx-'));
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
  rawHandleEvent({ tty_path: '/dev/ttys001', cwd: '/tmp/runtime-test', ...payload } as never);

const iso = (s: number) => new Date(Date.UTC(2026, 9, 14, 4, 0, s)).toISOString();
const effortLine = (level: string, s: number) => JSON.stringify({
  type: 'system', subtype: 'local_command', timestamp: iso(s),
  content: `<local-command-stdout>Set effort level to ${level} (this session only)</local-command-stdout>`,
  commandRun: { command: 'effort', args: level },
}) + '\n';
const modelLine = (label: string, s: number) => JSON.stringify({
  type: 'system', subtype: 'local_command', timestamp: iso(s),
  content: `<local-command-stdout>Set model to \`${label}\` and saved as your default for new sessions</local-command-stdout>`,
  commandRun: { command: 'model', args: '' },
}) + '\n';

function startSession(id: string, extra: Record<string, unknown> = {}): string {
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: 'user', timestamp: iso(0), message: { role: 'user', content: 'hi' } }) + '\n');
  handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.SESSION_START, transcript_path: file, model: 'claude-opus-5-5', ...extra });
  return file;
}

describe('session runtime (model · effort) in the store', () => {
  it('a /effort typed in the session reaches the session without any hook', async () => {
    const id = 'rt-effort-0001';
    const file = startSession(id);
    appendFileSync(file, effortLine('max', 1));
    expect(await waitFor(() => getSession(id)?.runtime?.effort === 'max')).toBe(true);

    appendFileSync(file, effortLine('low', 2));
    expect(await waitFor(() => getSession(id)?.runtime?.effort === 'low')).toBe(true);
  });

  it('a /model switch shows the new model and drops the old effort until the CLI reports one', async () => {
    const id = 'rt-model-0001';
    const file = startSession(id);
    appendFileSync(file, effortLine('max', 1));
    expect(await waitFor(() => getSession(id)?.runtime?.effort === 'max')).toBe(true);

    appendFileSync(file, modelLine('Haiku 4.5', 2));
    expect(await waitFor(() => getSession(id)?.runtime?.model === 'Haiku 4.5')).toBe(true);
    expect(getSession(id)?.runtime?.effort).toBeUndefined();

    // The status line's next render says which effort Claude restored for that model.
    writeFileSync(join(paths.runtimeDir, `${id}.json`), JSON.stringify({
      session_id: id, ts: Date.UTC(2026, 9, 14, 4, 0, 3), model: { id: 'claude-haiku-4-5', display_name: 'Haiku 4.5' }, effort: { level: 'medium' },
    }));
    expect(await waitFor(() => getSession(id)?.runtime?.effort === 'medium')).toBe(true);
  });

  it('a Codex session ignores Claude\'s transcript lines and status-line snapshots', async () => {
    const id = 'rt-codex-0001';
    const file = startSession(id, { model: 'gpt-5-codex', cli_source: 'codex' });
    appendFileSync(file, effortLine('max', 1));
    writeFileSync(join(paths.runtimeDir, `${id}.json`), JSON.stringify({ session_id: id, ts: Date.now(), model: { id: 'x' } }));
    await sleep(500);
    expect(getSession(id)?.runtime).toBeUndefined();
  });

  it('the status line\'s context-window share reaches the session, and /clear\'s null clears it', async () => {
    const id = 'rt-context-0001';
    startSession(id);
    const snap = (ts: number, context: unknown) => writeFileSync(join(paths.runtimeDir, `${id}.json`), JSON.stringify({
      session_id: id, ts, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, effort: { level: 'high' }, context,
    }));
    snap(Date.UTC(2026, 9, 14, 4, 0, 1), { used_percentage: 42, size: 200000, tokens: 84312 });
    expect(await waitFor(() => getSession(id)?.runtime?.context?.pct === 42)).toBe(true);
    expect(getSession(id)?.runtime?.context).toEqual({ pct: 42, size: 200000, tokens: 84312 });

    snap(Date.UTC(2026, 9, 14, 4, 0, 2), { used_percentage: null, size: 200000, tokens: null });
    expect(await waitFor(() => getSession(id)?.runtime?.contextAt === Date.UTC(2026, 9, 14, 4, 0, 2))).toBe(true);
    expect(getSession(id)?.runtime?.context).toBeUndefined();
  });

  it('an ended session stops being watched', async () => {
    const id = 'rt-ended-0001';
    const file = startSession(id);
    appendFileSync(file, effortLine('high', 1));
    expect(await waitFor(() => getSession(id)?.runtime?.effort === 'high')).toBe(true);

    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.SESSION_END });
    appendFileSync(file, effortLine('low', 2));
    await sleep(500);
    expect(getSession(id)?.runtime?.effort).toBe('high');
  });

  // The user's ask: a mid-session /model or /effort must survive an AASC restart.
  // Every resume path launches from `model` / `effortLevel`, so they must follow.
  it('REGRESSION GUARD: /model and /effort become the launch flags a resume uses', async () => {
    const id = 'rt-flags-0001';
    const file = startSession(id, { model: 'claude-opus-4-8' });
    expect(getSession(id)?.model).toBe('claude-opus-4-8');

    appendFileSync(file, modelLine('Opus 5.5', 1));
    appendFileSync(file, effortLine('high', 2));
    expect(await waitFor(() => getSession(id)?.effortLevel === 'high')).toBe(true);
    expect(getSession(id)?.model).toBe('claude-opus-5-5');

    appendFileSync(file, effortLine('max', 3));
    expect(await waitFor(() => getSession(id)?.effortLevel === 'max')).toBe(true);
  });

  it('REVIEW: a reply from another model (opusplan, a fallback) never becomes the launch model', async () => {
    const id = 'rt-reply-0001';
    const file = startSession(id, { model: 'opusplan' });
    appendFileSync(file, JSON.stringify({
      type: 'assistant', timestamp: iso(1), message: { model: 'claude-sonnet-5-5', role: 'assistant', content: [] },
    }) + '\n');
    appendFileSync(file, effortLine('high', 2));
    expect(await waitFor(() => getSession(id)?.effortLevel === 'high')).toBe(true);
    expect(getSession(id)?.runtime?.model).toBe('claude-sonnet-5-5');
    expect(getSession(id)?.model).toBe('opusplan');
  });

  it('a Codex session follows the model and reasoning effort of its newest turn', async () => {
    const id = '01a1390d-5541-7ee0-aaef-f5209247a8b3';
    const day = join(paths.codexHome, 'sessions', '2026', '10', '14');
    mkdirSync(day, { recursive: true });
    const rollout = join(day, `rollout-2026-10-14T19-15-37-${id}.jsonl`);
    const turn = (model: string, effort: string, s: number) => JSON.stringify({
      timestamp: iso(s), type: 'turn_context', payload: { turn_id: `t${s}`, model, effort },
    }) + '\n';
    writeFileSync(rollout, turn('gpt-6-astra', 'low', 1));

    handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.SESSION_START, model: 'gpt-old', cli_source: 'codex' });
    expect(await waitFor(() => getSession(id)?.effortLevel === 'low')).toBe(true);
    expect(getSession(id)?.model).toBe('gpt-6-astra');

    appendFileSync(rollout, turn('gpt-6-astra', 'xhigh', 2));
    expect(await waitFor(() => getSession(id)?.effortLevel === 'xhigh')).toBe(true);
  });
});
