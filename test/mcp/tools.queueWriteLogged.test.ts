// test/mcp/tools.queueWriteLogged.test.ts — the queue writes and the activity log. Every way into a tool runs through
// `runTool` (server/mcp/runTool.ts), which writes a row for each non-read call: ok, refused (with its code) or failed.
// These tests run the queue write tools there, with a real activity log on in-memory SQLite, and check what the plan's
// review focus asks: a refused write still appears in the log with its reason, nothing is written to the queue behind
// a refusal, and no row holds the text that was queued.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { roomInput } from './centralFixtures.js';
import { NOW } from './queueFixtures.js';
import { CASES, loggedWorld, toolNamed, type LoggedWorldOptions } from './queueToolFixtures.js';
import { makeRoom } from './toolHarness.js';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

beforeEach(() => {
  log.warn.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const SECRET = 'my bank password is hunter2';

/**
 * These tests are about the steering rails and the log, so the lock (Ruling 42, tools.queueWriteLock.test.ts) is let
 * through, as P4 will for a central's own worker.
 */
const world = (opts: Omit<LoggedWorldOptions, 'unlocked'> = {}) => loggedWorld({ ...opts, unlocked: true });

describe('a queue write that goes ahead', () => {
  it('is logged ok, once, under the tool’s name and risk, with the session and AASC’s own words', async () => {
    const w = world();

    await w.call('queue_add_item', { id: 's1', text: SECRET });

    const rows = w.activity.listActivity();
    expect(rows).toEqual([
      expect.objectContaining({
        centralId: w.central.centralId,
        tool: 'queue_add_item',
        risk: 'steers',
        targetSessionId: 's1',
        outcome: 'ok',
        summary: 'Queued a prompt, paused',
        detail: expect.objectContaining({ itemId: NOW, position: 2 }),
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it.each(CASES)('%s leaves exactly one ok row naming the session, and none of the text it was given', async (name, args) => {
    const w = world();
    const withSecret: Record<string, unknown> = 'text' in args ? { ...args, text: SECRET } : args;

    await w.call(name, withSecret);

    const rows = w.activity.listActivity();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: name, outcome: 'ok', targetSessionId: 's1' });
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).not.toContain('first step');
  });
});

describe('refusals are logged', () => {
  const rowFor = (w: ReturnType<typeof world>, name: string, target: string, code: string) => {
    const rows = w.activity.listActivity();
    expect(rows, `${name} → ${code}`).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      centralId: w.central.centralId,
      tool: name,
      risk: toolNamed(w.tools, name).risk,
      outcome: 'refused',
      detail: { code },
    });
    expect(rows[0].summary).toContain(`Refused (${code})`);
    return rows[0];
  };

  it.each(CASES)('%s on a hands-off session: refused, logged with HANDS_OFF and the session, nothing written', async (name, args) => {
    const w = world();

    const err = await w.failure(name, { ...args, id: 's2' });

    expect(err.code).toBe('HANDS_OFF');
    expect(rowFor(w, name, 's2', 'HANDS_OFF').targetSessionId).toBe('s2');
    expect(w.store.calls).toEqual([]);
  });

  it.each(CASES)('%s on a session a person drove a moment ago: refused, logged with HUMAN_ACTIVE and the session', async (name, args) => {
    const w = world();

    const err = await w.failure(name, { ...args, id: 's3' });

    expect(err.code).toBe('HUMAN_ACTIVE');
    expect(rowFor(w, name, 's3', 'HUMAN_ACTIVE').targetSessionId).toBe('s3');
    expect(w.store.calls).toEqual([]);
  });

  it.each(CASES)('%s on a session outside the central’s scope: refused, logged with NOT_IN_SCOPE, nothing written', async (name, args) => {
    const w = world({ input: roomInput('r1'), rooms: [makeRoom('r1', ['s1'])] });

    const err = await w.failure(name, { ...args, id: 's2' });

    expect(err.code).toBe('NOT_IN_SCOPE');
    rowFor(w, name, 's2', 'NOT_IN_SCOPE');
    expect(w.store.calls).toEqual([]);
  });

  it('logs the tool’s own refusal too, with the session: a prompt that is not in the queue is NOT_FOUND', async () => {
    const w = world();

    await w.failure('queue_edit_item', { id: 's1', itemId: 999_999, text: 'x' });

    expect(rowFor(w, 'queue_edit_item', 's1', 'NOT_FOUND').targetSessionId).toBe('s1');
  });

  it('logs a text refused as a shell line as INVALID, with the session and without the text', async () => {
    const w = world();

    await w.failure('queue_add_item', { id: 's1', text: `!echo ${SECRET}` });

    const row = rowFor(w, 'queue_add_item', 's1', 'INVALID');
    expect(row.targetSessionId).toBe('s1');
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it('logs a queued command a central never runs as INVALID, with the session and without the text (Ruling 60)', async () => {
    const w = world();

    await w.failure('queue_add_step', { id: 's1', itemId: 1, chain: 'after', text: `/logout ${SECRET}` });

    const row = rowFor(w, 'queue_add_step', 's1', 'INVALID');
    expect(row.targetSessionId).toBe('s1');
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it('logs fire_now with no window as NO_WINDOW', async () => {
    const w = world({ writer: null });

    const err = await w.failure('queue_fire_now', { id: 's1', itemId: 1 });

    expect(err.code).toBe('NO_WINDOW');
    rowFor(w, 'queue_fire_now', 's1', 'NO_WINDOW');
    expect(w.store.calls).toEqual([]);
  });
});

describe('a queue write that fails inside AASC', () => {
  it('is UPSTREAM in fixed words, logged as failed, and the database’s own words stay in the server log', async () => {
    const w = world();
    w.store.write = () => {
      throw new Error('SQLITE_FULL: /Users/someone/secret.db');
    };

    const err = await w.failure('queue_add_item', { id: 's1', text: 'x' });

    expect(err.code).toBe('UPSTREAM');
    expect(`${err.message} ${err.hint}`).not.toMatch(/SQLITE|someone|secret/);
    expect(w.activity.listActivity()).toEqual([expect.objectContaining({ tool: 'queue_add_item', outcome: 'failed', detail: { code: 'UPSTREAM' } })]);
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('SQLITE_FULL'));
  });
});

describe('a server that never wired the P2 runtime', () => {
  it.each(CASES)('%s answers UNAVAILABLE, before it reads or writes anything', async (name, args) => {
    const w = world({ unwired: true });

    const err = await w.failure(name, args);

    expect(err.code).toBe('UNAVAILABLE');
    expect(w.store.calls).toEqual([]);
  });
});
