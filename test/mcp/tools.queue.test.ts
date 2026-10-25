// test/mcp/tools.queue.test.ts — the queue toolset's P1 reads (server/mcp/tools/queue.ts): queue_get,
// queue_list_all and queue_sent. A queue is text a person (or another device) wrote for a session: every body of
// it is fenced as untrusted in `data` and in the text; ids, positions, types, times and flags stay plain.
import { describe, expect, it, vi } from 'vitest';
import { blocksIn, deepFreeze, everything, expectFenced, HOSTILE, outsideFences } from './readFixtures.js';
import { dataOf, fail, makeCentral, makeCtx, makeRoom, makeSession, ok, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const plainItem = { id: 11, sessionId: 's1', text: 'Run the tests', position: 0, createdAt: 10 };
const loopItem = {
  id: 12, sessionId: 's1', text: 'Check the build', position: 1, createdAt: 11, type: 'loop', intervalMs: 300_000,
  nextFireAt: 5_000, lastFiredAt: 4_000, totalFires: 3, firstFireOfDay: '07:30', disabled: true,
  excludeWindows: [{ id: 1, startHHMM: '22:00', endHHMM: '06:00' }],
};
const scheduleItem = {
  id: 13, sessionId: 's1', text: 'Deploy to staging', position: 2, createdAt: 12, type: 'schedule', runAt: 1_700_000_100_000,
  beforeChain: [{ id: 1, text: 'Pull main' }, { id: 2, text: 'Run migrations', images: [{ name: 'plan.png', dataUrl: DATA_URL }] }],
  afterChain: [{ id: 3, text: 'Post the link' }],
  execState: 'before', execStepIdx: 1,
};
const pictureItem = {
  id: 14, sessionId: 's1', text: 'Describe this', position: 3, createdAt: 13,
  images: [{ name: 'a.png', dataUrl: DATA_URL }, { name: 'b.png', dataUrl: DATA_URL }],
};
const automation = {
  paused: true, autoSend: false, autoEnter: true, idleGuard: false, skipWhenPrompting: true, autoResume: true,
  resumeMaxRetries: 5, resumePrompt: 'continue where you stopped', loopExcludeWindows: [{ id: 2, startHHMM: '01:00', endHHMM: '02:00' }],
};

const s1 = makeSession('s1', { title: 'Fix login' });
const s2 = makeSession('s2', { title: 'Docs' });
const outside = makeSession('out-1', { projectPath: '/b/other', title: 'TOP SECRET' });
const rooms = [makeRoom('r1', ['s1', 's2']), makeRoom('r2', ['out-1'])];
const record = (sessionId: string, items: unknown[] | null, auto: unknown = null, updatedAt = 5_000) => ({ sessionId, items, automation: auto, updatedAt });

interface ItemData {
  id: number | null; position: number; type: string; disabled: boolean; text: string; textTruncated: boolean; images: number; createdAt: number | null;
  intervalMs: number | null; runAt: number | null; nextFireAt: number | null; lastFiredAt: number | null; totalFires: number | null;
  firstFireOfDay: string | null; excludeWindows: Array<{ start: string; end: string }>; execState: string | null; execStepIdx: number | null;
  beforeCount: number; afterCount: number;
  beforeSteps: Array<{ id: number | null; text: string; textTruncated: boolean; images: number }>;
  afterSteps: Array<{ id: number | null; text: string; textTruncated: boolean; images: number }>;
}
interface QueueData {
  id: string; shortId: string; known: boolean; updatedAt: number; count: number; enabled: number; shown: number; omitted: number;
  automation: null | {
    paused: boolean; autoSend: boolean; autoEnter: boolean; idleGuard: boolean; skipWhenPrompting: boolean; autoResume: boolean;
    resumeMaxRetries: number; resumePrompt: string | null; loopExcludeWindows: Array<{ start: string; end: string }>;
  };
  items: ItemData[];
}

describe('queue_get', () => {
  const routes = { 'GET /sessions/s1/queue': ok(record('s1', [scheduleItem, plainItem, pictureItem, loopItem], automation)) };
  const asking = () => makeCtx({ sessions: [s1, s2], rooms, routes });

  it('calls GET /sessions/<id>/queue, with the full id when it was given as the start of one', async () => {
    const long = makeSession('abcdef123456');
    const { ctx, client } = makeCtx({ sessions: [long], routes: { 'GET /sessions/abcdef123456/queue': ok(record('abcdef123456', [])) } });

    await run('queue_get', { id: 'abcdef' }, ctx);

    expect(client.calls).toEqual([{ method: 'GET', path: '/sessions/abcdef123456/queue' }]);
  });

  it('lists the items by position with their id, type, paused flag and schedule fields', async () => {
    const { ctx } = asking();

    const data = await dataOf<QueueData>('queue_get', { id: 's1' }, ctx);

    expect(data).toMatchObject({ id: 's1', shortId: 's1', known: true, updatedAt: 5_000, count: 4, enabled: 3, shown: 4, omitted: 0 });
    expect(data.items.map((i) => [i.id, i.position, i.type, i.disabled])).toEqual([
      [11, 0, 'once', false],
      [12, 1, 'loop', true],
      [13, 2, 'schedule', false],
      [14, 3, 'once', false],
    ]);
    const loop = data.items[1];
    expect(loop).toMatchObject({
      intervalMs: 300_000, nextFireAt: 5_000, lastFiredAt: 4_000, totalFires: 3, firstFireOfDay: '07:30', createdAt: 11,
      excludeWindows: [{ start: '22:00', end: '06:00' }],
    });
    expect(data.items[2]).toMatchObject({ runAt: 1_700_000_100_000, execState: 'before', execStepIdx: 1 });
    expect(data.items[0]).toMatchObject({ intervalMs: null, runAt: null, nextFireAt: null, execState: null, firstFireOfDay: null, excludeWindows: [] });
  });

  it('names each item’s id and timing in the text too, for a central that reads only the text', async () => {
    const { ctx } = asking();

    const { summary } = await run('queue_get', { id: 's1' }, ctx);

    expect(summary).toContain('0. once · id 11 · "Run the tests"');
    expect(summary).toMatch(/1\. loop \(paused\) every 5m · id 12/);
    expect(summary).toMatch(/2\. schedule at 2023-11-14T22:15:00\.000Z · id 13/);
    expect(summary).toMatch(/steps: 2 before, 1 after/);
  });

  it('lists the chain steps of an item, counted and in order, each with its images counted', async () => {
    const { ctx } = asking();

    const { items } = await dataOf<QueueData>('queue_get', { id: 's1' }, ctx);

    const deploy = items[2];
    expect(deploy.beforeCount).toBe(2);
    expect(deploy.afterCount).toBe(1);
    expect(deploy.beforeSteps.map((s) => [s.id, s.images])).toEqual([[1, 0], [2, 1]]);
    expect(deploy.afterSteps.map((s) => s.id)).toEqual([3]);
    expect(items[0].beforeCount + items[0].afterCount).toBe(0);
  });

  it('fences every body in the data: the item text, each chain step and the resume prompt', async () => {
    const { ctx } = asking();

    const data = await dataOf<QueueData>('queue_get', { id: 's1' }, ctx);

    for (const item of data.items) expectFenced(item.text, 'queue-item', 'session:s1');
    expect(data.items[2].beforeSteps.map((s) => s.text).every((t) => t.startsWith('<untrusted source="session:s1" kind="queue-step">'))).toBe(true);
    for (const step of [...data.items[2].beforeSteps, ...data.items[2].afterSteps]) expectFenced(step.text, 'queue-step', 'session:s1');
    expectFenced(data.automation?.resumePrompt, 'queue-resume-prompt', 'session:s1');
  });

  it('lists 25 steps of a chain at most (5 in queue_list_all) and counts them all', async () => {
    const long = {
      ...plainItem,
      beforeChain: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, text: `before ${i}` })),
      afterChain: Array.from({ length: 3 }, (_, i) => ({ id: i + 100, text: `after ${i}` })),
    };
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /sessions/s1/queue': ok(record('s1', [long])), 'GET /queues': ok({ queues: [record('s1', [long])] }) } });

    const { items } = await dataOf<QueueData>('queue_get', { id: 's1' }, ctx);
    const { queues } = await dataOf<{ queues: QueueData[] }>('queue_list_all', {}, ctx);

    expect(items[0]).toMatchObject({ beforeCount: 30, afterCount: 3 });
    expect(items[0].beforeSteps).toHaveLength(25);
    expect(items[0].afterSteps).toHaveLength(3);
    expect(queues[0].items[0]).toMatchObject({ beforeCount: 30, afterCount: 3 });
    expect(queues[0].items[0].beforeSteps).toHaveLength(5);
  });

  it('never sends an image, only how many there are', async () => {
    const { ctx } = asking();

    const result = await run('queue_get', { id: 's1' }, ctx);
    const data = result.data as QueueData;

    expect(everything(result)).not.toContain('data:image');
    expect(everything(result)).not.toContain('iVBORw0KGgo');
    expect(data.items[3].images).toBe(2);
    expect(data.items[2].beforeSteps[1].images).toBe(1);
    expect(result.summary).toMatch(/2 images/);
  });

  // Ruling 52: this pinned the old reading, which showed a switch the record lacks as ON (the dashboard's default). The
  // window reads it as off, so that is what queue_get says.
  it('reports the automation flags as they are stored, and a switch the record lacks as off, the way the window reads it', async () => {
    const { ctx } = asking();

    const data = await dataOf<QueueData>('queue_get', { id: 's1' }, ctx);

    expect(data.automation).toMatchObject({
      paused: true, autoSend: false, autoEnter: true, idleGuard: false, skipWhenPrompting: true, autoResume: true,
      resumeMaxRetries: 5, loopExcludeWindows: [{ start: '01:00', end: '02:00' }],
    });

    const sparse = makeCtx({ sessions: [s1], routes: { 'GET /sessions/s1/queue': ok(record('s1', [plainItem], { paused: false })) } });
    const lacking = await run('queue_get', { id: 's1' }, sparse.ctx);
    expect((lacking.data as QueueData).automation).toMatchObject({
      paused: false, autoSend: false, autoEnter: false, idleGuard: false, skipWhenPrompting: false, autoResume: false, resumeMaxRetries: 3, resumePrompt: null, loopExcludeWindows: [],
    });
    expect(lacking.summary).toContain('auto-send off, auto-enter off, idle guard off, skip while prompting off, auto-resume off');
  });

  it('says when no automation is stored that the window keeps its own, and a central cannot change it yet', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /sessions/s1/queue': ok(record('s1', [plainItem], null)) } });

    const result = await run('queue_get', { id: 's1' }, ctx);

    expect((result.data as QueueData).automation).toBeNull();
    expect(result.summary).toContain('No automation settings are stored yet: the AASC window uses its own');
    expect(result.summary).toContain('until a person changes one queue switch in AASC');
    expect(result.summary).not.toMatch(/defaults apply/);
  });

  it('says so when the server holds no queue for the session yet, which is not an empty queue', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /sessions/s1/queue': ok({ sessionId: 's1', items: null, automation: null, updatedAt: 0 }) } });

    const result = await run('queue_get', { id: 's1' }, ctx);

    expect(result.data).toMatchObject({ known: false, count: 0, enabled: 0, items: [], automation: null });
    expect(result.summary).toMatch(/no queue/i);
  });

  it('says an empty queue is empty', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /sessions/s1/queue': ok(record('s1', [], automation)) } });

    const result = await run('queue_get', { id: 's1' }, ctx);

    expect(result.data).toMatchObject({ known: true, count: 0, items: [] });
    expect(result.summary).toMatch(/0 queued prompts/);
  });

  it('keeps hostile text inside its fence in the data and in the text, which holds one block', async () => {
    const evil = { ...plainItem, text: HOSTILE, beforeChain: [{ id: 1, text: HOSTILE }] };
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /sessions/s1/queue': ok(record('s1', [evil], { ...automation, resumePrompt: HOSTILE })) } });

    const result = await run('queue_get', { id: 's1' }, ctx);
    const data = result.data as QueueData;

    expect(data.items[0].text).toContain('<\\/untrusted');
    expectFenced(data.items[0].text, 'queue-item');
    expectFenced(data.items[0].beforeSteps[0].text, 'queue-step');
    expectFenced(data.automation?.resumePrompt, 'queue-resume-prompt');
    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  it('cuts a long body in the data and the text, and says it was cut', async () => {
    const long = { ...plainItem, text: 'x'.repeat(10_000), beforeChain: [{ id: 1, text: 'y'.repeat(5_000) }] };
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /sessions/s1/queue': ok(record('s1', [long])) } });

    const result = await run('queue_get', { id: 's1' }, ctx);
    const item = (result.data as QueueData).items[0];

    expect(item.textTruncated).toBe(true);
    expect(item.text.length).toBeLessThan(4_200);
    expect(item.beforeSteps[0].textTruncated).toBe(true);
    expect(item.beforeSteps[0].text.length).toBeLessThan(1_200);
    expect(result.summary.length).toBeLessThan(6_500);
  });

  it('lists at most 100 items and counts the rest', async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ id: i + 1, sessionId: 's1', text: `item ${i}`, position: i, createdAt: i }));
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /sessions/s1/queue': ok(record('s1', many)) } });

    const result = await run('queue_get', { id: 's1' }, ctx);
    const data = result.data as QueueData;

    expect(data).toMatchObject({ count: 130, shown: 100, omitted: 30 });
    expect(data.items).toHaveLength(100);
    expect(data.items[99].position).toBe(99);
    expect(result.summary).toMatch(/30 more/);
  });

  it('reads a queue the server stored as it was sent, whatever its shape: junk is skipped, an unknown type is once', async () => {
    const odd = [null, 'text', 7, { text: 'no id', position: 'first' }, { id: 5, text: 42, position: 2, type: 'weekly', execState: 'sideways', firstFireOfDay: 'noon', excludeWindows: [{ startHHMM: '25:00', endHHMM: '06:00' }, 'x'], beforeChain: ['bad', { id: 'x', text: 'ok' }] }];
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /sessions/s1/queue': ok(record('s1', odd)) } });

    const { items } = await dataOf<QueueData>('queue_get', { id: 's1' }, ctx);

    expect(items).toHaveLength(2);
    const bad = items.find((i) => i.id === 5);
    expect(bad).toMatchObject({ type: 'once', execState: null, firstFireOfDay: null, excludeWindows: [], beforeCount: 1 });
    expect(bad?.beforeSteps[0]).toMatchObject({ id: null });
    expect(items.find((i) => i.id === null)?.position).toBe(0);
  });

  it('refuses a session out of scope without calling a route, and an unknown one as not found', async () => {
    const { ctx, client } = makeCtx({ central: makeCentral('room', 'r1'), sessions: [s1, outside], rooms, routes });

    const refused = await runRefused('queue_get', { id: 'out-1' }, ctx);
    const unknown = await runRefused('queue_get', { id: 'nobody-here' }, ctx);

    expect(refused.code).toBe('NOT_IN_SCOPE');
    expect(`${refused.message} ${refused.hint}`).not.toMatch(/TOP SECRET|out-1/);
    expect(unknown.code).toBe('NOT_FOUND');
    expect(client.calls).toEqual([]);
  });

  it('turns a failed route into the refusal its status asks for, never repeating the argument', async () => {
    const needle = 'abcdef-needle';
    const { ctx } = makeCtx({ sessions: [makeSession(needle)], routes: { [`GET /sessions/${needle}/queue`]: fail(503, 'down') } });

    const err = await runRefused('queue_get', { id: needle }, ctx);

    expect(err.code).toBe('UNAVAILABLE');
    expect(`${err.message} ${err.hint}`).not.toContain(needle);
  });

  it('changes nothing it reads', async () => {
    const frozen = deepFreeze(record('s1', [scheduleItem, plainItem], automation));
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /sessions/s1/queue': ok(JSON.parse(JSON.stringify(frozen))) } });

    await expect(run('queue_get', { id: 's1' }, ctx)).resolves.toBeDefined();
  });
});

