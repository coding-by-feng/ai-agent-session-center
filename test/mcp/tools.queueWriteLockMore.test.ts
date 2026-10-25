// test/mcp/tools.queueWriteLockMore.test.ts — what Rulings 43, 52 and 53 add to the lock of Ruling 42
// (tools.queueWriteLock.test.ts). The AASC window sends a prompt that is ON by itself, so changing what it says, when it
// runs, its chain, or where it stands among the prompts that are on changes an unattended run: refused DENIED, while the
// same change to a prompt that is OFF stays allowed (a person turns it on). Resuming a paused queue, releasing a cancel's
// hold, turning the idle guard or the prompting hold off, a new resume prompt, taking quiet hours away and more resume
// attempts loosen when and what the window sends by itself: refused too, while pausing, adding quiet hours, fewer
// attempts and turning a switch off stay allowed. With no automation record stored, a central changes no switch at all
// (Ruling 52), and a switch a record lacks is written as off, never on. Every lock goes through the one helper P4 relaxes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueueWriteTools } from '../../server/mcp/tools/queueWrite.js';
import { automationOf, fakeQueueStore, idsOf, item, itemWith, NOW, type FakeQueueStore } from './queueFixtures.js';
import { callOn, loggedWorld, presence, queueWorld, RESUME_ROUTE, worker } from './queueToolFixtures.js';
import { makeCtx } from './toolHarness.js';

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

/** What the person is told, word for word, for each kind of change. */
const START_HINT = 'Only you can turn this on in AASC; a central can do it only in a session it opened itself';
const ON_HINT = 'Turn it off first (queue_set_item_enabled), then change it: once a central has changed it, only a person can turn it back on, in AASC.';
const LOOSEN_HINT = 'Only you can change this in AASC; a central can do it only in a session it opened itself';
const NO_RECORD_HINT = 'Change one queue switch in AASC first.';

const NIGHT = { start: '22:00', end: '06:00' };
const LUNCH = { start: '12:00', end: '13:00' };

/**
 * Prompt 1 is ON (a once prompt with a before step), prompt 2 is OFF (a loop with two after steps), prompt 3 is ON. The
 * session keeps two quiet-hours windows and four resume attempts.
 */
const rows = (automation: Record<string, unknown> = {}) => ({
  s1: {
    items: [
      item(1, { position: 0, beforeChain: [{ id: 10, text: 'on step' }] }),
      item(2, {
        position: 1,
        disabled: true,
        type: 'loop',
        intervalMs: 60_000,
        nextFireAt: NOW + 5_000,
        afterChain: [{ id: 20, text: 'off step' }, { id: 21, text: 'off step two' }],
      }),
      item(3, { position: 2 }),
    ],
    automation: automationOf({
      resumeMaxRetries: 4,
      loopExcludeWindows: [
        { id: 1, startHHMM: '22:00', endHHMM: '06:00' },
        { id: 2, startHHMM: '12:00', endHHMM: '13:00' },
      ],
      ...automation,
    }),
  },
});

interface Refused {
  label: string;
  name: string;
  args: Record<string, unknown>;
  hint: string;
  /** The lock needs the stored queue to say no: it is read (then nothing is written). Otherwise nothing is read. */
  reads: boolean;
}

