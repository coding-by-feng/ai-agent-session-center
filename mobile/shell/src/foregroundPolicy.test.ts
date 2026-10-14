// foregroundPolicy.test.ts — AASC-19: banner, toast or nothing while the app is open.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { decideForeground, TOAST_MS } from './foregroundPolicy';
import { parsePush, GENERIC_PUSH_TITLE } from './pushPayload';

function arrival(kind: string, title = 'Fix login', sessionRef = 'sess-1') {
  return parsePush({ title, body: 'Approval needed: Bash', data: { v: '1', kind, sessionRef } });
}

describe('decideForeground', () => {
  it('shows nothing when the user is on that very session', () => {
    expect(decideForeground(arrival('approval'), { serverId: 'mac-a', sessionId: 'sess-1' }, 'mac-a')).toEqual({ show: 'none', reason: 'viewing-session' });
    // Unknown Mac: the session id alone decides.
    expect(decideForeground(arrival('finished'), { serverId: 'mac-a', sessionId: 'sess-1' }, null).show).toBe('none');
  });

  it('shows a toast that opens the session when the user is elsewhere', () => {
    expect(decideForeground(arrival('approval'), { serverId: 'mac-a', sessionId: 'sess-2' }, 'mac-a')).toEqual({
      show: 'toast', title: 'Fix login', body: 'Approval needed: Bash', tone: 'attention',
      durationMs: TOAST_MS.attention, open: { sessionRef: 'sess-1', kind: 'approval' },
    });
    expect(decideForeground(arrival('finished'), { serverId: null, sessionId: null }, null)).toMatchObject({ show: 'toast', tone: 'success', durationMs: TOAST_MS.other });
    expect(decideForeground(arrival('interrupted'), { serverId: null, sessionId: null }, null)).toMatchObject({ tone: 'error' });
  });

  it('shows a toast for the same session id on another Mac', () => {
    expect(decideForeground(arrival('input'), { serverId: 'mac-b', sessionId: 'sess-1' }, 'mac-a').show).toBe('toast');
  });

  it('keeps generic mode generic in the toast', () => {
    const d = decideForeground(arrival('approval', GENERIC_PUSH_TITLE), { serverId: null, sessionId: null }, null);
    expect(d).toMatchObject({ show: 'toast', title: 'A session needs your approval', body: '' });
  });

  it('always shows a test notification, with nothing to open', () => {
    expect(decideForeground(arrival('test'), { serverId: 'mac-a', sessionId: 'sess-1' }, 'mac-a')).toMatchObject({ show: 'toast', tone: 'info', open: null });
  });

  it('ignores a malformed payload', () => {
    expect(decideForeground(null, { serverId: null, sessionId: null }, null)).toEqual({ show: 'none', reason: 'malformed' });
  });

  it('turns the foreground system banner off, so this policy decides alone', () => {
    const config = readFileSync(resolve(__dirname, '../../capacitor.config.ts'), 'utf8');
    expect(config).toMatch(/PushNotifications:\s*\{\s*presentationOptions:\s*\[\]\s*\}/);
  });
});
