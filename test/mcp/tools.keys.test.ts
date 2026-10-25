// test/mcp/tools.keys.test.ts — key_send and terminal_clear (server/mcp/tools/keys.ts, Task 13). Both go through the
// steering rails (`ctx.mayDrive`: scope, kind, hands-off, the 60-second rule, the lock; key_send lets the lock of the
// central's own task through), and key_send refuses a card that has not started before it calls the route. The
// keys route's refusals (server/sessionKeysRouter.ts) reach the central as INVALID with fixed hints, a card that has
// not started as UNAVAILABLE. A fake client stands in for the routes: nothing here reaches a terminal or a process.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { KEY_NAMES } from '../../server/sessionKeysRouter.js';
import { allTools } from '../../server/mcp/registry.js';
import { deliverCtx, refusedBy, worker } from './deliverToolFixtures.js';
import { makeCentral, makeRoom, NOW, ok, run, runRefused, unheard, type Answer } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const KEYS = 'POST /sessions/w1/keys';
const CLEAR = 'POST /terminals/term-w1/clear';

function setup(opts: { keys?: Answer; session?: ReturnType<typeof worker>; isOpsTerminal?: (t: string) => boolean; controller?: Parameters<typeof deliverCtx>[0]['controller'] } = {}) {
  return deliverCtx({
    sessions: [opts.session ?? worker('w1')],
    routes: { [KEYS]: opts.keys ?? ok({ ok: true }), [CLEAR]: ok({ ok: true, cleared: true }) },
    ...(opts.isOpsTerminal ? { isOpsTerminal: opts.isOpsTerminal } : {}),
    ...(opts.controller ? { controller: opts.controller } : {}),
  });
}

const keyCalls = (h: ReturnType<typeof setup>) => h.client.calls.filter((c) => c.path.endsWith('/keys'));

const inputOf = (name: string) => z.object(allTools().find((t) => t.name === name)!.input);