/** What a central may not do until P4, beside what Ruling 42 already locks. */
const REFUSED: Refused[] = [
  // Ruling 43: a prompt that is on.
  { label: 'change the text of a prompt that is on', name: 'queue_edit_item', args: { itemId: 1, text: 'new words' }, hint: ON_HINT, reads: true },
  { label: 'retime a prompt that is on', name: 'queue_set_item_schedule', args: { itemId: 1, type: 'loop', intervalMs: 600_000 }, hint: ON_HINT, reads: true },
  { label: 'add a step to a prompt that is on', name: 'queue_add_step', args: { itemId: 1, chain: 'after', text: 'one more step' }, hint: ON_HINT, reads: true },
  { label: 'change a step of a prompt that is on', name: 'queue_edit_step', args: { itemId: 1, chain: 'before', stepId: 10, text: 'other words' }, hint: ON_HINT, reads: true },
  { label: 'take a step out of a prompt that is on', name: 'queue_remove_step', args: { itemId: 1, chain: 'before', stepId: 10 }, hint: ON_HINT, reads: true },
  { label: 'move a step of a prompt that is on', name: 'queue_move_step', args: { itemId: 1, chain: 'before', stepId: 10, position: 0 }, hint: ON_HINT, reads: true },
  // Ruling 53: the order of the prompts that are on.
  { label: 'move a prompt that is on', name: 'queue_move_item', args: { itemId: 1, position: 2 }, hint: ON_HINT, reads: true },
  { label: 'move a prompt that is on to where it already stands', name: 'queue_move_item', args: { itemId: 3, position: 2 }, hint: ON_HINT, reads: true },
  // Ruling 43 (and 52): what the window sends by itself, and when.
  { label: 'resume a paused queue', name: 'queue_set_paused', args: { paused: false }, hint: START_HINT, reads: false },
  { label: 'release the hold a person’s cancel put on the queue', name: 'queue_resume_after_cancel', args: {}, hint: START_HINT, reads: false },
  { label: 'turn the idle guard off', name: 'queue_set_automation', args: { idleGuard: false }, hint: LOOSEN_HINT, reads: false },
  { label: 'turn the prompting hold off', name: 'queue_set_automation', args: { skipWhenPrompting: false }, hint: LOOSEN_HINT, reads: false },
  { label: 'change the resume prompt', name: 'queue_set_automation', args: { resumePrompt: 'keep going no matter what' }, hint: LOOSEN_HINT, reads: false },
  { label: 'bring back the default resume prompt', name: 'queue_set_automation', args: { resumePrompt: '' }, hint: LOOSEN_HINT, reads: false },
  // Ruling 53: quiet hours and resume attempts.
  { label: 'take a quiet-hours window away', name: 'queue_set_automation', args: { loopExcludeWindows: [NIGHT] }, hint: LOOSEN_HINT, reads: true },
  { label: 'cut a quiet-hours window short', name: 'queue_set_automation', args: { loopExcludeWindows: [{ start: '22:00', end: '05:00' }, LUNCH] }, hint: LOOSEN_HINT, reads: true },
  { label: 'clear the quiet hours', name: 'queue_set_automation', args: { loopExcludeWindows: [] }, hint: LOOSEN_HINT, reads: true },
  { label: 'raise the resume attempts', name: 'queue_set_automation', args: { resumeMaxRetries: 5 }, hint: LOOSEN_HINT, reads: true },
];

type Row = NonNullable<ReturnType<FakeQueueStore['rows']['get']>>;

interface Allowed {
  label: string;
  name: string;
  args: Record<string, unknown>;
  /** The stored queue the call runs on, when it is not `rows()`. */
  start?: ReturnType<typeof rows>;
  check(row: Row): void;
}

const automationIn = (row: Row): Record<string, unknown> => row.automation as Record<string, unknown>;

