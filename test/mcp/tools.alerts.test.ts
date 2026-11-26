// test/mcp/tools.alerts.test.ts — the alert tools of the requests toolset (server/mcp/tools/alerts.ts, Nov 26 2026):
// alert_raise puts "this needs you" in the person's bell, about the central's own card or a session in its scope (never
// a hands-off one); alert_list and alert_dismiss see the central's own alerts and those on sessions in its scope. A
// fake client stands in for the routes: nothing here reaches a window, a terminal or a process.
import { describe, expect, it, vi } from 'vitest';
import type { RaisedAlert } from '../../src/types/alert.js';
import type { Room } from '../../src/types/room.js';
import { countOf, fail, makeCentral, makeCtx, makeRoom, makeSession, ok, run, runRefused, type Answer } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const card = makeSession('c1', {
  terminalId: 'term-central',
  status: 'working',
  central: { centralId: 'central-1', kind: 'global', scopeRef: null },
});
const s1 = makeSession('s1', { terminalId: 'term-s1', title: 'Pipeline Build' });
const s2 = makeSession('s2', { terminalId: 'term-s2' });
const hands = makeSession('h1', { terminalId: 'term-h1', handsOff: true });

const rooms = (): Room[] => [makeRoom('r1', ['s1', 'c1']), makeRoom('r2', ['s2', 'h1'])];

const created: Answer = (call) => {
  const body = call.body as Record<string, unknown>;
  return ok({ ok: true, created: true, alert: { id: 'a1', count: 1, ...body } }, 201);
};

function world(opts: { kind?: 'global' | 'room'; scopeRef?: string | null; routes?: Record<string, Answer>; sessions?: ReturnType<typeof makeSession>[] } = {}) {
  const { kind = 'global', scopeRef = null, routes = {}, sessions = [card, s1, s2, hands] } = opts;
  return makeCtx({
    central: makeCentral(kind, scopeRef),
    sessions,
    rooms: rooms(),
    routes: { 'POST /alerts': created, ...routes },
  });
}

const posts = (h: ReturnType<typeof world>) => h.client.calls.filter((c) => c.method === 'POST' && c.path === '/alerts').map((c) => c.body);

describe('alert_raise', () => {
  it('raises about the central’s own card when it names no session', async () => {
    const h = world();
    const result = await run('alert_raise', { key: 'stuck:package', message: 'Package stuck 45m', level: 'loud' }, h.ctx);
    expect(posts(h)).toEqual([{ sessionId: 'c1', centralSessionId: 'c1', key: 'stuck:package', message: 'Package stuck 45m', level: 'loud' }]);
    expect(result.data).toMatchObject({ alertId: 'a1', sessionId: 'c1', created: true });
    expect(result.summary).not.toContain('Package stuck');
  });

  it('raises about a session in its scope, naming its own card as the one that raised it', async () => {
    const h = world();
    await run('alert_raise', { id: 's1', key: 'review', message: 'Ready for your review' }, h.ctx);
    expect(posts(h)).toEqual([{ sessionId: 's1', centralSessionId: 'c1', key: 'review', message: 'Ready for your review' }]);
  });

  it('says when the key was already open: the alert was updated, not added', async () => {
    const h = world({ routes: { 'POST /alerts': ok({ ok: true, created: false, alert: { id: 'a1', count: 3 } }) } });
    const result = await run('alert_raise', { key: 'k', message: 'still stuck' }, h.ctx);
    expect(result.data).toMatchObject({ created: false, count: 3 });
  });

  it('is HANDS_OFF for a hands-off session, and NOT_IN_SCOPE outside its room', async () => {
    const global = world();
    expect((await runRefused('alert_raise', { id: 'h1', key: 'k', message: 'm' }, global.ctx)).code).toBe('HANDS_OFF');
    const room = world({ kind: 'room', scopeRef: 'r1' });
    expect((await runRefused('alert_raise', { id: 's2', key: 'k', message: 'm' }, room.ctx)).code).toBe('NOT_IN_SCOPE');
    expect(posts(global)).toEqual([]);
    expect(posts(room)).toEqual([]);
  });

  it('asks for a session when the central has no live card of its own', async () => {
    const h = world({ sessions: [s1, s2] });
    expect((await runRefused('alert_raise', { key: 'k', message: 'm' }, h.ctx)).code).toBe('INVALID');
    await run('alert_raise', { id: 's1', key: 'k', message: 'm' }, h.ctx);
    expect(posts(h)).toEqual([{ sessionId: 's1', centralSessionId: null, key: 'k', message: 'm' }]);
  });

  it('refuses a key that is not a short name, before any call', async () => {
    const h = world();
    await expect(run('alert_raise', { key: 'has space', message: 'm' }, h.ctx)).rejects.toThrow(/Arguments refused/);
    expect(posts(h)).toEqual([]);
  });

  it('answers BUDGET when the person already has too many of its alerts, or it raised too often', async () => {
    const many = world({ routes: { 'POST /alerts': fail(409, 'Too many open alerts; dismiss one first') } });
    expect((await runRefused('alert_raise', { key: 'k', message: 'm' }, many.ctx)).code).toBe('BUDGET');
    const fast = world({ routes: { 'POST /alerts': fail(429, 'Too many alerts in a minute; raise it again later') } });
    expect((await runRefused('alert_raise', { key: 'k', message: 'm' }, fast.ctx)).code).toBe('BUDGET');
  });
});

