// remoteComputerRows.test.ts — which rows the devices switcher draws for the account's computers, and their words.
import { describe, it, expect } from 'vitest';
import {
  accountRowDetail, accountRows, countOnline, linkRecords, matchesName, needsConnect, rowDetail, rowState, searchShown, sessionsLine,
  withRecord,
} from './remoteComputerRows';
import type { AccountMachine, RemoteComputer, RemoteComputerCheck } from '@/types/electron';

function record(over: Partial<RemoteComputer>): RemoteComputer {
  return {
    id: 'r1', name: 'Mac mini', lan: '192.168.4.30', tailnet: null, port: 3333, status: 'active', confirmCode: null,
    addedAt: 0, lastSeenAt: null, origin: 'account', backendDeviceId: 'd-mini', ...over,
  };
}

function machine(over: Partial<AccountMachine>): AccountMachine {
  return {
    deviceId: 'd-mini', name: 'Mac mini', platform: 'macos', edition: 'full', appVersion: '2.11.0', lastUsedAt: null,
    current: false, connectable: true, relation: 'self', addresses: null, record: null, ...over,
  };
}

const check = (over: Partial<RemoteComputerCheck>): RemoteComputerCheck =>
  ({ state: 'online', via: 'tailnet', sharedSessions: 4, message: null, ...over });

describe('accountRows', () => {
  it('lists the account’s other computers in the directory’s order, never this one', () => {
    const rows = accountRows(
      [machine({ deviceId: 'd-here', name: 'MacBook Pro', current: true }), machine({}), machine({ deviceId: 'd-vps', name: 'VPS' })],
      [],
    );
    expect(rows.map((r) => [r.key, r.name, r.machineId, r.record])).toEqual([
      ['d-mini', 'Mac mini', 'd-mini', null],
      ['d-vps', 'VPS', 'd-vps', null],
    ]);
  });

  it('joins a machine with this computer’s record for it, taken from the list once the list is read', () => {
    const stale = record({ id: 'old', status: 'pending' });
    const fresh = record({ id: 'new' });
    expect(accountRows([machine({ record: stale })], [fresh])[0].record).toBe(fresh);
    // Removed here a moment ago: the directory still names the record until it is read again.
    expect(accountRows([machine({ record: stale })], [])[0].record).toBeNull();
    // Before the list is read, the directory's own copy is all there is.
    expect(accountRows([machine({ record: stale })], null)[0].record).toBe(stale);
  });

  it('shows the name given here once a record exists', () => {
    expect(accountRows([machine({})], [record({ name: 'Office mini' })])[0].name).toBe('Office mini');
  });

  it('never matches a record paired by link, even one with the machine’s name', () => {
    const rows = accountRows([machine({})], [record({ origin: 'link', backendDeviceId: undefined })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].record).toBeNull();
  });

  it('leaves out a machine that is not one of the account’s own (a later release lists those)', () => {
    expect(accountRows([machine({ relation: 'other' })], [])).toEqual([]);
  });

  it('keeps an account record whose machine the directory does not list, after the listed ones', () => {
    const orphan = record({ id: 'r9', name: 'Old iMac', backendDeviceId: 'd-gone' });
    const rows = accountRows([machine({})], [orphan]);
    expect(rows.map((r) => [r.key, r.name, r.machineId])).toEqual([['d-mini', 'Mac mini', 'd-mini'], ['d-gone', 'Old iMac', 'd-gone']]);
    expect(rows[1].record).toBe(orphan);
  });

  // The key is React's: a key that changed when the directory landed remounted the row, which closed its ⋯ menu,
  // lost a rename being typed and dropped focus, on every opening of the panel.
  it('gives one computer one key whatever the directory says', () => {
    const mini = record({});
    const keys = [
      accountRows(null, [mini]),
      accountRows([machine({})], [mini]),
      accountRows([machine({})], null),
      accountRows([machine({ deviceId: 'd-other', name: 'Other' })], [mini]),
    ].map((rows) => rows.find((r) => r.name === 'Mac mini')?.key);
    expect(keys).toEqual(['d-mini', 'd-mini', 'd-mini', 'd-mini']);
    // A record that names no machine has only its own id.
    expect(accountRows(null, [record({ id: 'r7', backendDeviceId: undefined })])[0].key).toBe('r7');
  });

  it('never gives two rows one key, even with two records for one machine', () => {
    const rows = accountRows([machine({})], [record({ id: 'a' }), record({ id: 'b' })]);
    expect(rows.map((r) => r.key)).toEqual(['d-mini', 'b']);
    expect(accountRows(null, [record({ id: 'a' }), record({ id: 'b' })]).map((r) => r.key)).toEqual(['d-mini', 'b']);
  });

  it('says whether the machine can take a connection through the account', () => {
    const rows = accountRows([machine({ connectable: false }), machine({ deviceId: 'd-vps', name: 'VPS' })], [record({ id: 'r9', backendDeviceId: 'd-gone' })]);
    expect(rows.map((r) => [r.key, r.connectable])).toEqual([['d-mini', false], ['d-vps', true], ['d-gone', true]]);
  });

  it('with no directory, lists the account records themselves', () => {
    const rows = accountRows(null, [record({}), record({ id: 'l1', origin: 'link' }), record({ id: 'l2', origin: undefined })]);
    expect(rows.map((r) => r.key)).toEqual(['d-mini']);
    expect(rows.map((r) => r.record?.id)).toEqual(['r1']);
    expect(accountRows(null, null)).toEqual([]);
  });
});