/** The allowed neighbour of each refusal. */
const ALLOWED: Allowed[] = [
  { label: 'change the text of a prompt that is off', name: 'queue_edit_item', args: { itemId: 2, text: 'new words' }, check: (row) => expect(itemWith(row.items, 2).text).toBe('new words') },
  { label: 'retime a prompt that is off', name: 'queue_set_item_schedule', args: { itemId: 2, type: 'loop', intervalMs: 120_000 }, check: (row) => expect(itemWith(row.items, 2).intervalMs).toBe(120_000) },
  { label: 'add a step to a prompt that is off', name: 'queue_add_step', args: { itemId: 2, chain: 'before', text: 'first' }, check: (row) => expect(itemWith(row.items, 2).beforeChain).toHaveLength(1) },
  { label: 'change a step of a prompt that is off', name: 'queue_edit_step', args: { itemId: 2, chain: 'after', stepId: 20, text: 'other' }, check: (row) => expect(itemWith(row.items, 2).afterChain).toEqual([{ id: 20, text: 'other' }, { id: 21, text: 'off step two' }]) },
  { label: 'take a step out of a prompt that is off', name: 'queue_remove_step', args: { itemId: 2, chain: 'after', stepId: 20 }, check: (row) => expect(itemWith(row.items, 2).afterChain).toEqual([{ id: 21, text: 'off step two' }]) },
  { label: 'move a step of a prompt that is off', name: 'queue_move_step', args: { itemId: 2, chain: 'after', stepId: 21, position: 0 }, check: (row) => expect(idsOf(itemWith(row.items, 2).afterChain as never)).toEqual([21, 20]) },
  { label: 'move a prompt that is off, which keeps the prompts that are on in their order', name: 'queue_move_item', args: { itemId: 2, position: 0 }, check: (row) => expect(idsOf(row.items)).toEqual([2, 1, 3]) },
  { label: 'turn a prompt that is on off', name: 'queue_set_item_enabled', args: { itemId: 1, enabled: false }, check: (row) => expect(itemWith(row.items, 1).disabled).toBe(true) },
  { label: 'remove a prompt that is on', name: 'queue_remove_item', args: { itemId: 1 }, check: (row) => expect(idsOf(row.items)).toEqual([2, 3]) },
  { label: 'pause the queue', name: 'queue_set_paused', args: { paused: true }, check: (row) => expect(automationIn(row).paused).toBe(true) },
  {
    label: 'turn the idle guard and the prompting hold on',
    name: 'queue_set_automation',
    args: { idleGuard: true, skipWhenPrompting: true },
    start: rows({ idleGuard: false, skipWhenPrompting: false }),
    check: (row) => expect(automationIn(row)).toMatchObject({ idleGuard: true, skipWhenPrompting: true }),
  },
  {
    label: 'add a quiet-hours window',
    name: 'queue_set_automation',
    args: { loopExcludeWindows: [NIGHT, LUNCH, { start: '03:00', end: '04:00' }] },
    check: (row) => expect(automationIn(row).loopExcludeWindows).toHaveLength(3),
  },
  {
    label: 'list the same quiet hours in another order',
    name: 'queue_set_automation',
    args: { loopExcludeWindows: [LUNCH, NIGHT] },
    check: (row) => expect(automationIn(row).loopExcludeWindows).toHaveLength(2),
  },
  { label: 'lower the resume attempts', name: 'queue_set_automation', args: { resumeMaxRetries: 2 }, check: (row) => expect(automationIn(row).resumeMaxRetries).toBe(2) },
  { label: 'keep the resume attempts', name: 'queue_set_automation', args: { resumeMaxRetries: 4 }, check: (row) => expect(automationIn(row).resumeMaxRetries).toBe(4) },
  { label: 'turn a switch off', name: 'queue_set_automation', args: { autoResume: false }, check: (row) => expect(automationIn(row).autoResume).toBe(false) },
];

describe('what Rulings 43 and 53 add to the lock', () => {
  it.each(REFUSED)('to $label: DENIED with its hint, and nothing written or asked of AASC', async ({ name, args, hint, reads }) => {
    const w = queueWorld({ rows: rows(), routes: RESUME_ROUTE });

    const err = await w.refused(name, { id: 's1', ...args });

    expect(err.code).toBe('DENIED');
    expect(err.hint).toBe(hint);
    expect(w.store.writes).toEqual([]);
    expect(w.store.calls).toEqual(reads ? ['read s1'] : []);
    expect(w.client.calls).toEqual([]);
  });

  it.each(REFUSED)('to $label: the words name neither the session nor anything the central sent', async ({ name, args }) => {
    const w = queueWorld({ rows: rows(), routes: RESUME_ROUTE });

    const err = await w.refused(name, { id: 's1', ...args });

    expect(`${err.message} ${err.hint}`).not.toMatch(/\bs1\b|Worker s1|new words|one more step|other words|keep going|on step/);
  });

  it('refuses a call whole when it mixes a looser rule with changes that would be allowed', async () => {
    const w = queueWorld({ rows: rows() });

    await w.refused('queue_set_automation', { id: 's1', idleGuard: true, skipWhenPrompting: false });
    await w.refused('queue_set_automation', { id: 's1', autoEnter: false, resumeMaxRetries: 9 });
    await w.refused('queue_set_automation', { id: 's1', autoResume: false, loopExcludeWindows: [] });

    expect(w.store.writes).toEqual([]);
    expect(w.store.rows.get('s1')?.automation).toEqual(rows().s1.automation);
  });

  it('says DENIED for a prompt that is on before anything else is wrong with the call', async () => {
    const w = queueWorld({ rows: rows() });

    expect((await w.refused('queue_edit_item', { id: 's1', itemId: 1, text: '!rm -rf ~' })).code).toBe('DENIED');
    expect((await w.refused('queue_set_item_schedule', { id: 's1', itemId: 1, type: 'once', intervalMs: 60_000 })).code).toBe('DENIED');
    expect((await w.refused('queue_add_step', { id: 's1', itemId: 1, chain: 'after', text: '   ' })).code).toBe('DENIED');
    expect((await w.refused('queue_set_automation', { id: 's1', resumePrompt: '!rm -rf ~' })).code).toBe('DENIED');
  });

  it('refuses moving a prompt that is off in a queue where a prompt has no position: the order of the ones on cannot be told', async () => {
    const unplaced = { s1: { items: [item(1, { position: 0 }), item(2, { position: 1 }), item(3, { position: undefined, disabled: true })], automation: automationOf() } };
    const w = queueWorld({ rows: unplaced });

    const err = await w.refused('queue_move_item', { id: 's1', itemId: 3, position: 0 });

    expect(err.code).toBe('DENIED');
    expect(err.hint).toBe(LOOSEN_HINT);
    expect(w.store.writes).toEqual([]);
  });

  it('is NOT_FOUND, not DENIED, for a prompt that is not in the queue', async () => {
    const w = queueWorld({ rows: rows() });

    expect((await w.refused('queue_edit_item', { id: 's1', itemId: 999, text: 'x' })).code).toBe('NOT_FOUND');
    expect((await w.refused('queue_move_item', { id: 's1', itemId: 999, position: 0 })).code).toBe('NOT_FOUND');
  });

  it('checks what needs only the arguments before the rails, as Ruling 42 does, and what needs the queue after them', async () => {
    const handsOff = () => queueWorld({ rows: rows(), routes: RESUME_ROUTE, sessions: [worker('s1', { handsOff: true })] });

    for (const { name, args, reads } of REFUSED) {
      const w = handsOff();
      const err = await w.refused(name, { id: 's1', ...args });
      expect(err.code, name).toBe(reads ? 'HANDS_OFF' : 'DENIED');
      expect(w.store.calls, name).toEqual([]);
    }
  });

  it('is logged as refused with DENIED under the tool’s name, and nothing written', async () => {
    const w = loggedWorld();

    const err = await w.failure('queue_edit_item', { id: 's1', itemId: 2, text: 'x' });

    expect(err.code).toBe('DENIED');
    expect(w.activity.listActivity()).toEqual([
      expect.objectContaining({ tool: 'queue_edit_item', outcome: 'refused', detail: { code: 'DENIED' } }),
    ]);
    expect(w.store.writes).toEqual([]);
  });
});

