// remoteComputerBadges.test.ts — the devices switcher's row badges (Nov 27 2026): state, connection and counts as
// pills, and the one reason a pill can't say.
import { describe, it, expect } from 'vitest';
import { rowBadges, sessionBadges } from './remoteComputerBadges';
import type { RemoteComputer, RemoteComputerCheck } from '@/types/electron';

function record(over: Partial<RemoteComputer> = {}): RemoteComputer {
  return {
    id: 'r1', name: 'Mac mini', lan: '192.168.4.30', tailnet: null, port: 3333, status: 'active', confirmCode: null,
    addedAt: 0, lastSeenAt: null, origin: 'account', backendDeviceId: 'd-mini', ...over,
  };
}

const check = (over: Partial<RemoteComputerCheck> = {}): RemoteComputerCheck =>
  ({ state: 'online', via: 'tailnet', sharedSessions: 4, needsYou: 1, message: null, ...over });

const labels = (b: ReturnType<typeof rowBadges>) => b.badges.map((x) => `${x.tone}:${x.label}`);

describe('rowBadges', () => {
  it('an online computer: state, connection, shared sessions and how many need you', () => {
    const b = rowBadges(record(), check());
    expect(labels(b)).toEqual(['online:Online', 'neutral:Tailscale', 'neutral:4 shared', 'warn:1 needs you']);
    expect(b.reason).toBeNull();
  });

  it('names each connection, and marks the unencrypted one', () => {
    expect(labels(rowBadges(record(), check({ via: 'lan' })))[1]).toBe('neutral:Home network');
    expect(labels(rowBadges(record(), check({ via: 'https' })))[1]).toBe('neutral:Secure HTTPS');
    expect(labels(rowBadges(record(), check({ via: 'public' })))[1]).toBe('warn:Public IP, unencrypted');
    expect(labels(rowBadges(record(), check({ via: null })))).not.toContain('neutral:Tailscale');
  });

  it('shows 0 shared, a real answer, but never “0 need you”', () => {
    expect(labels(rowBadges(record(), check({ sharedSessions: 0, needsYou: 0 })))).toEqual(['online:Online', 'neutral:Tailscale', 'neutral:0 shared']);
    expect(labels(rowBadges(record(), check({ needsYou: 3 })))).toContain('warn:3 need you');
  });

  it('offline: one pill, and the reason as words beside it', () => {
    const b = rowBadges(record(), check({ state: 'offline', via: null, sharedSessions: null, needsYou: null, message: 'no address answered' }));
    expect(labels(b)).toEqual(['offline:Offline']);
    expect(b.reason).toBe('No address answered');
  });

  it('an account row drops the offline reason when the check itself was refused (it shows as the alert)', () => {
    const b = rowBadges(record(), check({ state: 'offline', message: 'refused' }), { checkFailed: true });
    expect(b.reason).toBeNull();
  });

  it('waiting for Allow carries its code', () => {
    const b = rowBadges(record({ status: 'pending', confirmCode: '482913' }), undefined);
    expect(labels(b)).toEqual(['pending:Waiting for Allow']);
    expect(b.reason).toMatch(/^Code 482\s913$/);
  });

  it('removed: red for a link row, grey for an account row (it can be connected again)', () => {
    expect(labels(rowBadges(record({ origin: 'link', status: 'revoked' }), undefined))).toEqual(['removed:Removed on that computer']);
    expect(labels(rowBadges(record({ status: 'revoked' }), undefined, { account: true }))).toEqual(['offline:Removed on that computer']);
  });

  it('not checked yet, and connecting', () => {
    expect(labels(rowBadges(record(), undefined))).toEqual(['checking:Checking…']);
    expect(labels(rowBadges(record(), check(), { connecting: true }))).toEqual(['checking:Connecting…']);
  });
});

describe('sessionBadges', () => {
  it('this computer: its sessions and how many need you; nothing with none', () => {
    expect(sessionBadges(12, 2).map((x) => x.label)).toEqual(['12 sessions', '2 need you']);
    expect(sessionBadges(1, 0).map((x) => x.label)).toEqual(['1 session']);
    expect(sessionBadges(0, 0)).toEqual([]);
  });
});