describe('linkRecords', () => {
  it('is every record not made through the account: a record from before plan 18 reads as link', () => {
    const list = [record({ id: 'a' }), record({ id: 'b', origin: 'link' }), record({ id: 'c', origin: undefined })];
    expect(linkRecords(list).map((c) => c.id)).toEqual(['b', 'c']);
    expect(linkRecords(null)).toEqual([]);
  });
});

describe('accountRowDetail', () => {
  it.each([
    ['online on Tailscale', record({}), check({}), 'Online · Tailscale · 4 shared'],
    ['online at home', record({}), check({ via: 'lan', sharedSessions: 1 }), 'Online · Home network · 1 shared'],
    ['online over a public address', record({}), check({ via: 'public', sharedSessions: 0 }), 'Online · Public IP, unencrypted · 0 shared'],
    // The code is formatted as the link rows format it, and held together with no-break spaces so it never wraps.
    ['waiting for Allow', record({ status: 'pending', confirmCode: '482913' }), check({ state: 'pending', via: null, sharedSessions: null }), 'Waiting for Allow on Mac mini · code\u00a0482\u00a0913'],
    ['waiting, before any check', record({ status: 'pending', confirmCode: '482913' }), undefined, 'Waiting for Allow on Mac mini · code\u00a0482\u00a0913'],
    ['waiting with no code', record({ status: 'pending' }), undefined, 'Waiting for Allow on Mac mini'],
    ['offline', record({}), check({ state: 'offline', via: null, sharedSessions: null }), 'Offline'],
    ['offline with a reason', record({}), check({ state: 'offline', via: null, sharedSessions: null, message: 'Something else answered at Mac mini’s address.' }), 'Offline: Something else answered at Mac mini’s address.'],
    // Removed there: the link rows' own words, so Connect in Open's place has a reason beside it.
    ['revoked by the check', record({}), check({ state: 'revoked', via: 'lan', sharedSessions: null }), 'Removed on that computer'],
    ['revoked with a reason', record({}), check({ state: 'revoked', via: 'lan', sharedSessions: null, message: 'Mac mini removed this computer.' }), 'Removed on that computer'],
    ['a stored revoked record', record({ status: 'revoked' }), undefined, 'Removed on that computer'],
    ['an answer that proved nothing', record({}), check({ state: 'offline', via: null, sharedSessions: null, message: 'Something else answered at Mac mini’s address.', unproved: true }), 'Offline: Something else answered at Mac mini’s address.'],
    ['not checked yet', record({}), undefined, 'Checking…'],
  ])('%s', (_label, c, latest, words) => {
    expect(accountRowDetail(c, latest, false)).toBe(words);
  });

  it('leaves the reason to the alert under the row when the check itself failed', () => {
    const failed = check({ state: 'offline', via: null, sharedSessions: null, message: 'Too many tries. Wait a minute.' });
    expect(accountRowDetail(record({}), failed, true)).toBe('Offline');
  });
});