describe('queue_list_all', () => {
  const allRoutes = {
    'GET /queues': ok({
      queues: [
        record('s1', [plainItem, scheduleItem], automation, 7_000),
        record('s2', [], null, 6_000),
        record('out-1', [{ id: 99, sessionId: 'out-1', text: 'TOP SECRET plan', position: 0, createdAt: 1 }], null, 8_000),
        record('gone', [{ id: 98, sessionId: 'gone', text: 'for a session nobody has', position: 0, createdAt: 1 }]),
      ],
    }),
  };

  it('calls GET /queues', async () => {
    const { ctx, client } = makeCtx({ sessions: [s1], routes: allRoutes });

    await run('queue_list_all', {}, ctx);

    expect(client.calls).toEqual([{ method: 'GET', path: '/queues' }]);
  });

  it('queue_list_all drops out-of-scope sessions: their queues are in no field and no word', async () => {
    const { ctx } = makeCtx({ central: makeCentral('room', 'r1'), sessions: [s1, s2, outside], rooms, routes: allRoutes });

    const result = await run('queue_list_all', {}, ctx);
    const data = result.data as { count: number; items: number; empty: number; queues: Array<{ id: string }> };

    expect(data.queues.map((q) => q.id)).toEqual(['s1']);
    expect(data).toMatchObject({ count: 1, items: 2, empty: 1 });
    expect(everything(result)).not.toMatch(/TOP SECRET|out-1|gone|nobody has/);
  });

  it('gives a global central every queue of a session the store knows, and none of a session nobody has', async () => {
    const { ctx } = makeCtx({ sessions: [s1, s2, outside], rooms, routes: allRoutes });

    const { queues } = await dataOf<{ queues: Array<{ id: string }> }>('queue_list_all', {}, ctx);

    expect(queues.map((q) => q.id).sort()).toEqual(['out-1', 's1']);
  });

  it('describes each queue like queue_get does, with the session’s title fenced and the status plain', async () => {
    const { ctx } = makeCtx({ sessions: [{ ...s1, status: 'working' }], routes: allRoutes });

    const { queues } = await dataOf<{ queues: Array<QueueData & { title: string; status: string }> }>('queue_list_all', {}, ctx);

    expect(queues[0]).toMatchObject({ id: 's1', shortId: 's1', status: 'working', known: true, updatedAt: 7_000, count: 2, enabled: 2 });
    expectFenced(queues[0].title, 'title', 'session:s1');
    expect(queues[0].automation).toMatchObject({ paused: true, autoSend: false });
    expect(queues[0].items.map((i) => i.type)).toEqual(['once', 'schedule']);
    expectFenced(queues[0].items[0].text, 'queue-item', 'session:s1');
    expect(queues[0].items[1].beforeSteps).toHaveLength(2);
  });

  it('shows 10 items of a queue, with texts cut shorter than queue_get cuts them, and counts the rest', async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, sessionId: 's1', text: 'z'.repeat(1_000), position: i, createdAt: i }));
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /queues': ok({ queues: [record('s1', many)] }) } });

    const { queues } = await dataOf<{ queues: QueueData[] }>('queue_list_all', {}, ctx);

    expect(queues[0]).toMatchObject({ count: 14, shown: 10, omitted: 4 });
    expect(queues[0].items[0].textTruncated).toBe(true);
    expect(queues[0].items[0].text.length).toBeLessThan(500);
  });

  it('puts the rows of every queue in one block, hostile text only inside it', async () => {
    const evil = { ...plainItem, text: HOSTILE };
    const { ctx } = makeCtx({ sessions: [{ ...s1, title: HOSTILE }], routes: { 'GET /queues': ok({ queues: [record('s1', [evil])] }) } });

    const result = await run('queue_list_all', {}, ctx);

    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
    expect(result.summary).toMatch(/1 session has queued prompts/);
  });

  it('says so when nothing is queued', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /queues': ok({ queues: [] }) } });

    const result = await run('queue_list_all', {}, ctx);

    expect(result.data).toMatchObject({ count: 0, items: 0, queues: [] });
    expect(result.summary).toMatch(/No prompts are queued/);
  });

  it('never repeats an image, and changes nothing it reads', async () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify({ queues: [record('s1', [pictureItem, scheduleItem])] })));
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /queues': ok(frozen) } });

    const result = await run('queue_list_all', {}, ctx);

    expect(everything(result)).not.toContain('data:image');
  });
});

