// test/mcp/tools.queueWriteLock.test.ts — Ruling 42: a central starts no unattended run in a session it did not open
// itself. So the calls that would make the window send without anyone asking are refused DENIED, with one hint: turning a
// prompt ON (`queue_set_item_enabled`), ⚡ NOW (`queue_fire_now`), turning auto-send ON (`queue_set_auto_send`), turning
// auto-enter or auto-resume ON (`queue_set_automation`), and (Ruling 43) resuming a paused queue and releasing a cancel's
// hold. Turning any of them OFF, and pausing, stay allowed. The refusal is one helper (`assertMayStartUnattended`), the
// single place P4 relaxes, for the central's own workers (Ruling P4-12, server/mcp/workers.ts): there the calls go ahead
// and `queue_add_item` adds its prompt on. These tests run the tools under the lock the server has, with an own worker,
// and once with the helper let through to show that nothing else changes. What else Rulings 43, 52 and 53 lock is in
// tools.queueWriteLockMore.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectInput, roomInput } from './centralFixtures.js';
import { automationOf, item, itemWith, NOW, queueOf, type FakeQueueStore } from './queueFixtures.js';
import { loggedWorld, queueWorld, RESUME_ROUTE, standardRows, toolNamed, worker } from './queueToolFixtures.js';
import { createWorkerRegistry, type WorkerRegistry } from '../../server/mcp/workers.js';
import { makeCentral, makeRoom } from './toolHarness.js';

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

/** What the person is told, word for word (Ruling 42). */
const HINT = 'Only you can turn this on in AASC; a central can do it only in a session it opened itself';

/** What a central may not do until P4: each with the arguments that ask for it. */
const REFUSED: Array<[string, string, Record<string, unknown>]> = [
  ['turn a prompt on', 'queue_set_item_enabled', { id: 's1', itemId: 1, enabled: true }],
  ['start a prompt now', 'queue_fire_now', { id: 's1', itemId: 1 }],
  ['turn auto-send on', 'queue_set_auto_send', { id: 's1', autoSend: true }],
  ['turn auto-enter on', 'queue_set_automation', { id: 's1', autoEnter: true }],
  ['turn auto-resume on', 'queue_set_automation', { id: 's1', autoResume: true }],
  ['turn auto-resume on among changes that would be allowed', 'queue_set_automation', { id: 's1', autoEnter: false, autoResume: true, resumeMaxRetries: 2 }],
  ['resume a paused queue', 'queue_set_paused', { id: 's1', paused: false }],
  ['release the hold a person’s cancel put on the queue', 'queue_resume_after_cancel', { id: 's1' }],
];

type Row = NonNullable<ReturnType<FakeQueueStore['rows']['get']>>;

/** A registry in which the central of the tests (`central-1`) opened the session in `term-s1`, `s1`'s terminal. */
function ownS1(): WorkerRegistry {
  const workers = createWorkerRegistry({ controller: () => null });
  workers.add({ centralId: 'central-1', terminalId: 'term-s1', openedAt: NOW - 60_000, folder: '/a/proj', cli: 'claude' });
  return workers;
}

interface Allowed {
  label: string;
  name: string;
  args: Record<string, unknown>;
  /** What the stored queue must show afterwards. */
  check(row: Row): void;
}