describe('needsConnect', () => {
  const unproved = check({ state: 'offline', via: null, sharedSessions: null, message: 'Something else answered at Mac mini’s address.', unproved: true });

  it.each([
    ['removed on that computer (stored)', record({ status: 'revoked' }), undefined, true],
    ['removed on that computer (the check says so)', record({}), check({ state: 'revoked', via: 'lan', sharedSessions: null }), true],
    ['something answered and proved nothing', record({}), unproved, true],
    ['plain offline: nothing answered', record({}), check({ state: 'offline', via: null, sharedSessions: null, message: 'No answer.' }), false],
    ['online', record({}), check({}), false],
    ['waiting for Allow', record({ status: 'pending' }), check({ state: 'pending', via: null, sharedSessions: null }), false],
    ['not checked yet', record({}), undefined, false],
  ])('%s', (_label, c, latest, expected) => {
    expect(needsConnect(c, latest)).toBe(expected);
  });

  it('is never true for a computer paired by link, whatever its check carries', () => {
    const link = record({ origin: 'link', backendDeviceId: undefined });
    expect(needsConnect(link, unproved)).toBe(false);
    expect(needsConnect({ ...link, status: 'revoked' }, undefined)).toBe(false);
    expect(needsConnect(record({ origin: undefined }), unproved)).toBe(false);
  });
});

describe('rowState and rowDetail (computers paired by link, unchanged)', () => {
  it('reads the stored status until a check answers, and removed for good', () => {
    expect(rowState(record({}), undefined)).toBe('checking');
    expect(rowState(record({ status: 'pending' }), undefined)).toBe('pending');
    expect(rowState(record({ status: 'revoked' }), check({}))).toBe('revoked');
    expect(rowDetail(record({ status: 'revoked' }), check({}))).toBe('Removed on that computer');
    expect(rowDetail(record({ status: 'pending', confirmCode: '123456' }), undefined)).toBe('Waiting for Allow · code 123 456');
    expect(rowDetail(record({}), check({ via: 'https', sharedSessions: 1 }))).toBe('Online · Secure HTTPS · 1 shared');
  });
});

describe('countOnline', () => {
  it('counts the rows whose latest check is online', () => {
    const rows = accountRows(
      [machine({}), machine({ deviceId: 'd-vps', name: 'VPS' }), machine({ deviceId: 'd-imac', name: 'Studio iMac' })],
      [record({ id: 'a' }), record({ id: 'b', backendDeviceId: 'd-vps' })],
    );
    expect(countOnline(rows, { a: check({}), b: check({ state: 'offline', via: null }) })).toBe(1);
    expect(countOnline(rows, {})).toBe(0);
    // A record the stored status calls removed is not online, whatever its last check said.
    expect(countOnline(accountRows([machine({})], [record({ id: 'a', status: 'revoked' })]), { a: check({}) })).toBe(0);
  });
});

