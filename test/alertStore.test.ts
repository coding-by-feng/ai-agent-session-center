// test/alertStore.test.ts — alerts centrals raise (Nov 26 2026): the pure rules (src/lib/raisedAlerts.ts) and the
// server's store (server/alerts/alertStore.ts): one alert per key while it is open, the caps, the rate limit, expiry,
// dismissal and the change events. In memory only: nothing here touches a file, a process or a socket.
import { describe, expect, it } from 'vitest';
import {
  cleanAlertMessage,
  raisedAlertLevel,
  RAISED_ALERT_MESSAGE_MAX,
  RAISED_ALERT_TTL_MS,
  RAISED_ALERTS_PER_CENTRAL,
  RAISES_PER_MINUTE,
} from '../src/lib/raisedAlerts.js';
import { createAlertStore, type AlertChange, type RaiseInput } from '../server/alerts/alertStore.js';

describe('cleanAlertMessage', () => {
  it('keeps one line of plain text', () => {
    expect(cleanAlertMessage('  Package\nstuck\t45m \u202E ')).toBe('Package stuck 45m');
    expect(cleanAlertMessage('\x00\x1b[31m')).toBe('[31m');
    expect(cleanAlertMessage('   ')).toBe('');
  });

  it('ends a message past the cap in …', () => {
    const long = 'a'.repeat(RAISED_ALERT_MESSAGE_MAX + 50);
    const clean = cleanAlertMessage(long);
    expect(clean).toHaveLength(RAISED_ALERT_MESSAGE_MAX);
    expect(clean.endsWith('…')).toBe(true);
    expect(cleanAlertMessage('a'.repeat(RAISED_ALERT_MESSAGE_MAX))).toHaveLength(RAISED_ALERT_MESSAGE_MAX);
  });
});

describe('raisedAlertLevel: the session’s own level is the ceiling', () => {
  it('takes the quieter of what was asked and the session’s level', () => {
    expect(raisedAlertLevel('loud', 'normal')).toBe('normal');
    expect(raisedAlertLevel('quiet', 'urgent')).toBe('quiet');
    expect(raisedAlertLevel('urgent', 'silent')).toBe('silent');
    expect(raisedAlertLevel('loud', 'loud')).toBe('loud');
  });

  it('is the session’s level when nothing was asked', () => {
    expect(raisedAlertLevel(undefined, 'urgent')).toBe('urgent');
    expect(raisedAlertLevel(undefined, 'silent')).toBe('silent');
  });
});

function harness(start = 1_000_000) {
  let t = start;
  let n = 0;
  const store = createAlertStore({ now: () => t, newId: () => `a${++n}` });
  const changes: AlertChange[] = [];
  store.onChange((c) => changes.push(c));
  const raise = (over: Partial<RaiseInput> = {}) =>
    store.raise({ centralId: 'c1', centralSessionId: 'cs1', sessionId: 's1', key: 'stuck:package', message: 'Package stuck 45m', ...over });
  return { store, changes, raise, tick: (ms: number) => { t += ms; }, now: () => t };
}

describe('createAlertStore', () => {
  it('raises an alert, and raising its key again while it is open updates it', () => {
    const h = harness();
    const first = h.raise({ level: 'loud' });
    expect(first).toMatchObject({ ok: true, created: true });
    h.tick(60_000);
    const again = h.raise({ message: 'Package stuck 75m', level: 'urgent' });
    expect(again).toMatchObject({ ok: true, created: false });
    expect(h.store.list()).toEqual([
      expect.objectContaining({ id: 'a1', key: 'stuck:package', message: 'Package stuck 75m', level: 'urgent', count: 2, raisedAt: 1_000_000, updatedAt: 1_060_000 }),
    ]);
    expect(h.changes.map((c) => [c.type, c.type === 'raised' ? c.created : null])).toEqual([['raised', true], ['raised', false]]);
  });

  it('keeps each central’s keys apart, and lists the newest first', () => {
    const h = harness();
    h.raise();
    h.tick(1);
    h.raise({ centralId: 'c2' });
    expect(h.store.list().map((a) => [a.id, a.centralId])).toEqual([['a2', 'c2'], ['a1', 'c1']]);
  });

  it('opens a new alert for a key after its last one was dismissed', () => {
    const h = harness();
    h.raise();
    expect(h.store.dismiss('a1')).toMatchObject({ id: 'a1' });
    expect(h.store.dismiss('a1')).toBeNull();
    expect(h.raise()).toMatchObject({ ok: true, created: true, alert: { id: 'a2', count: 1 } });
    expect(h.changes.map((c) => c.type)).toEqual(['raised', 'dismissed', 'raised']);
  });

  it('refuses a new key past the per-central cap, but still updates an open one', () => {
    const h = harness();
    for (let i = 0; i < RAISED_ALERTS_PER_CENTRAL; i += 1) expect(h.raise({ key: `k${i}` }).ok).toBe(true);
    expect(h.raise({ key: 'one-more' })).toMatchObject({ ok: false, code: 'TOO_MANY' });
    expect(h.raise({ key: 'k0' })).toMatchObject({ ok: true, created: false });
    expect(h.raise({ key: 'one-more', centralId: 'c2' }).ok).toBe(true);
  });

  it('refuses more than the minute’s raises from one central, and lets them through a minute later', () => {
    const h = harness();
    for (let i = 0; i < RAISES_PER_MINUTE; i += 1) expect(h.raise().ok).toBe(true);
    expect(h.raise()).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(h.raise({ centralId: 'c2' }).ok).toBe(true);
    h.tick(60_000);
    expect(h.raise().ok).toBe(true);
  });

  it('lets an alert nobody raised again expire, and says so', () => {
    const h = harness();
    h.raise();
    h.tick(RAISED_ALERT_TTL_MS - 1);
    expect(h.store.list()).toHaveLength(1);
    h.tick(1);
    expect(h.store.sweep()).toBe(1);
    expect(h.store.list()).toEqual([]);
    expect(h.changes.map((c) => c.type)).toEqual(['raised', 'expired']);
    expect(h.store.sweep()).toBe(0);
  });

  it('keeps an alert raised again alive past the first raise’s day', () => {
    const h = harness();
    h.raise();
    h.tick(RAISED_ALERT_TTL_MS - 10);
    h.raise();
    h.tick(20);
    h.store.sweep();
    expect(h.store.list()).toHaveLength(1);
  });

  it('hands out copies: a caller cannot change what it holds', () => {
    const h = harness();
    const result = h.raise();
    if (!result.ok) throw new Error('refused');
    result.alert.message = 'changed';
    h.store.list()[0].message = 'changed too';
    expect(h.store.get('a1')?.message).toBe('Package stuck 45m');
  });

  it('keeps a listener that throws from breaking a raise', () => {
    const h = harness();
    h.store.onChange(() => { throw new Error('boom'); });
    expect(h.raise().ok).toBe(true);
    expect(h.changes).toHaveLength(1);
  });

});
