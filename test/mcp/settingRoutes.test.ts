// test/mcp/settingRoutes.test.ts — Settings → ADVANCED "Central sessions (MCP)" routes
// (server/mcp/settingRoutes.ts): this Mac only, a boolean body, and the saved choice read back.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCentralSettingRouter } from '../../server/mcp/settingRoutes.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

let server: Server | null = null;

async function start(opts: { local: boolean; saveThrows?: boolean }) {
  const state = { enabled: false, nextStart: false };
  const save = vi.fn((on: boolean) => {
    if (opts.saveThrows) throw new Error('disk full');
    state.nextStart = on;
  });
  const app = express();
  app.use(express.json());
  app.use('/api', createCentralSettingRouter({ isLocal: () => opts.local, read: () => ({ ...state }), save }));
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/central-sessions-setting`;
  return { base, save };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('central-sessions setting routes', () => {
  it('reads the setting on this Mac', async () => {
    const { base } = await start({ local: true });
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: false, nextStart: false });
  });

  it('saves a choice and answers what applies at the next start', async () => {
    const { base, save } = await start({ local: true });
    const res = await fetch(base, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledWith(true);
    expect(await res.json()).toEqual({ ok: true, enabled: false, nextStart: true });
  });

  it('refuses a body that is not a boolean, and saves nothing', async () => {
    const { base, save } = await start({ local: true });
    const res = await fetch(base, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('is a plain 404 to any other device, for both methods', async () => {
    const { base, save } = await start({ local: false });
    expect((await fetch(base)).status).toBe(404);
    const put = await fetch(base, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(404);
    expect(save).not.toHaveBeenCalled();
  });

  it('answers 500 without detail when the save fails', async () => {
    const { base } = await start({ local: true, saveThrows: true });
    const res = await fetch(base, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'Could not save the setting' });
  });
});
