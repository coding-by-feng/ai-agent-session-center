// pushPayload.test.ts — AASC-19: reading what the backend sends, and what the user reads.
import { describe, it, expect } from 'vitest';
import { parsePush, visibleText, GENERIC_PUSH_TITLE } from './pushPayload';

/** What Capacitor gives on iOS: the whole userInfo in `data`, title/body from aps.alert. */
function ios(kind: string, title: string, body: string, extra: Record<string, unknown> = {}) {
  return {
    title,
    body,
    data: {
      aps: { alert: { title, body }, sound: 'default', 'interruption-level': 'time-sensitive', 'thread-id': 'sess-1' },
      aasc: { v: 1, kind, sessionRef: 'sess-1', ...extra },
    },
  };
}

/** What Capacitor gives on Android: the FCM data map in `data`. */
function android(kind: string, title?: string, body?: string) {
  return { title, body, data: { v: '1', kind, sessionRef: 'sess-1' } };
}

describe('parsePush', () => {
  it('reads an iOS notification', () => {
    expect(parsePush(ios('approval', 'Fix login', 'Approval needed: Bash'))).toEqual({
      kind: 'approval', sessionRef: 'sess-1', title: 'Fix login', body: 'Approval needed: Bash',
      generic: false, threadId: 'sess-1', macRef: null,
    });
  });

  it('reads an Android notification, and a tray tap that carries no title', () => {
    expect(parsePush(android('finished', 'Fix login', 'Finished'))?.title).toBe('Fix login');
    const tapped = parsePush(android('input'));
    expect(tapped).toMatchObject({ kind: 'input', sessionRef: 'sess-1', title: null, body: null, generic: true });
  });

  it('falls back to aps.alert when Capacitor left title/body empty', () => {
    const n = ios('input', 'Refactor', 'Waiting for your input');
    expect(parsePush({ data: n.data })?.title).toBe('Refactor');
  });

  it('treats the backend generic title as generic and keeps no session content', () => {
    const arrival = parsePush(ios('approval', GENERIC_PUSH_TITLE, 'Approval needed'))!;
    expect(arrival.generic).toBe(true);
    expect(arrival.title).toBeNull();
    expect(arrival.body).toBeNull();
  });

  it('reads the Mac reference when a future payload carries one', () => {
    expect(parsePush(ios('approval', 'T', 'B', { mac: 'mac-1' }))?.macRef).toBe('mac-1');
    expect(parsePush(ios('approval', 'T', 'B', { mac: '../x' }))?.macRef).toBeNull();
  });

  it('cleans the text it shows', () => {
    const arrival = parsePush(ios('approval', 'Fix\u202E login\n', 'Approval needed:\u0007 Bash'))!;
    expect(arrival.title).toBe('Fix login');
    expect(arrival.body).toBe('Approval needed: Bash');
  });

  it.each([
    ['no data', { title: 'x' }],
    ['unknown kind', android('reboot', 'x', 'y')],
    ['bad session ref', { data: { v: '1', kind: 'approval', sessionRef: 'a/b' } }],
    ['missing session ref', { data: { v: '1', kind: 'approval' } }],
    ['another version', { data: { v: '2', kind: 'approval', sessionRef: 's' } }],
    ['no version', { data: { kind: 'approval', sessionRef: 's' } }],
    ['data is an array', { data: ['approval'] }],
  ])('refuses %s', (_label, n) => {
    expect(parsePush(n)).toBeNull();
  });

  it('refuses nothing at all', () => {
    expect(parsePush(null)).toBeNull();
    expect(parsePush(undefined)).toBeNull();
  });

  it('uses the session ref as the thread when aps.thread-id is missing or odd', () => {
    expect(parsePush(android('approval', 'T', 'B'))?.threadId).toBe('sess-1');
    const odd = ios('approval', 'T', 'B');
    (odd.data.aps as Record<string, unknown>)['thread-id'] = 'a b';
    expect(parsePush(odd)?.threadId).toBe('sess-1');
  });
});

describe('visibleText', () => {
  it('shows the session title and the body', () => {
    expect(visibleText(parsePush(ios('approval', 'Fix login', 'Approval needed: Bash'))!)).toEqual({ title: 'Fix login', body: 'Approval needed: Bash' });
  });

  it('uses the kind text when the body is missing', () => {
    expect(visibleText(parsePush(android('interrupted', 'Fix login'))!)).toEqual({ title: 'Fix login', body: 'Interrupted' });
  });

  it.each([
    ['approval', 'A session needs your approval'],
    ['input', 'A session is waiting for your input'],
    ['finished', 'A session finished'],
    ['interrupted', 'A session was interrupted'],
    ['test', 'Test notification from AASC'],
  ])('says something generic for %s in generic mode', (kind, text) => {
    expect(visibleText(parsePush(ios(kind, GENERIC_PUSH_TITLE, 'x'))!)).toEqual({ title: text, body: '' });
    expect(visibleText(parsePush(android(kind))!)).toEqual({ title: text, body: '' });
  });
});