describe('what stays allowed beside them', () => {
  it.each(ALLOWED)('to $label', async ({ name, args, start, check }) => {
    const w = queueWorld({ rows: start ?? rows() });

    const result = await w.call(name, { id: 's1', ...args });

    check(w.store.rows.get('s1') as Row);
    expect(w.store.writes).toHaveLength(1);
    expect(result.activity).toHaveLength(1);
  });

  it('lets a central turn a prompt off and then change it, the way the refusal says, and leaves it off', async () => {
    const w = queueWorld({ rows: rows() });

    expect((await w.refused('queue_edit_item', { id: 's1', itemId: 1, text: 'better words' })).code).toBe('DENIED');
    await w.call('queue_set_item_enabled', { id: 's1', itemId: 1, enabled: false });
    await w.call('queue_edit_item', { id: 's1', itemId: 1, text: 'better words' });

    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1)).toMatchObject({ text: 'better words', disabled: true });
    expect((await w.refused('queue_set_item_enabled', { id: 's1', itemId: 1, enabled: true })).code).toBe('DENIED');
  });
});

describe('the helper is still the one place to relax', () => {
  it('is told what kind of change each call makes', async () => {
    const store = fakeQueueStore(rows());
    const seen: string[] = [];
    const tools = createQueueWriteTools({
      store: async () => store,
      mayStartUnattended: (_ctx, _session, change) => {
        seen.push(change ?? 'none');
      },
    });
    const { ctx } = makeCtx({ sessions: [worker('s1')], routes: { ...presence('device-1'), ...RESUME_ROUTE } });

    await callOn(tools, 'queue_edit_item', { id: 's1', itemId: 1, text: 'x' }, ctx);
    await callOn(tools, 'queue_set_automation', { id: 's1', idleGuard: false }, ctx);
    await callOn(tools, 'queue_set_paused', { id: 's1', paused: false }, ctx);
    await callOn(tools, 'queue_resume_after_cancel', { id: 's1' }, ctx);

    expect(seen).toEqual(['enabledPrompt', 'loosen', 'start', 'start']);
  });

  it('with it let through, every call above goes ahead', async () => {
    for (const { name, args } of REFUSED) {
      const w = queueWorld({ rows: rows(), routes: RESUME_ROUTE, unlocked: true });
      await expect(w.call(name, { id: 's1', ...args }), name).resolves.toBeDefined();
    }
  });
});