describe('queue_sent', () => {
  const sentRoute = {
    'GET /sessions/s1/queue/sent': ok({
      success: true,
      sent: [
        { text: 'first prompt', sentAt: 1_000 },
        { text: 'second prompt', sentAt: 2_000 },
        { text: 'third prompt', sentAt: 3_000 },
      ],
    }),
  };

  it('calls GET /sessions/<id>/queue/sent', async () => {
    const { ctx, client } = makeCtx({ sessions: [s1], routes: sentRoute });

    await run('queue_sent', { id: 's1' }, ctx);

    expect(client.calls).toEqual([{ method: 'GET', path: '/sessions/s1/queue/sent' }]);
  });

  it('lists what the queue sent, newest first, each text fenced and each time plain', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: sentRoute });

    const data = await dataOf<{ id: string; shortId: string; count: number; shown: number; sent: Array<{ text: string; sentAt: number }> }>('queue_sent', { id: 's1' }, ctx);

    expect(data).toMatchObject({ id: 's1', shortId: 's1', count: 3, shown: 3 });
    expect(data.sent.map((s) => s.sentAt)).toEqual([3_000, 2_000, 1_000]);
    for (const entry of data.sent) expectFenced(entry.text, 'queue-sent', 'session:s1');
    expect(data.sent[0].text).toContain('third prompt');
  });

  it('shows the newest 50 by default and as many as asked up to the route’s 300, counting the rest', async () => {
    const sent = Array.from({ length: 120 }, (_, i) => ({ text: `p${i}`, sentAt: i + 1 }));
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /sessions/s1/queue/sent': ok({ success: true, sent }) } });

    const byDefault = await dataOf<{ count: number; shown: number; sent: Array<{ sentAt: number }> }>('queue_sent', { id: 's1' }, ctx);
    const some = await dataOf<{ shown: number }>('queue_sent', { id: 's1', limit: 5 }, ctx);

    expect(byDefault).toMatchObject({ count: 120, shown: 50 });
    expect(byDefault.sent[0].sentAt).toBe(120);
    expect(some.shown).toBe(5);
    await expect(run('queue_sent', { id: 's1', limit: 301 }, ctx)).rejects.toThrow(/limit/);
  });

  it('keeps hostile text inside one fence in the data, and in one block in the text', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /sessions/s1/queue/sent': ok({ success: true, sent: [{ text: HOSTILE, sentAt: 1 }] }) } });

    const result = await run('queue_sent', { id: 's1' }, ctx);

    expectFenced((result.data as { sent: Array<{ text: string }> }).sent[0].text, 'queue-sent');
    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  it('says so when nothing was sent', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /sessions/s1/queue/sent': ok({ success: true, sent: [] }) } });

    const result = await run('queue_sent', { id: 's1' }, ctx);

    expect(result.data).toMatchObject({ count: 0, shown: 0, sent: [] });
    expect(result.summary).toMatch(/has not sent/i);
  });

  it('refuses a session out of scope without calling a route', async () => {
    const { ctx, client } = makeCtx({ central: makeCentral('room', 'r1'), sessions: [s1, outside], rooms, routes: sentRoute });

    const err = await runRefused('queue_sent', { id: 'out-1' }, ctx);

    expect(err.code).toBe('NOT_IN_SCOPE');
    expect(client.calls).toEqual([]);
  });
});