/** What stays allowed: turning off, pausing, and the changes that start no send. */
const ALLOWED: Allowed[] = [
  {
    label: 'turn a prompt off',
    name: 'queue_set_item_enabled',
    args: { id: 's1', itemId: 1, enabled: false },
    check: (row) => expect(itemWith(row.items, 1).disabled).toBe(true),
  },
  {
    label: 'pause the queue',
    name: 'queue_set_paused',
    args: { id: 's1', paused: true },
    check: (row) => expect(row.automation).toMatchObject({ paused: true }),
  },
  {
    label: 'turn auto-send off',
    name: 'queue_set_auto_send',
    args: { id: 's1', autoSend: false },
    check: (row) => expect(row.automation).toMatchObject({ autoSend: false }),
  },
  {
    label: 'turn auto-enter and auto-resume off',
    name: 'queue_set_automation',
    args: { id: 's1', autoEnter: false, autoResume: false },
    check: (row) => expect(row.automation).toMatchObject({ autoEnter: false, autoResume: false }),
  },
  // Ruling 53: this pinned raising the retries (3 to 5) as allowed; more attempts loosen the watchdog, so it lowers them.
  {
    label: 'lower the retries and add quiet hours, which start no send',
    name: 'queue_set_automation',
    args: { id: 's1', resumeMaxRetries: 2, loopExcludeWindows: [{ start: '23:00', end: '06:00' }] },
    check: (row) => expect(row.automation).toMatchObject({ resumeMaxRetries: 2, loopExcludeWindows: [expect.objectContaining({ startHHMM: '23:00' })] }),
  },
];