describe('a queue with no automation record, or a partial one (Ruling 52)', () => {
  const bare = () => ({ s1: { items: [item(1, { disabled: true })], automation: null } });

  it('no stored automation → INVALID with the hint', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['queue_set_automation', { autoEnter: false }],
      ['queue_set_automation', { resumeMaxRetries: 2 }],
      ['queue_set_automation', { loopExcludeWindows: [NIGHT] }],
    ];

    for (const [name, args] of calls) {
      const w = queueWorld({ rows: bare() });
      const err = await w.refused(name, { id: 's1', ...args });
      expect(err.code, name).toBe('INVALID');
      expect(err.hint, name).toBe(NO_RECORD_HINT);
      expect(w.store.writes, name).toEqual([]);
    }
  });

  // P4-32 M6: pausing and switching auto-send off only stop things, so they need no stored record: it is built from the
  // safe defaults (send switches off, guards on) and told to the window like any write.
  it.each([
    ['queue_set_paused', { paused: true }, 'paused'],
    ['queue_set_auto_send', { autoSend: false }, 'autoSend'],
  ] as const)('%s goes ahead with no stored automation, writing the safe defaults', async (name, args) => {
    const w = queueWorld({ rows: bare() });

    await w.call(name, { id: 's1', ...args });

    expect(w.store.writes).toHaveLength(1);
    expect(w.store.writes[0].automation).toMatchObject({
      autoSend: false,
      autoEnter: false,
      autoResume: false,
      idleGuard: true,
      skipWhenPrompting: true,
      paused: name === 'queue_set_paused',
    });
  });

  it('is DENIED first when the call is locked too', async () => {
    const w = queueWorld({ rows: bare() });

    expect((await w.refused('queue_set_paused', { id: 's1', paused: false })).code).toBe('DENIED');
    expect((await w.refused('queue_set_auto_send', { id: 's1', autoSend: true })).code).toBe('DENIED');
    expect((await w.refused('queue_set_automation', { id: 's1', resumeMaxRetries: 5 })).code).toBe('DENIED');
  });

  it('still lets every write about the prompts through: they carry no switch', async () => {
    const w = queueWorld({ rows: bare() });

    await w.call('queue_add_item', { id: 's1', text: 'later' });
    await w.call('queue_edit_item', { id: 's1', itemId: 1, text: 'changed' });

    expect(w.store.writes.map((x) => x.automation)).toEqual([null, null]);
  });

  it('a stored record missing autoResume stays off after queue_set_paused(true)', async () => {
    const partial = { paused: false, autoSend: true, autoEnter: true, idleGuard: true, skipWhenPrompting: true };
    const w = queueWorld({ rows: { s1: { items: [item(1)], automation: partial } } });

    const result = await w.call('queue_set_paused', { id: 's1', paused: true });

    expect(w.store.rows.get('s1')?.automation).toMatchObject({ paused: true, autoResume: false, autoSend: true });
    expect((result.data as { automation: { autoResume: boolean } }).automation.autoResume).toBe(false);
    expect(result.summary).toContain('auto-resume off');
  });

  it('writes every switch a record lacks as off, never on, whichever tool writes the record', async () => {
    const lacking = () => queueWorld({ rows: { s1: { items: [item(1)], automation: { paused: true } } } });
    const off = { autoSend: false, autoEnter: false, idleGuard: false, skipWhenPrompting: false, autoResume: false };

    const a = lacking();
    await a.call('queue_set_auto_send', { id: 's1', autoSend: false });
    expect(a.store.rows.get('s1')?.automation).toMatchObject({ ...off, paused: true });

    const b = lacking();
    await b.call('queue_set_automation', { id: 's1', autoEnter: false });
    expect(b.store.rows.get('s1')?.automation).toMatchObject({ ...off, paused: true, resumeMaxRetries: 3, resumePrompt: '' });
  });
});

describe('what the central is told', () => {
  const described = (name: string): string => queueWorld().tools.find((t) => t.name === name)?.description ?? '';

  it.each([
    'queue_edit_item',
    'queue_set_item_schedule',
    'queue_move_item',
    'queue_add_step',
    'queue_edit_step',
    'queue_remove_step',
    'queue_move_step',
    'queue_set_paused',
    'queue_set_automation',
    'queue_resume_after_cancel',
  ])('%s says in its description what is refused (DENIED) outside the central’s own workers', (name) => {
    expect(described(name)).toContain('DENIED');
    expect(described(name)).toContain('opened itself');
  });
});
