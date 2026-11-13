// test/deviceOnline.test.ts — "online" for paired computers, and CLI sockets in presence (P2 review).
//
// `aasc-server devices` / `status` read `online` from GET /api/mobile/devices. It came from
// isPhoneDeviceOnline, which matches a socket's phone `_deviceId`, so a paired computer (which only
// has `_pairedId`) never showed online. Computers now get their own check; the header's 📱 count
// filters computers out (devicePresenceSummary.ts), so it is unchanged.
//
// And a socket that declared role=cli tells presence so when it closes, so a dashboard sharing its
// client id keeps the workspace writer role (security review L2).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import express from 'express';
import { describe, it, expect, vi, beforeAll } from 'vitest';

const mockConfig = vi.hoisted(() => ({ passwordHash: 'set' } as { passwordHash?: string }));
vi.mock('../server/serverConfig.js', () => ({ config: mockConfig }));
vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), default: {},
}));

import { createDeviceAuth, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { createMobileRouter } from '../server/mobile/mobileRouter.js';
import { summarizePhones } from '../src/lib/devicePresenceSummary.js';
import type { PairedPhone } from '../src/lib/mobilePairingApi.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  ping = vi.fn();
  terminate = vi.fn();
  close = vi.fn();
}

describe('wsManager online checks', () => {
  let ws: typeof import('../server/wsManager.js');
  let presence: typeof import('../server/presenceManager.js');
  beforeAll(async () => {
    ws = await import('../server/wsManager.js');
    presence = await import('../server/presenceManager.js');
  });

  it('sees a paired computer online by its pairedId, and never as a phone', () => {
    const computer = new FakeSocket();
    const phone = new FakeSocket();
    ws.handleConnection(computer as never, { clientId: 'c1', label: 'Air', address: '100.64.0.2', isLocal: false, deviceId: null, pairedId: 'computer-1' });
    ws.handleConnection(phone as never, { clientId: 'p1', label: 'iPhone', address: '100.64.0.3', isLocal: false, deviceId: 'phone-1' });
    expect(ws.isPairedComputerOnline('computer-1')).toBe(true);
    expect(ws.isPhoneDeviceOnline('computer-1')).toBe(false);
    expect(ws.isPairedComputerOnline('phone-1')).toBe(false);
    expect(ws.isPairedComputerOnline('')).toBe(false);
    computer.emit('close');
    expect(ws.isPairedComputerOnline('computer-1')).toBe(false);
    phone.emit('close');
  });

  it('keeps a dashboard the writer when an aasc socket under its id closes', () => {
    const dash = new FakeSocket();
    const cli = new FakeSocket();
    ws.handleConnection(dash as never, { clientId: 'shared', label: 'Mac', address: '127.0.0.1', isLocal: true });
    ws.handleConnection(cli as never, { clientId: 'shared', label: 'aasc', address: '127.0.0.1', isLocal: true, cli: true });
    expect(presence.getWorkspaceWriter()).toBe('shared');
    cli.emit('close');
    expect(presence.getWorkspaceWriter()).toBe('shared');
    dash.emit('close');
    expect(presence.getWorkspaceWriter()).toBeNull();
  });
});

function memoryStore(rows: MobileDeviceRecord[]): MobileDeviceStore {
  const map = new Map(rows.map((r) => [r.id, r]));
  return {
    insert: (rec) => { map.set(rec.id, rec); },
    get: (id) => map.get(id) ?? null,
    update: (id, patch) => { const r = map.get(id); if (r) map.set(id, { ...r, ...patch }); },
    listLive: () => [...map.values()],
    remove: (id) => { map.delete(id); },
  };
}

const record = (id: string, platform: 'ios' | 'desktop'): MobileDeviceRecord => ({
  id, label: id, platform, tokenHash: 'x', status: 'active', confirmCode: '123456', beCodeRef: null, beCodeRefMacBound: false,
  credentialEpoch: null, createdAt: 1, approvedAt: 1, lastSeenAt: 1, revokedAt: null,
});

describe('GET /api/mobile/devices online', () => {
  it('asks the computer check for computers and the phone check for phones', async () => {
    const app = express();
    app.use('/api/mobile', createMobileRouter({
      deviceAuth: createDeviceAuth({ store: memoryStore([record('mac', 'desktop'), record('phone', 'ios')]) }),
      isPasswordEnabled: () => true,
      isPhoneOnline: () => false,
      isComputerOnline: (id) => id === 'mac',
      requireSession: (_req, _res, next) => next(),
      createSessionToken: () => 's',
      sessionTtlSeconds: 3600,
      pairingTarget: () => ({ name: 'Box', port: 1, lan: null, tailnet: null }),
      rateLimit: { check: () => 0, record: () => {}, clear: () => {} },
    }));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/mobile/devices`, { headers: { host: `localhost:${port}` } });
      const devices = (await res.json()).data.devices as PairedPhone[];
      expect(Object.fromEntries(devices.map((d) => [d.id, d.online]))).toEqual({ mac: true, phone: false });
      // The header's 📱 count leaves the online computer out.
      expect(summarizePhones(devices)).toMatchObject({ paired: 1, tablets: 0, online: 0 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