describe('withRecord', () => {
  it('adds a new record, and puts a machine’s new record where its old one was', () => {
    const link = record({ id: 'l1', origin: 'link', backendDeviceId: undefined });
    const old = record({ id: 'old', status: 'revoked' });
    const next = record({ id: 'new', status: 'pending' });
    expect(withRecord(null, next)).toEqual([next]);
    expect(withRecord([link], next)).toEqual([link, next]);
    expect(withRecord([old, link], next)).toEqual([next, link]);
    expect(withRecord([record({ id: 'new', status: 'pending' }), link], record({ id: 'new' }))).toEqual([record({ id: 'new' }), link]);
  });
});

describe('“needs you” on an online row (the check’s needsYou)', () => {
  // No-break spaces inside the phrase: in the narrow panel the line wraps at a " · " seam, never inside "3 need you".
  it('ends the second line with the count, worded for one and for many', () => {
    expect(rowDetail(record({ origin: 'link' }), check({ needsYou: 3 }))).toBe('Online · Tailscale · 4 shared · 3\u00a0need\u00a0you');
    expect(accountRowDetail(record({}), check({ needsYou: 1 }), false)).toBe('Online · Tailscale · 4 shared · 1\u00a0needs\u00a0you');
    expect(accountRowDetail(record({}), check({ via: 'lan', sharedSessions: 12, needsYou: 12 }), false))
      .toBe('Online · Home network · 12 shared · 12\u00a0need\u00a0you');
  });

  it('adds nothing for 0, for null and for a check from an app that sends no count', () => {
    for (const needsYou of [0, null, undefined]) {
      expect(rowDetail(record({ origin: 'link' }), check({ needsYou }))).toBe('Online · Tailscale · 4 shared');
      expect(accountRowDetail(record({}), check({ needsYou }), false)).toBe('Online · Tailscale · 4 shared');
    }
  });

  it('is said of an online row only', () => {
    const stale = { needsYou: 2 } as const;
    expect(rowDetail(record({ origin: 'link' }), check({ state: 'offline', via: null, sharedSessions: null, ...stale }))).toBe('Offline');
    expect(accountRowDetail(record({}), check({ state: 'offline', via: null, sharedSessions: null, ...stale }), false)).toBe('Offline');
    expect(accountRowDetail(record({ status: 'revoked' }), check(stale), false)).toBe('Removed on that computer');
    expect(accountRowDetail(record({ status: 'pending' }), check({ state: 'pending', ...stale }), false)).toBe('Waiting for Allow on Mac mini');
  });
});

describe('sessionsLine: this computer’s own second line', () => {
  it('counts the sessions, then those that need the person', () => {
    expect(sessionsLine(5, 2)).toBe('5 sessions · 2\u00a0need\u00a0you');
    expect(sessionsLine(3, 1)).toBe('3 sessions · 1\u00a0needs\u00a0you');
    expect(sessionsLine(1, 1)).toBe('1 session · 1\u00a0needs\u00a0you');
  });

  it('never says "0 need you", and says nothing with no sessions', () => {
    expect(sessionsLine(4, 0)).toBe('4 sessions');
    expect(sessionsLine(1, 0)).toBe('1 session');
    expect(sessionsLine(0, 0)).toBeNull();
  });
});

describe('the switcher’s search', () => {
  it('is shown with more than seven computer rows', () => {
    expect(searchShown(7)).toBe(false);
    expect(searchShown(8)).toBe(true);
    expect(searchShown(0)).toBe(false);
  });

  it('matches a name by a substring, whatever the case', () => {
    expect(matchesName('Mac mini', 'MINI')).toBe(true);
    expect(matchesName('Mac mini', 'c m')).toBe(true);
    expect(matchesName('Mac mini', 'studio')).toBe(false);
    expect(matchesName('Büro-iMac', 'büRO')).toBe(true);
  });

  it('takes the text as typed apart from spaces at its ends, and an empty one matches everything', () => {
    expect(matchesName('Mac mini', '  mini ')).toBe(true);
    expect(matchesName('Mac mini', '')).toBe(true);
    expect(matchesName('Mac mini', '   ')).toBe(true);
  });
});
