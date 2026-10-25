// test/remoteAccessRoutes.test.ts - AASC-60 Remote access, Task 3: the Mac-side view behind RESOURCES -> Cloud -> Remote access.
//
// The page shows this Mac's Tailscale, whether the Mac has told its AASC Cloud account where to find it (Task 7 fills that
// in), and, per paired phone, whether the phone already knows the Mac's Tailscale address and how it last connected. It has
// two actions: check again, and open the Tailscale app. All of it lives under /api/resources/cloud/remote-access, behind the
// RESOURCES local gate, and none of it needs a cloud connection.
//
// Nothing here may start a real process: the probe is a fake and every openApp is injected, so `open -a Tailscale` never
// runs (.claude/rules/known-issues.md, "A test must never reach a real process").
import express from 'express';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { createCloudConnection } from '../server/cloud/connection.js';
import { createRemoteAccess } from '../server/cloud/remoteAccess.js';
import log from '../server/logger.js';
import { cloudJsonParser } from '../server/cloud/router.js';
import { createFileSecretStore } from '../server/cloud/secretStore.js';
import {
  createDeviceAuth,
  type MobileDeviceRecord,
  type MobileDeviceStore,
  type MobileDeviceView,
} from '../server/mobile/deviceAuth.js';
import { PHONE_ACCESS } from '../server/mobile/phoneProfile.js';
import { createPhonePathLog, type PhonePathLog } from '../server/mobile/phonePathLog.js';
import { createResourceRouter, resourceErrorHandler } from '../server/resourceRouter.js';
import type { PublishView, RemoteAccessView, TailscaleStatus } from '../src/types/remoteAccess.js';

const MAC_PORT = 3334;
const TAILNET = '100.101.102.103';

const CONNECTED: TailscaleStatus = {
  state: 'connected',
  address: TAILNET,
  account: 'kason@gmail.com',
  tailnet: 'kason@gmail.com',
  dnsName: 'kason-mbp.tail1234.ts.net',
};
/** A state with nothing else known about it. */
const statusOf = (state: TailscaleStatus['state']): TailscaleStatus => ({
  state,
  address: null,
  account: null,
  tailnet: null,
  dnsName: null,
});

type StatusFn = (opts?: { fresh?: boolean }) => Promise<TailscaleStatus>;
type Publisher = { view(): PublishView; check(options?: { retryRefused?: boolean }): Promise<PublishView> };

/** A probe whose cached answer and fresh answer can differ. */
const fakeProbe = (answer: (fresh: boolean) => TailscaleStatus = () => CONNECTED) => ({
  status: vi.fn<StatusFn>(async (opts) => answer(opts?.fresh === true)),
});

/** What `deviceAuth.list()` returns for one phone. */
function phone(id: string, over: Partial<MobileDeviceView> = {}): MobileDeviceView {
  return {
    id,
    label: `Phone ${id}`,
    platform: 'ios',
    status: 'active',
    confirmCode: null,
    createdAt: 1,
    approvedAt: 2,
    lastSeenAt: null,
    access: PHONE_ACCESS,
    ...over,
  };
}

/** An in-memory device store, as test/mobilePaths.test.ts builds one: the real deviceAuth on top of it. */
function memoryStore(): MobileDeviceStore {
  const rows = new Map<string, MobileDeviceRecord>();
  return {
    insert: (rec) => {
      rows.set(rec.id, { ...rec });
    },
    get: (id) => (rows.has(id) ? { ...rows.get(id)! } : null),
    update: (id, patch) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, ...patch });
    },
    listLive: () => [...rows.values()].filter((r) => r.status !== 'revoked').map((r) => ({ ...r })),
    remove: (id) => {
      rows.delete(id);
    },
  };
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