describe('key_send', () => {
  it('sends the key by name to the keys route, and says so', async () => {
    const h = setup();

    const result = await run('key_send', { id: 'w1', key: 'down' }, h.ctx);

    expect(keyCalls(h)).toEqual([{ method: 'POST', path: '/sessions/w1/keys', body: { key: 'down' } }]);
    expect(result.data).toMatchObject({ id: 'w1', key: 'down', sent: true });
    expect(result.activity).toEqual([{ summary: 'Pressed down.', targetSessionId: 'w1', detail: { key: 'down' } }]);
  });

  it('ctrl-c is not a key (zod)', () => {
    const schema = inputOf('key_send');

    for (const key of KEY_NAMES) expect(schema.safeParse({ id: 'w1', key }).success, key).toBe(true);
    for (const key of ['ctrl-c', 'ctrl+c', '\x03', 'c', '0', 'ESC', '']) {
      expect(schema.safeParse({ id: 'w1', key }).success, key).toBe(false);
    }
    expect(KEY_NAMES).not.toContain('ctrl-c');
  });

  it('keys to a never-started card are refused', async () => {
    for (const session of [unheard(worker('w1')), worker('w1', { startHeard: false })]) {
      const h = setup({ session });
      const err = await runRefused('key_send', { id: 'w1', key: 'enter' }, h.ctx);
      expect(err.code).toBe('UNAVAILABLE');
      expect(err.message).toMatch(/not reported that it started/);
      expect(keyCalls(h)).toEqual([]);
    }
  });

  it('esc is refused while working', async () => {
    const h = setup({ session: worker('w1', { status: 'working' }), keys: refusedBy(409, 'mid_turn') });

    const err = await runRefused('key_send', { id: 'w1', key: 'esc' }, h.ctx);

    expect(err.code).toBe('INVALID');
    expect(err.hint).toMatch(/that would interrupt the turn/);
  });

  it('digits, enter and tab are refused while a dialog is open', async () => {
    const h = setup({ session: worker('w1', { status: 'approval' }), keys: refusedBy(409, 'awaiting_answer') });

    for (const key of ['1', 'enter', 'tab']) {
      const err = await runRefused('key_send', { id: 'w1', key }, h.ctx);
      expect(err.code, key).toBe('INVALID');
      expect(err.hint, key).toMatch(/answer it with request_answer/);
    }
  });

  it('a key with no menu known open is refused in fixed words', async () => {
    const h = setup({ keys: refusedBy(409, 'no_menu') });

    const err = await runRefused('key_send', { id: 'w1', key: 'up' }, h.ctx);

    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/no menu AASC knows is open/);
    expect(err.hint).toMatch(/command_run/);
  });

  it('a second esc within 2 s on an idle card is refused in fixed words', async () => {
    const h = setup({ keys: refusedBy(409, 'double_esc') });

    const err = await runRefused('key_send', { id: 'w1', key: 'esc' }, h.ctx);

    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/rewind/);
  });

  it('turns the route’s other refusals into fixed words', async () => {
    const shell = setup({ keys: refusedBy(409, 'agent_not_running') });
    const notStarted = setup({ keys: refusedBy(409, 'not_started') });
    const gone = setup({ keys: refusedBy(404, 'Session not found') });
    const remote = setup({ keys: refusedBy(403, 'This Mac only') });

    const shellErr = await runRefused('key_send', { id: 'w1', key: 'enter' }, shell.ctx);
    expect(shellErr.code).toBe('INVALID');
    expect(shellErr.message).toMatch(/agent is not in front/);
    const notStartedErr = await runRefused('key_send', { id: 'w1', key: 'enter' }, notStarted.ctx);
    expect(notStartedErr.code).toBe('UNAVAILABLE');
    expect(notStartedErr.message).toMatch(/not reported that it started/);
    expect((await runRefused('key_send', { id: 'w1', key: 'enter' }, gone.ctx)).code).toBe('NOT_FOUND');
    expect((await runRefused('key_send', { id: 'w1', key: 'enter' }, remote.ctx)).code).toBe('DENIED');
  });

  it('key_send applies hands-off and the 60 s rule', async () => {
    const handsOff = setup({ session: worker('w1', { handsOff: true }) });
    const human = setup({ controller: () => ({ clientId: 'desktop-1', lastActivityAt: NOW - 5_000 }) });

    expect((await runRefused('key_send', { id: 'w1', key: 'up' }, handsOff.ctx)).code).toBe('HANDS_OFF');
    expect((await runRefused('key_send', { id: 'w1', key: 'up' }, human.ctx)).code).toBe('HUMAN_ACTIVE');
    expect([...keyCalls(handsOff), ...keyCalls(human)]).toEqual([]);
  });

  it('presses keys in the session of the central’s own task, and refuses one another central’s task holds', async () => {
    const mine = setup();
    mine.ctx.ledger.create({ central: mine.ctx.central, session: mine.ctx.sessions()[0], task: 'review the diff' });
    expect(mine.ctx.ledger.isLocked('w1')).toBe(true);
    await run('key_send', { id: 'w1', key: '2' }, mine.ctx);
    expect(keyCalls(mine)).toHaveLength(1);

    const theirs = setup();
    theirs.base.create({
      central: makeCentral('global', null, { centralId: 'central-2', terminalId: 'term-c2' }),
      session: theirs.ctx.sessions()[0],
      task: 'theirs',
    });
    expect((await runRefused('key_send', { id: 'w1', key: '2' }, theirs.ctx)).code).toBe('BUSY');
    expect(keyCalls(theirs)).toEqual([]);
  });

  it('is scope-checked before anything is sent', async () => {
    const h = deliverCtx({
      central: makeCentral('room', 'r1'),
      sessions: [worker('w1')],
      rooms: [makeRoom('r1', [])],
      routes: { [KEYS]: ok({ ok: true }) },
    });

    expect((await runRefused('key_send', { id: 'w1', key: 'enter' }, h.ctx)).code).toBe('NOT_IN_SCOPE');
    expect(h.client.calls).toEqual([]);
  });

  it('carries P3-11’s rules in its description', () => {
    const { description } = allTools().find((t) => t.name === 'key_send')!;
    for (const words of [
      'ctrl-c', 'mid-turn', 'working, prompting, approval, input', 'request_answer', 'allow_always', 'not started',
      'a menu AASC knows is open', 'more than 5 s after', '60 s', 'second esc within 2 s', 'rewind',
      'enter, digit or esc', 'up, down and tab keep it',
    ]) {
      expect(description, words).toContain(words);
    }
  });
});

describe('terminal_clear', () => {
  it('clears the session’s terminal through the clear route', async () => {
    const h = setup();

    const result = await run('terminal_clear', { id: 'w1' }, h.ctx);

    expect(h.client.calls).toEqual([{ method: 'POST', path: '/terminals/term-w1/clear' }]);
    expect(result.data).toMatchObject({ id: 'w1', terminalId: 'term-w1', cleared: true });
  });

  it('terminal_clear refuses an ops shell', async () => {
    const h = setup({ isOpsTerminal: (t) => t === 'term-w1' });

    expect((await runRefused('terminal_clear', { id: 'w1' }, h.ctx)).code).toBe('INVALID');
    expect(h.client.calls).toEqual([]);
  });

  it('applies hands-off and the 60 s rule', async () => {
    const handsOff = setup({ session: worker('w1', { handsOff: true }) });
    const human = setup({ controller: () => ({ clientId: 'desktop-1', lastActivityAt: NOW - 5_000 }) });

    expect((await runRefused('terminal_clear', { id: 'w1' }, handsOff.ctx)).code).toBe('HANDS_OFF');
    expect((await runRefused('terminal_clear', { id: 'w1' }, human.ctx)).code).toBe('HUMAN_ACTIVE');
  });
});
