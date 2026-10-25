// test/mcp/skillNoteOpsWiring.test.ts — how server/index.ts wires the window op routes (server/skillNoteOpsWiring.ts):
// the writer is the workspace writer only when it is a device on this Mac and not a paired phone (D-M1). The routes
// are mounted on a real Express app on an ephemeral port with a fake presence; nothing real is started.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DevicePresence } from '../../server/presenceManager.js';
import { createSkillNoteOpsWiring, localWriter, type WiringPresence } from '../../server/skillNoteOpsWiring.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const device = (clientId: string, isLocal: boolean): DevicePresence => ({
  clientId,
  label: clientId,
  address: isLocal ? '127.0.0.1' : '192.168.4.20',
  isLocal,
  connections: 1,
  connectedAt: 1,
  lastSeenAt: 1,
});

function presenceOf(devices: DevicePresence[]): WiringPresence {
  return {
    getWorkspaceWriter: () => devices[0]?.clientId ?? null,
    getDevice: (clientId) => devices.find((d) => d.clientId === clientId) ?? null,
  };
}

describe('localWriter', () => {
  it('is the workspace writer when it is on this Mac and not a phone', () => {
    expect(localWriter(presenceOf([device('mac-window', true)]), () => false)).toBe('mac-window');
  });

  it('a remote browser as the writer is no writer', () => {
    expect(localWriter(presenceOf([device('remote-browser', false)]), () => false)).toBeNull();
  });

  it('a paired phone is never the writer, even on loopback', () => {
    expect(localWriter(presenceOf([device('phone-1', true)]), (id) => id === 'phone-1')).toBeNull();
  });

  it('no device, or a writer presence no longer knows, is no writer', () => {
    expect(localWriter(presenceOf([]), () => false)).toBeNull();
    expect(localWriter({ getWorkspaceWriter: () => 'gone', getDevice: () => null }, () => false)).toBeNull();
  });
});

describe('createSkillNoteOpsWiring', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function mount(devices: DevicePresence[]): Promise<{ port: number; sent: string[] }> {
    const sent: string[] = [];
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createSkillNoteOpsWiring(presenceOf(devices), {
        isLocal: () => true,
        clientId: () => '',
        isPhone: () => false,
        sendToClient: (clientId) => {
          sent.push(clientId);
          return 1;
        },
        waitMs: 20,
      }),
    );
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, sent };
  }

  function post(port: number, path: string, body: unknown): Promise<number> {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  it('a remote browser as the writer is 409 for both ops, and nothing is sent', async () => {
    const r = await mount([device('remote-browser', false)]);

    expect(await post(r.port, '/api/skill-notes/ops', { agent: 'claude', name: 'retouch', set: { fav: true } })).toBe(409);
    expect(await post(r.port, '/api/keep-awake/ops', { on: true })).toBe(409);
    expect(r.sent).toEqual([]);
  });

  it('a window on this Mac is sent the op', async () => {
    const r = await mount([device('mac-window', true)]);

    expect(await post(r.port, '/api/keep-awake/ops', { on: true })).toBe(202);
    expect(r.sent).toEqual(['mac-window']);
  });
});