describe('what a central may not do until P4', () => {
  it.each(REFUSED)('to %s: DENIED, with the hint, before anything is read, written or asked of AASC', async (_label, name, args) => {
    const w = queueWorld({ rows: standardRows() });

    const err = await w.refused(name, args);

    expect(err.code).toBe('DENIED');
    expect(err.hint).toBe(HINT);
    expect(w.store.calls).toEqual([]);
    expect(w.client.calls).toEqual([]);
  });

  it.each(REFUSED)('to %s: the words name neither the session nor anything the central sent', async (_label, name, args) => {
    const w = queueWorld({ rows: standardRows() });

    const err = await w.refused(name, { ...args, id: 's1' });

    expect(`${err.message} ${err.hint}`).not.toMatch(/\bs1\b|Worker s1/);
  });

  it('does not change the queue when one call mixes an allowed change with the one that is not: all of it is refused', async () => {
    const w = queueWorld({ rows: standardRows() });

    await w.refused('queue_set_automation', { id: 's1', autoEnter: false, autoResume: true, resumeMaxRetries: 9 });

    expect(w.store.rows.get('s1')?.automation).toEqual(automationOf());
    expect(w.store.writes).toEqual([]);
  });

  it('is the same for a room central on its own room’s session and a project central in its folder', async () => {
    const room = queueWorld({
      central: makeCentral('room', 'r1'),
      sessions: [worker('s1')],
      rooms: [makeRoom('r1', ['s1'])],
      rows: standardRows(),
    });
    const project = queueWorld({ central: makeCentral('project', '/a/proj'), sessions: [worker('s1')], rows: standardRows() });

    for (const w of [room, project]) {
      for (const [, name, args] of REFUSED) expect((await w.refused(name, args)).code, name).toBe('DENIED');
    }
  });

  it('lets the central’s own worker through (P4-12), and holds for every other session in its scope', async () => {
    const w = queueWorld({
      central: makeCentral('room', 'r1'),
      sessions: [worker('s1'), worker('s2')],
      rooms: [makeRoom('r1', ['s2'])],
      workers: ownS1(),
      rows: standardRows(),
      routes: RESUME_ROUTE,
    });

    expect(w.ctx.inScope(worker('s1'))).toBe(true);
    for (const [, name, args] of REFUSED) expect((await w.refused(name, { ...args, id: 's2' })).code, name).toBe('DENIED');
    await w.call('queue_set_item_enabled', { id: 's1', itemId: 1, enabled: true });
    await w.call('queue_fire_now', { id: 's1', itemId: 2 });
    await w.call('queue_set_auto_send', { id: 's1', autoSend: true });
    await w.call('queue_set_automation', { id: 's1', autoEnter: true, autoResume: true });
    await w.call('queue_set_paused', { id: 's1', paused: false });
    await w.call('queue_resume_after_cancel', { id: 's1' });
    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1).disabled).not.toBe(true);
    expect(w.store.rows.get('s1')?.automation).toMatchObject({ autoSend: true, autoEnter: true, autoResume: true });
  });

  it('keeps the rails for the central’s own worker: hands-off, a person’s recent drive and a dialog still refuse', async () => {
    const handsOff = queueWorld({ sessions: [worker('s1', { handsOff: true })], workers: ownS1(), rows: standardRows() });
    const waiting = queueWorld({ sessions: [worker('s1', { status: 'approval' })], workers: ownS1(), rows: standardRows() });

    for (const [, name, args] of REFUSED) expect((await handsOff.refused(name, args)).code, name).toBe('HANDS_OFF');
    expect((await waiting.refused('queue_fire_now', { id: 's1', itemId: 2 })).code).toBe('BUSY');
  });

  it('refuses auto-send on for an own worker the connecting timeout turned idle, never heard (Ruling P4-41)', async () => {
    const w = queueWorld({ sessions: [worker('s1', { status: 'idle', startHeard: false })], workers: ownS1(), rows: standardRows() });
    // Turning it off still works: it only stops things.
    await w.call('queue_set_auto_send', { id: 's1', autoSend: false });
    expect(w.store.rows.get('s1')?.automation).toMatchObject({ autoSend: false });
    const err = await w.refused('queue_set_auto_send', { id: 's1', autoSend: true });
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toBe('The session has not reported that it started.');
    expect(err.hint).toBe('If it shows a question, the person answers it in AASC.');
    expect(w.store.rows.get('s1')?.automation).toMatchObject({ autoSend: false });
    // Once its first hook cleared the marker, it may be turned on.
    const heard = queueWorld({ sessions: [worker('s1', { status: 'idle' })], workers: ownS1(), rows: standardRows() });
    await heard.call('queue_set_auto_send', { id: 's1', autoSend: false });
    await heard.call('queue_set_auto_send', { id: 's1', autoSend: true });
    expect(heard.store.rows.get('s1')?.automation).toMatchObject({ autoSend: true });
  });

  it('comes before the rails and the window: a central is not told to retry what can never work', async () => {
    const states: Array<[string, Parameters<typeof queueWorld>[0]]> = [
      ['a hands-off session', { sessions: [worker('s1', { handsOff: true })] }],
      ['a session a person just drove', { controller: () => ({ clientId: 'device-1', lastActivityAt: NOW - 5_000 }) }],
      ['a session that waits on an approval', { sessions: [worker('s1', { status: 'approval' })] }],
      ['no window open', { writer: null }],
    ];
    for (const [what, over] of states) {
      for (const [, name, args] of REFUSED) {
        const w = queueWorld({ rows: standardRows(), ...over });
        expect((await w.refused(name, args)).code, `${name} on ${what}`).toBe('DENIED');
      }
    }
  });

  it('says nothing about a session out of scope: that is still NOT_IN_SCOPE', async () => {
    const w = queueWorld({
      central: makeCentral('room', 'r1'),
      sessions: [worker('s1', { title: 'TOP SECRET' })],
      rooms: [makeRoom('r1', [])],
      rows: standardRows(),
    });

    for (const [, name, args] of REFUSED) {
      const err = await w.refused(name, args);
      expect(err.code, name).toBe('NOT_IN_SCOPE');
      expect(`${err.message} ${err.hint}`).not.toMatch(/TOP SECRET/);
    }
  });

  it('is logged like the other refusals: refused, with its code, under the tool’s name and risk, and nothing written', async () => {
    for (const [, name, args] of REFUSED) {
      const w = loggedWorld();

      const err = await w.failure(name, args);

      expect(err.code, name).toBe('DENIED');
      expect(w.activity.listActivity(), name).toEqual([
        expect.objectContaining({
          centralId: w.central.centralId,
          tool: name,
          risk: toolNamed(w.tools, name).risk,
          outcome: 'refused',
          detail: { code: 'DENIED' },
          summary: expect.stringContaining('Refused (DENIED)'),
        }),
      ]);
      expect(w.store.calls, name).toEqual([]);
    }
  });
});