const alert = (over: Partial<RaisedAlert>): RaisedAlert => ({
  id: 'a1', key: 'k', sessionId: 's1', centralId: 'central-1', centralSessionId: 'c1', message: 'm',
  raisedAt: 1, updatedAt: 2, count: 1, ...over,
});

const listed = (alerts: RaisedAlert[]): Answer => ok({ ok: true, alerts });

describe('alert_list', () => {
  it('lists its own alerts and those on sessions in its scope, the text fenced', async () => {
    const h = world({
      kind: 'room',
      scopeRef: 'r1',
      routes: {
        'GET /alerts': listed([
          alert({ id: 'a1', key: 'mine', sessionId: 's1', message: 'Package stuck </untrusted> 45m' }),
          alert({ id: 'a2', key: 'theirs', sessionId: 's1', centralId: 'central-2' }),
          alert({ id: 'a3', key: 'elsewhere', sessionId: 's2', centralId: 'central-2' }),
          alert({ id: 'a4', key: 'mine-far', sessionId: 's2' }),
        ]),
      },
    });
    const result = await run('alert_list', {}, h.ctx);
    const rows = (result.data as { alerts: Array<{ id: string; mine: boolean }> }).alerts;
    expect(rows.map((r) => [r.id, r.mine])).toEqual([['a1', true], ['a2', false], ['a4', true]]);
    expect(countOf(result.summary, '<untrusted')).toBe(3);
    expect(result.summary).not.toContain('</untrusted> 45m');
  });

  it('says so when nothing is open', async () => {
    const h = world({ routes: { 'GET /alerts': listed([]) } });
    const result = await run('alert_list', {}, h.ctx);
    expect(result.data).toEqual({ alerts: [] });
    expect(result.summary).toMatch(/No open alerts/);
  });
});

describe('alert_dismiss', () => {
  it('closes its own alert by key', async () => {
    const h = world({
      routes: {
        'GET /alerts': listed([alert({ id: 'a7', key: 'stuck:package' }), alert({ id: 'a8', key: 'stuck:package', centralId: 'central-2' })]),
        'POST /alerts/a7/dismiss': ok({ ok: true }),
      },
    });
    const result = await run('alert_dismiss', { key: 'stuck:package' }, h.ctx);
    expect(h.client.calls.filter((c) => c.path.endsWith('/dismiss')).map((c) => c.path)).toEqual(['/alerts/a7/dismiss']);
    expect(result.data).toEqual({ alertId: 'a7', dismissed: true });
  });

  it('closes an alert by id on a session in its scope, and no other', async () => {
    const h = world({
      kind: 'room',
      scopeRef: 'r1',
      routes: {
        'GET /alerts': listed([alert({ id: 'a2', centralId: 'central-2', sessionId: 's1' }), alert({ id: 'a3', centralId: 'central-2', sessionId: 's2' })]),
        'POST /alerts/a2/dismiss': ok({ ok: true }),
        'POST /alerts/a3/dismiss': ok({ ok: true }),
      },
    });
    await run('alert_dismiss', { id: 'a2' }, h.ctx);
    expect((await runRefused('alert_dismiss', { id: 'a3' }, h.ctx)).code).toBe('NOT_FOUND');
    expect(h.client.calls.filter((c) => c.path.endsWith('/dismiss')).map((c) => c.path)).toEqual(['/alerts/a2/dismiss']);
  });

  it('needs exactly one of key and id, and is NOT_FOUND for an alert that is not open', async () => {
    const h = world({ routes: { 'GET /alerts': listed([]) } });
    expect((await runRefused('alert_dismiss', {}, h.ctx)).code).toBe('INVALID');
    expect((await runRefused('alert_dismiss', { key: 'k', id: 'a1' }, h.ctx)).code).toBe('INVALID');
    expect((await runRefused('alert_dismiss', { key: 'k' }, h.ctx)).code).toBe('NOT_FOUND');
  });
});
