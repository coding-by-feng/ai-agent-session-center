// test/bindAddress.test.ts — AASC_BIND_ADDRESS / bindAddress (terminal-editions plan §7.3, §7.6).
//
// The main listener binds every interface by default. On a VPS the owner keeps the port off the
// Internet by binding it to one interface: 127.0.0.1 behind Caddy, or the Tailscale address. A typo
// must stop the start (a config refusal, EX_CONFIG 78) rather than quietly fall back to every interface, the opposite of
// what was asked.
//
// A specific non-loopback address still gets a 127.0.0.1 listener on the same port: the hook
// script's HTTP fallback, MCP centrals, the folder lock's liveness probe and the admin CLI (with its
// owner token) all talk to 127.0.0.1.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { resolveBindAddress, needsLoopbackCompanion, startLoopbackCompanion } from '../server/bindAddress.js';
import { StartupError, EXIT_CODES } from '../server/startupGuard.js';
import { isLocalRequest } from '../server/requestLocality.js';
import {
  installKillGuard, cleanScratch, freePort, makeBox, pickRuntime, buildBundle, startBundle, stop, type Runtime,
} from './helpers/headlessBundle.js';

describe('resolveBindAddress', () => {
  it('is null (every interface) when neither is set', () => {
    expect(resolveBindAddress(undefined, undefined)).toBeNull();
    expect(resolveBindAddress('', undefined)).toBeNull();
    expect(resolveBindAddress('  ', null)).toBeNull();
  });

  it('takes the environment over server-config.json', () => {
    expect(resolveBindAddress('100.101.102.103', '127.0.0.1')).toBe('100.101.102.103');
    expect(resolveBindAddress(undefined, '127.0.0.1')).toBe('127.0.0.1');
    expect(resolveBindAddress(' ::1 ', undefined)).toBe('::1');
  });

  it.each(['localhost', '0.0.0.0.0', '256.1.1.1', '127.0.0.1:3333', 'tailscale0', '1.2.3.4; rm -rf /'])(
    'refuses %s as a config error', (value) => {
      let error: unknown;
      try { resolveBindAddress(value, undefined); } catch (err) { error = err; }
      expect(error).toBeInstanceOf(StartupError);
      expect((error as StartupError).exitCode).toBe(EXIT_CODES.CONFIG);
      expect((error as StartupError).message).toMatch(/AASC_BIND_ADDRESS/);
    },
  );

  it('refuses a config value that is not a string', () => {
    expect(() => resolveBindAddress(undefined, 3333 as unknown as string)).toThrow(StartupError);
  });
});

describe('needsLoopbackCompanion', () => {
  it('is false when 127.0.0.1 is already served', () => {
    expect(needsLoopbackCompanion(null)).toBe(false);
    expect(needsLoopbackCompanion('0.0.0.0')).toBe(false);
    expect(needsLoopbackCompanion('::')).toBe(false);
    expect(needsLoopbackCompanion('127.0.0.1')).toBe(false);
  });

  it('is true for one specific other interface', () => {
    expect(needsLoopbackCompanion('100.101.102.103')).toBe(true);
    expect(needsLoopbackCompanion('192.168.1.20')).toBe(true);
    expect(needsLoopbackCompanion('::1')).toBe(true);
  });
});

describe('startLoopbackCompanion', () => {
  it('serves the same app and WebSocket server on 127.0.0.1, and its requests stay local', async () => {
    const app = express();
    app.get('/whoami', (req, res) => { res.json({ local: isLocalRequest(req) }); });
    const main = http.createServer(app);
    const wss = new WebSocketServer({ noServer: true });
    const connected = new Promise<boolean>((resolve) => wss.on('connection', (_ws, req) => resolve(isLocalRequest(req))));
    // A free port, then the companion on it (the main listener would hold another interface).
    await new Promise<void>((r) => main.listen(0, '127.0.0.1', r));
    const port = (main.address() as AddressInfo).port;
    await new Promise<void>((r) => main.close(() => r()));

    const companion = await startLoopbackCompanion(app, wss, port);
    try {
      expect(companion.address()).toMatchObject({ address: '127.0.0.1', port });
      const res = await fetch(`http://127.0.0.1:${port}/whoami`, { headers: { host: `127.0.0.1:${port}` } });
      expect(await res.json()).toEqual({ local: true });
      const { WebSocket } = await import('ws');
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      const opened = new Promise<void>((r) => ws.once('open', () => r()));
      expect(await connected).toBe(true);
      await opened;
      ws.close();
    } finally {
      wss.close();
      await new Promise<void>((r) => companion.close(() => r()));
    }
  });

  it('rejects when the loopback port is taken', async () => {
    const holder = http.createServer();
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r));
    const port = (holder.address() as AddressInfo).port;
    try {
      await expect(startLoopbackCompanion(express(), new WebSocketServer({ noServer: true }), port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(holder.listening).toBe(true);
    } finally {
      await new Promise<void>((r) => holder.close(() => r()));
    }
  });
});

describe('the bundle with a bind address', () => {
  const restoreKill = installKillGuard('bindAddress.test');
  let bundle = '';
  let runtime: Runtime;

  beforeAll(async () => {
    bundle = await buildBundle('bind-address-test');
    runtime = pickRuntime();
  }, 120_000);

  afterAll(() => {
    restoreKill();
    if (bundle) rmSync(bundle, { force: true });
    cleanScratch();
  });

  it('exits 78 on a malformed value, before it listens', async () => {
    const run = startBundle(bundle, runtime, makeBox(), await freePort(), { env: { AASC_BIND_ADDRESS: 'tailscale0' } });
    expect(await run.exited).toBe(EXIT_CODES.CONFIG);
    expect(run.output()).toMatch(/AASC_BIND_ADDRESS must be an IP address/);
  }, 60_000);

  // 192.0.2.1 is TEST-NET-1: a valid address no machine has, like a Tailscale address before
  // tailscaled is up. That fixes itself, so it is exit 1, which systemd restarts.
  it('exits 1 when the address is not on this machine (yet)', async () => {
    const run = startBundle(bundle, runtime, makeBox(), await freePort(), { env: { AASC_BIND_ADDRESS: '192.0.2.1' } });
    try {
      expect(await run.exited).toBe(EXIT_CODES.FAILURE);
      expect(run.output()).toMatch(/192\.0\.2\.1 .* is not an address of this machine/);
    } finally {
      await stop(run);
    }
  }, 60_000);
});
