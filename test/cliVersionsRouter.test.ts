// test/cliVersionsRouter.test.ts — GET /api/cli-versions and POST /api/cli-versions/:cli/update.
// The service is a fake: no CLI ever runs. Locality and the device id come from test headers.
import { createServer, type Server } from 'node:http';
import type { Request } from 'express';
import express from 'express';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCliVersionsRouter, PHONE_UPDATE_GAP_MS, REMOTE_REFRESH_GAP_MS } from '../server/cliVersionsRouter.js';
import type { CliVersionsService } from '../server/cliVersions.js';
import type { CliVersionInfo } from '../src/types/cliVersions.js';

const info = (cli: 'claude' | 'codex'): CliVersionInfo => ({
  cli, installed: '1.0.0', latest: '1.0.1', updateAvailable: true, checkedAt: 1, update: { state: 'idle' },
});

let server: Server;
let base = '';
let now = 0;
let service: CliVersionsService & { list: ReturnType<typeof vi.fn>; startUpdate: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  now = 1_000_000;
  service = {
    list: vi.fn(async () => [info('claude'), info('codex')]),
    startUpdate: vi.fn(() => 'started' as const),
    busy: () => null,
    idle: async () => {},
  };
  const app = express();
  app.use('/api', createCliVersionsRouter({
    service,
    isLocal: (req: Request) => req.headers['x-test-remote'] !== '1',
    deviceKeyOf: (req: Request) => String(req.headers['x-test-device'] ?? ''),
    now: () => now,
  }));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const phone = (device: string) => ({ 'x-test-remote': '1', 'x-test-device': device });
const update = (cli: string, headers: Record<string, string> = {}) => fetch(`${base}/cli-versions/${cli}/update`, { method: 'POST', headers });

describe('GET /cli-versions', () => {
  it('answers both CLIs, and passes refresh through', async () => {
    const res = await fetch(`${base}/cli-versions`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ success: true, data: [info('claude'), info('codex')] });
    expect(service.list).toHaveBeenLastCalledWith(false);
    await fetch(`${base}/cli-versions?refresh=1`);
    expect(service.list).toHaveBeenLastCalledWith(true);
  });

  it('lets a remote device ask npm again only once per window; sooner it gets the cached reading', async () => {
    await fetch(`${base}/cli-versions?refresh=1`, { headers: phone('a') });
    expect(service.list).toHaveBeenLastCalledWith(true);
    await fetch(`${base}/cli-versions?refresh=1`, { headers: phone('a') });
    expect(service.list).toHaveBeenLastCalledWith(false);
    await fetch(`${base}/cli-versions?refresh=1`); // the Mac
    expect(service.list).toHaveBeenLastCalledWith(true);
    now += REMOTE_REFRESH_GAP_MS;
    await fetch(`${base}/cli-versions?refresh=1`, { headers: phone('a') });
    expect(service.list).toHaveBeenLastCalledWith(true);
  });

  it('is a 500 with a plain message when the read throws', async () => {
    service.list.mockRejectedValueOnce(new Error('boom /Users/secret'));
    const res = await fetch(`${base}/cli-versions`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'Could not read the CLI versions' });
  });
});

describe('POST /cli-versions/:cli/update', () => {
  it('starts an update and answers 202', async () => {
    const res = await update('codex');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ success: true, data: { cli: 'codex', state: 'updating' } });
    expect(service.startUpdate).toHaveBeenCalledWith('codex');
  });

  it('refuses a CLI it does not know without running anything', async () => {
    for (const cli of ['gemini', 'claude;rm', '..']) {
      const res = await update(encodeURIComponent(cli));
      expect([400, 404]).toContain(res.status);
    }
    expect(service.startUpdate).not.toHaveBeenCalled();
  });

  it('is a 409 while another update runs', async () => {
    service.startUpdate.mockReturnValueOnce('busy');
    const res = await update('claude');
    expect(res.status).toBe(409);
    expect((await res.json()).success).toBe(false);
  });

  it('lets a phone update each CLI once per window, per device', async () => {
    expect((await update('codex', phone('a'))).status).toBe(202);
    const again = await update('codex', phone('a'));
    expect(again.status).toBe(429);
    expect((await again.json()).error).toMatch(/10 minutes/);
    expect((await update('claude', phone('a'))).status).toBe(202); // the other CLI
    expect((await update('codex', phone('b'))).status).toBe(202); // another phone
    now += PHONE_UPDATE_GAP_MS;
    expect((await update('codex', phone('a'))).status).toBe(202);
  });

  it('does not spend a phone’s turn on a busy refusal', async () => {
    service.startUpdate.mockReturnValueOnce('busy');
    expect((await update('codex', phone('a'))).status).toBe(409);
    expect((await update('codex', phone('a'))).status).toBe(202);
  });

  it('never limits the Mac itself', async () => {
    expect((await update('codex')).status).toBe(202);
    expect((await update('codex')).status).toBe(202);
  });
});
