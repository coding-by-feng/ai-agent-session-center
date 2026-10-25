// test/macPathsIntegration.test.ts - AASC-60 Remote access, Task 7: the publisher with the real parts around it.
//
// test/macPathsPublisher.test.ts runs the publisher against fakes. Here it meets the real cloud connection (the device token,
// the route allow-list, which errors a 403 and a 404 become, and a saved connection that reads `offline` until its first
// request), the real Tailscale probe and the Remote access page behind "Check again", and server/index.ts, where it is wired in.
// A fake `fetch` and a fake `tailscale` runner: no network, no process.
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    debugJson: vi.fn(),
    isDebug: false,
  },
}));

import { createRemoteAccess } from '../server/cloud/remoteAccess.js';
import {
  createMacPathsPublisher,
  type MacPathsPublisher,
  type MacPathsPublisherDeps,
} from '../server/mobile/macPathsPublisher.js';
import { createPhonePathLog } from '../server/mobile/phonePathLog.js';
import { createTailscaleProbe, TAILSCALE_CACHE_MS } from '../server/tailscaleStatus.js';
import { accepted, macPathsBackend, ORIGIN, refused } from './macPathsFixture.js';

const TAILNET = '100.101.102.103';
const PORT = 3334;
const UPDATED_AT = '2026-10-22T01:23:45.000Z';

const publishers: MacPathsPublisher[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const publisher of publishers.splice(0)) publisher.stop();
  for (const undo of cleanups.splice(0).reverse()) await undo();
});

const quietLog = () => ({ warn: vi.fn(), debug: vi.fn() });

function publisherFor(
  cloud: MacPathsPublisherDeps['cloud'],
  tailnet: MacPathsPublisherDeps['tailnet'] = async () => TAILNET,
): MacPathsPublisher {
  const publisher = createMacPathsPublisher({
    cloud,
    tailnet,
    port: PORT,
    phonesCouldUse: () => true,
    log: quietLog(),
  });
  publishers.push(publisher);
  return publisher;
}

describe('over the real cloud connection', () => {
  it('publishes after a restart, when the saved connection still reads offline', async () => {
    const backend = await macPathsBackend(() => accepted({ updatedAt: UPDATED_AT }), cleanups);
    const restarted = await backend.reload();
    expect(restarted.status().state).toBe('offline'); // nothing has been asked yet
    const publisher = publisherFor(restarted);
    expect((await publisher.check()).state).toBe('published');
    expect(backend.calls).toEqual([
      expect.objectContaining({
        method: 'PUT',
        path: '/v1/mac-paths/self',
        body: { tailnet: TAILNET, port: PORT },
      }),
    ]);
    // The first request is what checked the connection.
    expect(restarted.status().state).toBe('connected');
  });

  it('retries a failed publish even though the failure left the cloud reading offline', async () => {
    const backend = await macPathsBackend(
      (_call, nth) =>
        nth === 1 ? new Response('{}', { status: 503 }) : accepted({ updatedAt: UPDATED_AT }),
      cleanups,
    );
    const publisher = publisherFor(backend.cloud);
    expect((await publisher.check()).state).toBe('failed');
    expect(backend.cloud.status().state).toBe('offline'); // the failed request did that
    expect((await publisher.check()).state).toBe('published');
    expect(backend.calls).toHaveLength(2);
  });

  it('a 403 from the backend stops requests until the Mac is paired again', async () => {
    const backend = await macPathsBackend(
      (_call, nth) => (nth === 1 ? refused(403, 'forbidden') : accepted({ updatedAt: UPDATED_AT })),
      cleanups,
    );
    const publisher = publisherFor(backend.cloud);
    expect((await publisher.check()).state).toBe('forbidden');
    await publisher.check();
    await publisher.check();
    expect(backend.calls).toHaveLength(1);
    expect(backend.cloud.status().state).toBe('connected'); // a refusal is still an answer from the backend

    await backend.cloud.connectCloud({
      backendUrl: ORIGIN,
      pairingCode: 'd'.repeat(22),
      deviceName: 'Kason MBP',
    });
    expect((await publisher.check()).state).toBe('published');
    expect(backend.calls).toHaveLength(2);
  });

  it('says no-cloud once the cloud is disconnected, and sends nothing', async () => {
    const backend = await macPathsBackend(() => accepted({ updatedAt: UPDATED_AT }), cleanups);
    const publisher = publisherFor(backend.cloud);
    await publisher.check();
    await backend.cloud.disconnectCloud();
    expect(publisher.view().state).toBe('no-cloud');
    expect((await publisher.check()).state).toBe('no-cloud');
    expect(backend.calls).toHaveLength(1);
  });
});