describe('what stays allowed under the lock', () => {
  it.each(ALLOWED)('to %s', async ({ name, args, check }) => {
    const w = queueWorld({ rows: standardRows() });

    const result = await w.call(name, args);

    check(w.store.rows.get('s1') as Row);
    expect(w.store.writes).toHaveLength(1);
    expect(result.activity).toHaveLength(1);
  });

  it.each(ALLOWED)('to %s: logged ok', async ({ name, args }) => {
    const w = loggedWorld();

    await w.call(name, args);

    expect(w.activity.listActivity()).toEqual([expect.objectContaining({ tool: name, outcome: 'ok', targetSessionId: 's1' })]);
  });

  it('queue_add_item adds enabled to an own worker, disabled elsewhere', async () => {
    const w = queueWorld({
      sessions: [worker('s1'), worker('s2')],
      workers: ownS1(),
      rows: { s1: { items: queueOf(1) }, s2: { items: queueOf(1) } },
    });

    const mine = await w.call('queue_add_item', { id: 's1', text: 'next step' });
    const elsewhere = await w.call('queue_add_item', { id: 's2', text: 'next step' });
    const added = (id: string) => (w.store.rows.get(id)?.items ?? []).at(-1) as Record<string, unknown>;

    expect(added('s1').disabled).toBeUndefined();
    expect(mine.summary).toContain('It is on');
    expect(mine.activity).toEqual([expect.objectContaining({ summary: 'Queued a prompt, on (its own worker)', targetSessionId: 's1' })]);
    expect(added('s2').disabled).toBe(true);
    expect(elsewhere.summary).toContain('runs once a human enables it');
    expect(elsewhere.activity).toEqual([expect.objectContaining({ summary: 'Queued a prompt, paused', targetSessionId: 's2' })]);
  });

  it("an own worker's queue still refuses a never command", async () => {
    const w = queueWorld({ workers: ownS1(), rows: standardRows() });
    const writes: Array<[string, Record<string, unknown>]> = [
      ['queue_add_item', { id: 's1', text: '/clear' }],
      ['queue_edit_item', { id: 's1', itemId: 1, text: '/logout' }],
      ['queue_add_step', { id: 's1', itemId: 1, chain: 'after', text: '/exit now' }],
      ['queue_edit_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10, text: '/permissions' }],
      ['queue_set_automation', { id: 's1', resumePrompt: '/config' }],
    ];

    for (const [name, args] of writes) expect((await w.refused(name, args)).code, name).toBe('INVALID');
    expect(w.store.writes).toEqual([]);
  });

  it('adds a prompt paused and leaves it for a person to turn on', async () => {
    const w = queueWorld({ rows: { s1: { items: queueOf(1) } } });

    await w.call('queue_add_item', { id: 's1', text: 'later' });
    const added = (w.store.rows.get('s1')?.items ?? []).at(-1) as Record<string, unknown>;
    const refused = await w.refused('queue_set_item_enabled', { id: 's1', itemId: added.id, enabled: true });

    expect(added.disabled).toBe(true);
    expect(refused.code).toBe('DENIED');
    expect(itemWith(w.store.rows.get('s1')?.items ?? [], added.id as number).disabled).toBe(true);
  });

  // A prompt that is on is locked for these (Ruling 43, tools.queueWriteLockMore.test.ts), and releasing a cancel's
  // hold now is too: they run on the paused prompt 1, and prompt 2, which is on, is only removed.
  it('still edits, reorders, retimes and removes a paused prompt and its steps (none of it starts a send), and removes one that is on', async () => {
    const w = queueWorld({ rows: standardRows(), routes: RESUME_ROUTE });
    const calls: Array<[string, Record<string, unknown>]> = [
      ['queue_edit_item', { id: 's1', itemId: 1, text: 'changed' }],
      ['queue_move_item', { id: 's1', itemId: 1, position: 1 }],
      ['queue_set_item_schedule', { id: 's1', itemId: 1, type: 'loop', intervalMs: 120_000 }],
      ['queue_add_step', { id: 's1', itemId: 1, chain: 'after', text: 'wrap up' }],
      ['queue_edit_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10, text: 'better' }],
      ['queue_move_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10, position: 0 }],
      ['queue_remove_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10 }],
      ['queue_remove_item', { id: 's1', itemId: 2 }],
    ];

    for (const [name, args] of calls) await expect(w.call(name, args), name).resolves.toBeDefined();
  });
});

describe('the helper is the one place to relax', () => {
  it('with it let through (what P4 does for a central’s own worker) the calls go ahead, and the rails still apply after it', async () => {
    const open = queueWorld({ rows: standardRows(), routes: RESUME_ROUTE, unlocked: true });
    await open.call('queue_set_item_enabled', { id: 's1', itemId: 2, enabled: false });
    await open.call('queue_set_item_enabled', { id: 's1', itemId: 2, enabled: true });
    await open.call('queue_fire_now', { id: 's1', itemId: 2 });
    await open.call('queue_set_auto_send', { id: 's1', autoSend: true });
    await open.call('queue_set_automation', { id: 's1', autoEnter: true, autoResume: true });
    await open.call('queue_set_paused', { id: 's1', paused: false });
    await open.call('queue_resume_after_cancel', { id: 's1' });
    expect(itemWith(open.store.rows.get('s1')?.items ?? [], 2).forceStart).toBe(true);

    const handsOff = queueWorld({ rows: standardRows(), routes: RESUME_ROUTE, unlocked: true, sessions: [worker('s1', { handsOff: true })] });
    for (const [, name, args] of REFUSED) expect((await handsOff.refused(name, args)).code, name).toBe('HANDS_OFF');
  });

  it('keeps the dialog guard and the window check of queue_fire_now behind it', async () => {
    const waiting = queueWorld({ rows: standardRows(), unlocked: true, sessions: [worker('s1', { status: 'approval' })] });
    const noWindow = queueWorld({ rows: standardRows(), unlocked: true, writer: null });

    expect((await waiting.refused('queue_fire_now', { id: 's1', itemId: 1 })).code).toBe('BUSY');
    expect((await noWindow.refused('queue_fire_now', { id: 's1', itemId: 1 })).code).toBe('NO_WINDOW');
  });
});

describe('what the central is told about the lock', () => {
  const described = (name: string): string => queueWorld().tools.find((t) => t.name === name)?.description ?? '';

  it.each(['queue_set_item_enabled', 'queue_fire_now', 'queue_set_auto_send', 'queue_set_automation'])(
    '%s says in its description that turning on is refused (DENIED) outside the central’s own workers',
    (name) => {
      expect(described(name)).toContain('DENIED');
      expect(described(name)).toContain('opened itself');
    },
  );

  it('queue_add_item says a central cannot turn its prompt on: only a person can, in AASC', () => {
    expect(described('queue_add_item')).toMatch(/cannot turn it on|a central cannot/i);
    expect(described('queue_add_item')).toContain('AASC');
  });

  it('is told, in the answer to an add, who can turn the prompt on', async () => {
    const w = queueWorld({ rows: { s1: { items: [item(1)] } } });

    const result = await w.call('queue_add_item', { id: 's1', text: 'later' });

    expect(result.summary).toContain('turn it on in AASC');
    expect(result.summary).toContain('runs once a human enables it');
  });
});

describe('every kind of central', () => {
  it('is refused through the real endpoint path as a room or project central too', async () => {
    for (const input of [roomInput('r1'), projectInput('/a/proj')]) {
      const w = loggedWorld({ input, rooms: [makeRoom('r1', ['s1'])], sessions: [worker('s1')] });

      const err = await w.failure('queue_fire_now', { id: 's1', itemId: 1 });

      expect(err.code, input.kind).toBe('DENIED');
    }
  });
});
