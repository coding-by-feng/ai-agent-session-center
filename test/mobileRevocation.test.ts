// test/mobileRevocation.test.ts — AASC-15: revoking a phone ends its sessions and live sockets at once.
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeAll } from 'vitest';

const mockConfig = vi.hoisted(() => ({ passwordHash: 'set' } as { passwordHash?: string }));
vi.mock('../server/serverConfig.js', () => ({ config: mockConfig }));
vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), default: {},
}));

import {
  createToken, validateToken, getTokenDeviceId, revokeTokensForDevice, refreshToken, requestSession,
} from '../server/authManager.js';
import type { IncomingMessage } from 'node:http';

const req = (headers: Record<string, string>) => ({ headers, url: '/api/mobile/backend-code' }) as unknown as IncomingMessage;

describe('requestSession (AASC-52: who asks for a backend code)', () => {
  it('names the paired phone behind a Bearer session, nobody for a password sign-in, null without a valid one', () => {
    const phone = createToken('phone-rs');
    const desktop = createToken();
    expect(requestSession(req({ authorization: `Bearer ${phone}` }))).toEqual({ deviceId: 'phone-rs' });
    expect(requestSession(req({ authorization: `Bearer ${desktop}` }))).toEqual({ deviceId: null });
    expect(requestSession(req({ authorization: 'Bearer not-a-token' }))).toBeNull();
    expect(requestSession(req({}))).toBeNull();
    revokeTokensForDevice('phone-rs');
    expect(requestSession(req({ authorization: `Bearer ${phone}` }))).toBeNull();
  });

  it('reads the cookie before the Bearer header, like every other route', () => {
    const phone = createToken('phone-cookie');
    const desktop = createToken();
    expect(requestSession(req({ cookie: `auth_token=${desktop}`, authorization: `Bearer ${phone}` }))).toEqual({ deviceId: null });
  });
});

describe('device-bound session tokens', () => {
  it('remember which phone they belong to; password logins belong to none', () => {
    const phone = createToken('phone-1');
    const desktop = createToken();
    expect(getTokenDeviceId(phone)).toBe('phone-1');
    expect(getTokenDeviceId(desktop)).toBeNull();
  });

  it('revokeTokensForDevice ends only that phone’s sessions', () => {
    const a1 = createToken('phone-a');
    const a2 = createToken('phone-a');
    const b = createToken('phone-b');
    const desktop = createToken();
    expect(revokeTokensForDevice('phone-a')).toBe(2);
    expect(validateToken(a1)).toBe(false);
    expect(validateToken(a2)).toBe(false);
    expect(validateToken(b)).toBe(true);
    expect(validateToken(desktop)).toBe(true);
  });

  it('keeps at most four live sessions per phone, dropping the oldest', () => {
    const minted = Array.from({ length: 6 }, () => createToken('phone-cap'));
    expect(minted.map(validateToken)).toEqual([false, false, true, true, true, true]);
  });

  it('a refreshed token stays bound to its phone, so a later revoke still ends it', () => {
    const old = createToken('phone-c');
    const fresh = refreshToken(old)!;
    expect(getTokenDeviceId(fresh)).toBe('phone-c');
    revokeTokensForDevice('phone-c');
    expect(validateToken(fresh)).toBe(false);
  });
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  ping = vi.fn();
  terminate = vi.fn();
  close = vi.fn();
}

describe('disconnectDevice', () => {
  let ws: typeof import('../server/wsManager.js');
  beforeAll(async () => { ws = await import('../server/wsManager.js'); });

  it('terminates every socket of the revoked phone at once and leaves the others alone', () => {
    const phone1 = new FakeSocket();
    const phone2 = new FakeSocket();
    const other = new FakeSocket();
    ws.handleConnection(phone1 as never, { clientId: 'p1', label: 'Phone', address: '192.168.1.9', isLocal: false, deviceId: 'phone-x' });
    ws.handleConnection(phone2 as never, { clientId: 'p2', label: 'Phone', address: '100.64.0.9', isLocal: false, deviceId: 'phone-x' });
    ws.handleConnection(other as never, { clientId: 'd1', label: 'Desktop', address: '127.0.0.1', isLocal: true });
    expect(ws.disconnectDevice('phone-x')).toBe(2);
    // terminate(), not close(): a pending close handshake would still deliver its messages for up to 30 s.
    expect(phone1.terminate).toHaveBeenCalled();
    expect(phone2.terminate).toHaveBeenCalled();
    expect(other.terminate).not.toHaveBeenCalled();
    for (const s of [phone1, phone2, other]) s.emit('close');
  });
});