describe('with the real Tailscale probe and the Remote access page', () => {
  /** A Tailscale that can be switched on, behind the real probe and its few-seconds cache. */
  function tailscale() {
    let on = false;
    let clock = 0;
    const probe = createTailscaleProbe({
      platform: 'darwin',
      exists: async () => true,
      run: async () => ({
        stdout: JSON.stringify(
          on
            ? { BackendState: 'Running', TailscaleIPs: [TAILNET, 'fd7a:115c:a1e0::1'] }
            : { BackendState: 'Stopped' },
        ),
      }),
      interfaceAddress: () => null,
      now: () => clock,
    });
    return {
      probe,
      switchOn: () => {
        on = true;
      },
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  const pageOver = (probe: ReturnType<typeof tailscale>['probe'], publisher: MacPathsPublisher) =>
    createRemoteAccess({
      probe,
      publisher,
      devices: () => [],
      pathLog: createPhonePathLog(),
      port: PORT,
      platform: 'darwin',
      openApp: async () => {},
    });

  it('"Check again" looks at Tailscale afresh before the publisher does, so the address that look found is the one shared', async () => {
    const ts = tailscale();
    const backend = await macPathsBackend(() => accepted({ updatedAt: UPDATED_AT }), cleanups);
    const publisher = publisherFor(backend.cloud, async () => (await ts.probe.status()).address);
    const page = pageOver(ts.probe, publisher);

    // Tailscale is off: nothing to share, and the probe remembers that for a few seconds.
    await publisher.check();
    expect(publisher.view().state).toBe('no-tailscale');

    // It is switched on a moment later. A plain read of the page still shows what the probe remembers, and shares nothing.
    ts.switchOn();
    ts.advance(TAILSCALE_CACHE_MS - 1);
    const read = await page.view();
    expect(read.tailscale.state).toBe('stopped');
    expect(read.publish.state).toBe('no-tailscale');
    expect(backend.calls).toHaveLength(0);

    // Check again looks afresh first, so the publisher works from the address that look found.
    const checked = await page.refresh();
    expect(checked.tailscale).toMatchObject({ state: 'connected', address: TAILNET });
    expect(checked.publish).toMatchObject({ state: 'published', tailnet: TAILNET, port: PORT });
    expect(backend.calls).toEqual([
      expect.objectContaining({ body: { tailnet: TAILNET, port: PORT } }),
    ]);
  });

  it('"Update it, then press Check again": a backend without the service reads unsupported until Check again finds it', async () => {
    const ts = tailscale();
    ts.switchOn();
    let updated = false;
    const backend = await macPathsBackend(
      () => (updated ? accepted({ updatedAt: UPDATED_AT }) : refused(404, 'not_found')),
      cleanups,
    );
    const publisher = publisherFor(backend.cloud, async () => (await ts.probe.status()).address);
    const page = pageOver(ts.probe, publisher);

    await publisher.check(); // the first check, at start
    expect((await page.view()).publish.state).toBe('unsupported');
    await publisher.check(); // a minute later: no request
    expect(backend.calls).toHaveLength(1);

    updated = true;
    expect((await page.refresh()).publish).toMatchObject({ state: 'published', tailnet: TAILNET });
    expect(backend.calls).toHaveLength(2);
  });
});

describe('wiring in server/index.ts', () => {
  it('builds the publisher from the cloud connection and the server port, hands it to the page, starts it in onReady, stops it in gracefulShutdown, and gives the phones the probe’s address', async () => {
    const source = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8');
    const between = (from: string, to: string): string => {
      const start = source.indexOf(from);
      const end = source.indexOf(to, start);
      expect({ from, found: start > 0 }).toEqual({ from, found: true });
      expect({ to, found: end > start }).toEqual({ to, found: true });
      return source.slice(start, end);
    };

    // Only with a cloud connector (when its storage failed to open the page reads `unavailable`; a connector that is not
    // paired reads `no-cloud`), on the server's own port.
    const creation = between(
      'const macPathsPublisher = cloud',
      'const remoteAccess = createRemoteAccess(',
    );
    expect(creation).toContain('createMacPathsPublisher(');
    expect(creation).toMatch(/\bcloud,/);
    expect(creation).toContain('port: PORT');
    expect(creation).toContain('phonesCouldUse');
    expect(creation).toMatch(/:\s*null;/);

    // The page reads it, and it starts with the server.
    expect(between('const remoteAccess = createRemoteAccess(', '// -- Agent Resources')).toContain(
      'publisher: macPathsPublisher',
    );
    expect(between('function onReady()', '// Graceful shutdown')).toContain(
      'macPathsPublisher?.start()',
    );

    // Shutdown ends the timer next to the Bonjour advertiser. (cloud.stop() aborts what is in flight, and the timer is
    // unref()ed, so this is tidiness: nothing outlives the process.) test/cloudShutdown.test.ts injects every free
    // variable of gracefulShutdown, so `macPathsPublisher` is one of its names.
    expect(between('// Graceful shutdown', '// Expose shutdown')).toContain(
      'macPathsPublisher?.stop()',
    );

    // One address for the QR, /paths and the publisher: the probe's (R24), which uses the interface only without a
    // usable CLI answer (R26), never an interface scan of its own here. The probe is built before the mobile router,
    // which reads it.
    expect(source).not.toContain('getTailnetIP');
    expect(source.indexOf('const tailscaleProbe = createTailscaleProbe(')).toBeGreaterThan(0);
    expect(source.indexOf('const tailscaleProbe = createTailscaleProbe(')).toBeLessThan(
      source.indexOf('createMobileRouter({'),
    );
    expect(between('createMobileRouter({', 'pathLog: phonePathLog')).toMatch(
      /pairingTarget: createPairingTarget\(\{[^}]*probe: tailscaleProbe/s,
    );
  });
});