interface Options {
  /** Replaces the RESOURCES local gate. Default: the real one (these requests are loopback). */
  isLocalRequest?: () => boolean;
  /** Mount a real cloud connector next to Remote access, as the app does when its cloud storage opens. Default: true. */
  cloud?: boolean;
  probe?: ReturnType<typeof fakeProbe>;
  devices?: () => MobileDeviceView[];
  pathLog?: PhonePathLog;
  platform?: NodeJS.Platform;
  openApp?: () => Promise<void>;
  publisher?: Publisher;
}

/**
 * Express + createResourceRouter, as test/cloudRoutes.test.ts builds it (the same body parsers in front), with the Remote
 * access service behind a fake probe. With a cloud connector the Remote access routes must be answered ahead of the cloud
 * ones, so every test that runs with one also guards the mount order.
 */
async function setup(options: Options = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-remote-access-')));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const cloud =
    options.cloud === false
      ? undefined
      : await createCloudConnection({
          directory: join(dir, 'cloud'),
          secrets: createFileSecretStore(join(dir, 'secrets')),
        });
  if (cloud) cleanup.push(() => cloud.stop());

  const probe = options.probe ?? fakeProbe();
  const openApp = options.openApp ? vi.fn(options.openApp) : vi.fn(async () => {});
  const remoteAccess = createRemoteAccess({
    probe,
    devices: options.devices ?? (() => []),
    pathLog: options.pathLog ?? createPhonePathLog(),
    port: MAC_PORT,
    platform: options.platform ?? 'darwin',
    openApp,
    ...(options.publisher ? { publisher: options.publisher } : {}),
  });

  const app = express();
  app.use('/api/resources/cloud', cloudJsonParser());
  app.use(express.json({ limit: '50mb' }));
  app.use(
    '/api/resources',
    createResourceRouter({
      sessionProjectPaths: () => [],
      home: dir,
      remoteAccess,
      ...(cloud ? { cloud, cloudAliasDirectory: join(dir, 'cloud') } : {}),
      ...(options.isLocalRequest ? { isLocalRequest: options.isLocalRequest } : {}),
    }),
  );
  app.use('/api/resources', resourceErrorHandler);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/resources/cloud/remote-access`, probe, openApp };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

const JSON_HEADERS = { 'content-type': 'application/json' };
/** A POST as the page sends it (always a `{}` body). `headers` replaces the JSON content type. */
const post = (f: Fixture, path: string, headers: Record<string, string> = JSON_HEADERS) =>
  fetch(f.url + path, { method: 'POST', headers, body: '{}' });
const viewOf = async (res: Response): Promise<{ success: true; data: RemoteAccessView }> => {
  expect(res.status).toBe(200);
  return (await res.json()) as { success: true; data: RemoteAccessView };
};

it('GET /api/resources/cloud/remote-access answers the view on this Mac', async () => {
  const f = await setup();
  const res = await fetch(f.url);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.json()).toEqual({
    success: true,
    data: {
      tailscale: { ...CONNECTED, canOpenApp: true },
      publish: { state: 'unavailable', tailnet: null, port: MAC_PORT, at: null },
      phones: [],
      port: MAC_PORT,
    },
  });
  // A plain read takes the probe's cached answer.
  expect(f.probe.status).toHaveBeenCalledTimes(1);
  expect(f.probe.status.mock.calls[0]?.[0]?.fresh).toBeFalsy();
});

it('answers 404 to any other device (the RESOURCES gate)', async () => {
  const f = await setup({ isLocalRequest: () => false });
  expect((await fetch(f.url)).status).toBe(404);
  for (const path of ['/refresh', '/open-tailscale']) {
    expect((await post(f, path)).status).toBe(404);
  }
  // Nothing behind the gate ran: no Tailscale probe, no app launch.
  expect(f.probe.status).not.toHaveBeenCalled();
  expect(f.openApp).not.toHaveBeenCalled();
});

it('works with no cloud connector at all', async () => {
  const f = await setup({ cloud: false });
  const { data } = await viewOf(await fetch(f.url));
  expect(data.publish).toEqual({ state: 'unavailable', tailnet: null, port: MAC_PORT, at: null });
  expect(data.tailscale.state).toBe('connected');
  // The writes need no cloud either.
  expect((await post(f, '/refresh')).status).toBe(200);
});

it('lists phones with hasTailnet only when the sent address is the current one', async () => {
  let clock = 1_000;
  const pathLog = createPhonePathLog(() => clock);
  clock = 2_000;
  pathLog.sent('phone-current', TAILNET);
  clock = 3_000;
  pathLog.sent('phone-stale', '100.64.0.9'); // the address the Mac had before it changed
  const f = await setup({
    pathLog,
    devices: () => [
      phone('phone-current'),
      phone('phone-stale', { platform: 'android' }),
      // Nothing is sent to a phone nobody approved yet; its confirm code must stay out of the view.
      phone('phone-pending', { status: 'pending', confirmCode: '123456', approvedAt: null }),
    ],
  });
  const { data } = await viewOf(await fetch(f.url));
  expect(data.phones).toEqual([
    {
      id: 'phone-current',
      label: 'Phone phone-current',
      platform: 'ios',
      status: 'active',
      hasTailnet: true,
      tailnetSentAt: 2_000,
      lastPath: null,
      lastPathAt: null,
    },
    {
      id: 'phone-stale',
      label: 'Phone phone-stale',
      platform: 'android',
      status: 'active',
      hasTailnet: false,
      tailnetSentAt: 3_000,
      lastPath: null,
      lastPathAt: null,
    },
    {
      id: 'phone-pending',
      label: 'Phone phone-pending',
      platform: 'ios',
      status: 'pending',
      hasTailnet: false,
      tailnetSentAt: null,
      lastPath: null,
      lastPathAt: null,
    },
  ]);
});

it('never counts a phone as knowing an address the Mac does not have (null is not a match)', async () => {
  // Connected, but with no usable IPv4 yet: the address is null, and so is what a phone was never sent.
  const probe = fakeProbe(() => statusOf('connected'));
  const f = await setup({ probe, devices: () => [phone('phone-never')] });
  const { data } = await viewOf(await fetch(f.url));
  expect(data.tailscale).toMatchObject({ state: 'connected', address: null });
  expect(data.phones.map((p) => p.hasTailnet)).toEqual([false]);
});

it('shows the last path each phone used since AASC started', async () => {
  let clock = 5_000;
  const pathLog = createPhonePathLog(() => clock);
  pathLog.signedIn('phone-home', '192.168.1.20'); // it dialled the Mac's home-network address
  clock = 6_000;
  pathLog.signedIn('phone-away', TAILNET); // it dialled the Mac's Tailscale address
  clock = 7_000;
  pathLog.signedIn('phone-back', TAILNET);
  clock = 8_000;
  pathLog.signedIn('phone-back', '192.168.1.20'); // the last sign-in wins
  const f = await setup({
    pathLog,
    devices: () => [phone('phone-home'), phone('phone-away'), phone('phone-back'), phone('phone-silent')],
  });
  const { data } = await viewOf(await fetch(f.url));
  expect(data.phones.map(({ id, lastPath, lastPathAt }) => ({ id, lastPath, lastPathAt }))).toEqual([
    { id: 'phone-home', lastPath: 'lan', lastPathAt: 5_000 },
    { id: 'phone-away', lastPath: 'tailnet', lastPathAt: 6_000 },
    { id: 'phone-back', lastPath: 'lan', lastPathAt: 8_000 },
    { id: 'phone-silent', lastPath: null, lastPathAt: null },
  ]);
});

it('reads the paired phones afresh on every request', async () => {
  // Each answer is a new list, as deviceAuth.list() makes one: a list kept from the first request would stay empty.
  let paired: MobileDeviceView[] = [];
  const f = await setup({ devices: () => paired });
  expect((await viewOf(await fetch(f.url))).data.phones).toEqual([]);
  paired = [phone('phone-new')];
  expect((await viewOf(await fetch(f.url))).data.phones.map((p) => p.id)).toEqual(['phone-new']);
  paired = [];
  expect((await viewOf(await post(f, '/refresh'))).data.phones).toEqual([]);
});

it('leaves out a revoked phone', async () => {
  // deviceAuth.list() never returns one; the view does not depend on that.
  const f = await setup({ devices: () => [phone('phone-gone', { status: 'revoked' }), phone('phone-here')] });
  expect((await viewOf(await fetch(f.url))).data.phones.map((p) => p.id)).toEqual(['phone-here']);
});

it('shows what the real deviceAuth.list() returns: pending and active phones, never a revoked one or a confirm code', async () => {
  const auth = createDeviceAuth({ store: memoryStore() });
  const pair = (label: string, platform: 'ios' | 'android', approve: boolean): string => {
    const { code } = auth.createPairingCode();
    const { device } = auth.redeem({ code, label, platform })!;
    if (approve) auth.approve(device.id);
    return device.id;
  };
  const active = pair('Kason iPhone', 'ios', true);
  const pending = pair('New Pixel', 'android', false);
  auth.revoke(pair('Old iPad', 'ios', true));
  const confirmCode = auth.list().find((d) => d.id === pending)!.confirmCode!;
  expect(confirmCode).toBeTruthy(); // the pending phone does carry one in deviceAuth's own view

  const f = await setup({ devices: () => auth.list() });
  const { data } = await viewOf(await fetch(f.url));
  expect(data.phones.map(({ id, label, platform, status }) => ({ id, label, platform, status }))).toEqual([
    { id: active, label: 'Kason iPhone', platform: 'ios', status: 'active' },
    { id: pending, label: 'New Pixel', platform: 'android', status: 'pending' },
  ]);
  expect(JSON.stringify(data)).not.toContain(confirmCode);
});

it('POST /refresh asks the probe for a fresh status', async () => {
  // The cached answer is stale: Tailscale was switched on after it was taken.
  const probe = fakeProbe((fresh) => (fresh ? CONNECTED : statusOf('stopped')));
  const f = await setup({ probe });
  expect((await viewOf(await fetch(f.url))).data.tailscale.state).toBe('stopped');

  const res = await post(f, '/refresh');
  expect(probe.status).toHaveBeenLastCalledWith({ fresh: true });
  const { data } = await viewOf(res);
  expect(data.tailscale).toEqual({ ...CONNECTED, canOpenApp: true });
});

it('shows the publisher\'s view, and /refresh runs its check after the fresh probe', async () => {
  const pending: PublishView = { state: 'pending', tailnet: null, port: MAC_PORT, at: null };
  const published: PublishView = { state: 'published', tailnet: TAILNET, port: MAC_PORT, at: 9_000 };
  // A fresh look takes a moment (it runs the Tailscale CLI). The check works from the address that look
  // just put in the probe's cache, so it must start only once the look is done.
  let freshLookDone = false;
  let freshLookDoneWhenCheckStarted: boolean | null = null;
  const probe = fakeProbe();
  probe.status.mockImplementation(async (opts) => {
    if (opts?.fresh) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      freshLookDone = true;
    }
    return CONNECTED;
  });
  const publisher: Publisher = {
    view: vi.fn(() => pending),
    check: vi.fn(async () => {
      freshLookDoneWhenCheckStarted = freshLookDone;
      return published;
    }),
  };
  const f = await setup({ probe, publisher });

  expect((await viewOf(await fetch(f.url))).data.publish).toEqual(pending);
  expect(publisher.check).not.toHaveBeenCalled(); // a read never publishes

  const { data } = await viewOf(await post(f, '/refresh'));
  expect(data.publish).toEqual(published);
  expect(publisher.check).toHaveBeenCalledTimes(1);
  expect(freshLookDoneWhenCheckStarted).toBe(true);
});

it('POST /refresh is "Check again": it asks the publisher to look again at a refusal it remembered', async () => {
  const published: PublishView = { state: 'published', tailnet: TAILNET, port: MAC_PORT, at: 9_000 };
  const publisher: Publisher = { view: vi.fn(() => published), check: vi.fn(async () => published) };
  const f = await setup({ publisher });
  await viewOf(await post(f, '/refresh'));
  expect(publisher.check).toHaveBeenCalledTimes(1);
  expect(publisher.check).toHaveBeenCalledWith({ retryRefused: true });
});

// A cloud fault must never take the Remote access page down (AASC-60 R9). A publisher promises that view() never throws and
// check() never rejects; the page guards both anyway.
const FAILED_PUBLISH: PublishView = { state: 'failed', tailnet: null, port: MAC_PORT, at: null };

it('a publisher whose view() throws reads as failed, and the page still answers 200', async () => {
  const publisher: Publisher = {
    view: () => {
      throw new Error('publisher exploded at /Users/someone/private');
    },
    check: vi.fn(async () => FAILED_PUBLISH),
  };
  const f = await setup({ publisher });
  const { data } = await viewOf(await fetch(f.url));
  expect(data.publish).toEqual(FAILED_PUBLISH);
  // The rest of the page is as it was, and the reason stays off it.
  expect(data.tailscale).toEqual({ ...CONNECTED, canOpenApp: true });
  expect(data.port).toBe(MAC_PORT);
  expect(JSON.stringify(data)).not.toContain('exploded');
});

it('a publisher whose check() rejects still lets /refresh answer 200 (failed), and the fault is logged as a warning', async () => {
  vi.mocked(log.warn).mockClear();
  const publisher: Publisher = {
    view: vi.fn(() => FAILED_PUBLISH),
    check: vi.fn(async () => {
      throw new Error('publisher exploded at /Users/someone/private');
    }),
  };
  const f = await setup({ publisher });
  const { data } = await viewOf(await post(f, '/refresh'));
  expect(publisher.check).toHaveBeenCalledTimes(1);
  expect(data.publish).toEqual(FAILED_PUBLISH);
  // The fresh look at Tailscale still happened and still shows.
  expect(f.probe.status).toHaveBeenLastCalledWith({ fresh: true });
  expect(data.tailscale).toEqual({ ...CONNECTED, canOpenApp: true });
  expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(log.warn)).toHaveBeenCalledWith('remote-access', expect.stringContaining('exploded'));
  // The reason (it could name a path) stays in the log; the page gets only the state.
  expect(JSON.stringify(data)).not.toContain('exploded');
});

it('carries only the fields the page expects', async () => {
  // A probe or publisher that learns a new field must not widen the view: the page validates it strictly.
  const probe = fakeProbe(() => ({ ...CONNECTED, authUrl: 'https://login.tailscale.com/a/secret' }) as TailscaleStatus);
  const publisher = {
    view: () => ({ state: 'published', tailnet: TAILNET, port: MAC_PORT, at: 1, token: 'secret' }) as PublishView,
    check: async () => ({ state: 'published', tailnet: TAILNET, port: MAC_PORT, at: 1, token: 'secret' }) as PublishView,
  };
  const f = await setup({ probe, publisher });
  const { data } = await viewOf(await fetch(f.url));
  expect(Object.keys(data).sort()).toEqual(['phones', 'port', 'publish', 'tailscale']);
  expect(Object.keys(data.tailscale).sort()).toEqual(['account', 'address', 'canOpenApp', 'dnsName', 'state', 'tailnet']);
  expect(Object.keys(data.publish).sort()).toEqual(['at', 'port', 'state', 'tailnet']);
  expect(JSON.stringify(data)).not.toContain('secret');
});

it('canOpenApp is true only on macOS with Tailscale installed', async () => {
  const cases: Array<[NodeJS.Platform, TailscaleStatus['state'], boolean]> = [
    ['darwin', 'connected', true],
    ['darwin', 'signed-out', true],
    ['darwin', 'stopped', true],
    ['darwin', 'not-running', true],
    ['darwin', 'not-installed', false],
    ['linux', 'connected', false],
    ['win32', 'not-running', false],
  ];
  for (const [platform, state, canOpenApp] of cases) {
    const f = await setup({ cloud: false, platform, probe: fakeProbe(() => statusOf(state)) });
    const { data } = await viewOf(await fetch(f.url));
    expect({ platform, state, canOpenApp: data.tailscale.canOpenApp }).toEqual({ platform, state, canOpenApp });
  }
});

it('POST /refresh and /open-tailscale refuse a cross-site page (403) and non-JSON (415)', async () => {
  const refused = { success: false, error: { code: 'forbidden', message: 'Same-origin request required' } };
  const crossSite = { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' };
  // A page on another localhost port is "local" to the RESOURCES gate (a loopback Origin) but is not the AASC page.
  const otherPort = { ...JSON_HEADERS, 'sec-fetch-site': 'same-site', origin: 'http://localhost:4555' };
  // A tool that sends an Origin without browser metadata: it has to be this server's own.
  const bareOrigin = { ...JSON_HEADERS, origin: 'http://localhost:4555' };

  const gated = await setup(); // the real gate: it already answers a cross-site fetch with 404
  const open = await setup({ isLocalRequest: () => true }); // the gate out of the way: the router's own check
  for (const path of ['/refresh', '/open-tailscale']) {
    for (const headers of [otherPort, bareOrigin]) {
      const res = await post(gated, path, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(refused);
    }
    expect((await post(gated, path, crossSite)).status).toBe(404);
    for (const headers of [crossSite, otherPort, bareOrigin]) {
      const res = await post(open, path, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(refused);
    }

    // A <form> cannot send JSON.
    for (const f of [gated, open]) {
      const res = await post(f, path, { 'content-type': 'text/plain' });
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({
        success: false,
        error: { code: 'unsupported_media_type', message: 'Content-Type must be application/json' },
      });
    }
    // Cross-site wins over non-JSON: the caller learns nothing more about the route.
    expect((await post(open, path, { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  }
  for (const f of [gated, open]) {
    // A refused write ran nothing: no fresh probe, no app launch.
    expect(f.probe.status).not.toHaveBeenCalled();
    expect(f.openApp).not.toHaveBeenCalled();
  }
  // The same page, with JSON, is let in.
  expect((await post(gated, '/refresh', { ...JSON_HEADERS, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  expect((await post(gated, '/open-tailscale', { ...JSON_HEADERS, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
});

it('open-tailscale: unsupported (409) off macOS, never runs a process in tests', async () => {
  for (const platform of ['linux', 'win32'] as const) {
    const f = await setup({ cloud: false, platform });
    const res = await post(f, '/open-tailscale');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      success: false,
      error: { code: 'unsupported', message: 'Open Tailscale from your menu bar.' },
    });
    expect(f.openApp).not.toHaveBeenCalled();
  }
});

it('open-tailscale: opens the Tailscale app on macOS', async () => {
  const f = await setup({ platform: 'darwin' });
  const res = await post(f, '/open-tailscale');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ success: true });
  expect(f.openApp).toHaveBeenCalledTimes(1);
});

it('open-tailscale: a launch that fails answers 502 open_failed without the reason', async () => {
  const f = await setup({
    platform: 'darwin',
    openApp: async () => {
      throw new Error("Unable to find application named 'Tailscale' (/Users/someone/private)");
    },
  });
  const res = await post(f, '/open-tailscale');
  expect(res.status).toBe(502);
  const body = (await res.json()) as { success: boolean; error: { code: string; message: string } };
  expect(body.success).toBe(false);
  expect(body.error.code).toBe('open_failed');
  expect(body.error.message).toBeTruthy();
  expect(JSON.stringify(body)).not.toContain('/Users/someone');
});
