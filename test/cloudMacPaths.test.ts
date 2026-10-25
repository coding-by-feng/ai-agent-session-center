// test/cloudMacPaths.test.ts - AASC-60 Remote access, Task 7: PUT /v1/mac-paths/self, the one thing this Mac tells its AASC
// Cloud account about itself.
//
// Only the Tailscale address and the port reach the cloud, and only to that one route. Everything is checked before a request
// is made, so a bad value never leaves the Mac; and what comes back is checked too. No network: the backend is a fake `fetch`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowedCloudRoute } from '../server/cloud/client.js';
import { publishMacPaths } from '../server/cloud/macPaths.js';
import { CloudError, type CloudClient } from '../server/cloud/types.js';
import { accepted, DEVICE, macPathsBackend, OWNER, refused, TOKEN } from './macPathsFixture.js';

const TAILNET = '100.101.102.103';
const PORT = 3334;
const UPDATED_AT = '2026-10-22T01:23:45.000Z';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const undo of cleanups.splice(0).reverse()) await undo();
});

/** A client that answers every request with `reply`, remembering what it was asked. */
function fakeClient(reply: unknown | (() => unknown) = { updatedAt: UPDATED_AT }) {
  const request = vi.fn(async () => (typeof reply === 'function' ? reply() : reply));
  return { client: { request } as unknown as CloudClient, request };
}

/** The error a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('the cloud route allow-list', () => {
  it('allows only PUT /v1/mac-paths/self for this Mac', () => {
    expect(allowedCloudRoute('PUT', '/v1/mac-paths/self')).toBe(true);
    expect(allowedCloudRoute('GET', '/v1/mac-paths')).toBe(false);
    expect(allowedCloudRoute('PUT', '/v1/mac-paths/other')).toBe(false);
  });

  it('allows nothing else under /v1/mac-paths: not another method, a longer path or a traversal', () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'HEAD']) {
      expect(allowedCloudRoute(method, '/v1/mac-paths/self')).toBe(false);
    }
    for (const path of [
      '/v1/mac-paths',
      '/v1/mac-paths/',
      '/v1/mac-paths/self/',
      '/v1/mac-paths/self/extra',
      '/v1/mac-paths/self#frag',
      '/v1/mac-paths/../devices/self',
      '/v1/mac-paths/%2e%2e/self',
      '/v1/mac-paths\\self',
    ]) {
      expect({ path, allowed: allowedCloudRoute('PUT', path) }).toEqual({ path, allowed: false });
    }
  });

  it('leaves the routes the cloud client already allowed as they were', () => {
    expect(allowedCloudRoute('GET', '/v1/resources')).toBe(true);
    expect(allowedCloudRoute('PUT', '/v1/resources')).toBe(false);
    expect(allowedCloudRoute('GET', '/v1/devices/pairing-codes')).toBe(true);
  });
});

describe('publishMacPaths', () => {
  it('sends exactly { tailnet, port } to PUT /v1/mac-paths/self', async () => {
    const { client, request } = fakeClient();
    await expect(publishMacPaths(client, { tailnet: TAILNET, port: PORT })).resolves.toEqual({
      updatedAt: UPDATED_AT,
    });
    expect(request).toHaveBeenCalledTimes(1);
    const [method, path, body] = request.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect([method, path]).toEqual(['PUT', '/v1/mac-paths/self']);
    expect(Object.keys(body)).toEqual(['tailnet', 'port']);
    expect(body).toEqual({ tailnet: TAILNET, port: PORT });
  });

  it('hands the abort signal to the request', async () => {
    const { client, request } = fakeClient();
    const { signal } = new AbortController();
    await publishMacPaths(client, { tailnet: TAILNET, port: PORT }, signal);
    expect((request.mock.calls[0] as unknown as unknown[])[3]).toBe(signal);
  });

  it('refuses anything but a Tailscale address before any request (the home address stays out of the cloud)', async () => {
    const addresses = [
      '192.168.1.2', // the home network
      '10.0.0.5',
      '127.0.0.1',
      '100.63.255.255', // just below 100.64.0.0/10
      '100.128.0.1', // just above it
      '100.064.001.001', // leading zeros: dialled as octal by a URL parser
      ' 100.101.102.103',
      '100.101.102.103 ',
      '100.101.102.103:3334',
      'http://100.101.102.103',
      'fd7a:115c:a1e0::1', // a Tailscale IPv6 address: phones dial the IPv4 one
      'kason-mbp.tail1234.ts.net', // the Mac's DNS name stays out too
      '',
    ];
    for (const tailnet of addresses) {
      const { client, request } = fakeClient();
      const err = await rejection(publishMacPaths(client, { tailnet, port: PORT }));
      expect({ tailnet, err }).toEqual({
        tailnet,
        err: expect.objectContaining({ code: 'invalid_input', status: 400 }),
      });
      expect(err).toBeInstanceOf(CloudError);
      expect(request).not.toHaveBeenCalled();
    }
  });

  it('refuses a port that is not a whole number from 1 to 65535 before any request', async () => {
    for (const port of [
      0,
      -1,
      65_536,
      3334.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '3334',
      null,
      undefined,
    ]) {
      const { client, request } = fakeClient();
      const err = await rejection(
        publishMacPaths(client, { tailnet: TAILNET, port } as unknown as {
          tailnet: string;
          port: number;
        }),
      );
      expect({ port, code: (err as CloudError).code }).toEqual({ port, code: 'invalid_input' });
      expect(request).not.toHaveBeenCalled();
    }
    // The edges are fine.
    const { client, request } = fakeClient();
    await publishMacPaths(client, { tailnet: TAILNET, port: 1 });
    await publishMacPaths(client, { tailnet: TAILNET, port: 65_535 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('refuses extra fields: a token or account name can never ride along', async () => {
    for (const extra of [
      { token: TOKEN },
      { account: 'kason@gmail.com' },
      { lan: '192.168.1.2' },
      { dnsName: 'kason-mbp.tail1234.ts.net' },
    ]) {
      const { client, request } = fakeClient();
      const err = await rejection(
        publishMacPaths(client, { tailnet: TAILNET, port: PORT, ...extra } as {
          tailnet: string;
          port: number;
        }),
      );
      expect((err as CloudError).code).toBe('invalid_input');
      expect(request).not.toHaveBeenCalled();
    }
    const { client, request } = fakeClient();
    for (const input of [null, undefined, 'x', 42, []]) {
      const err = await rejection(
        publishMacPaths(client, input as unknown as { tailnet: string; port: number }),
      );
      expect((err as CloudError).code).toBe('invalid_input');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('answers only { updatedAt }, dropping whatever else the backend adds', async () => {
    const { client } = fakeClient({ updatedAt: UPDATED_AT, deviceId: DEVICE, internal: 'detail' });
    expect(await publishMacPaths(client, { tailnet: TAILNET, port: PORT })).toEqual({
      updatedAt: UPDATED_AT,
    });
  });

  it('refuses an answer that is not { updatedAt: <ISO time> }', async () => {
    for (const answer of [
      undefined,
      null,
      {},
      [],
      'ok',
      5,
      { updatedAt: 5 },
      { updatedAt: null },
      { updatedAt: '' },
      { updatedAt: 'yesterday' },
    ]) {
      const { client } = fakeClient(() => answer);
      const err = await rejection(publishMacPaths(client, { tailnet: TAILNET, port: PORT }));
      expect({ answer, code: (err as CloudError).code }).toEqual({
        answer,
        code: 'invalid_response',
      });
    }
  });

  it("lets the cloud's own error through untouched", async () => {
    const failure = new CloudError(
      'offline',
      'Cloud is offline. Check the connection and try again.',
    );
    const { client } = fakeClient(() => {
      throw failure;
    });
    expect(await rejection(publishMacPaths(client, { tailnet: TAILNET, port: PORT }))).toBe(
      failure,
    );
  });
});

describe('over the real cloud connection', () => {
  it('sends the body to the one route with the device token as the only credential', async () => {
    const backend = await macPathsBackend(() => accepted({ updatedAt: UPDATED_AT }), cleanups);
    await expect(
      publishMacPaths(backend.cloud.client, { tailnet: TAILNET, port: PORT }),
    ).resolves.toEqual({ updatedAt: UPDATED_AT });
    expect(backend.calls).toEqual([
      {
        method: 'PUT',
        path: '/v1/mac-paths/self',
        body: { tailnet: TAILNET, port: PORT },
        auth: `Bearer ${TOKEN}`,
      },
    ]);
    // The account and device ids the Mac knows about itself are not in what it sends.
    const sent = JSON.stringify(backend.calls[0]!.body);
    for (const secret of [OWNER, DEVICE, TOKEN, 'Kason MBP']) expect(sent).not.toContain(secret);
  });

  it('a 403 reaches the caller as forbidden (403), without the backend text', async () => {
    const backend = await macPathsBackend(() => refused(403, 'forbidden'), cleanups);
    const err = await rejection(
      publishMacPaths(backend.cloud.client, { tailnet: TAILNET, port: PORT }),
    );
    expect(err).toBeInstanceOf(CloudError);
    expect(err).toMatchObject({ code: 'forbidden', status: 403 });
    expect((err as CloudError).message).not.toContain('SECRET');
  });

  it('a 404 with the standard not_found envelope reaches the caller as not_found (404)', async () => {
    const backend = await macPathsBackend(() => refused(404, 'not_found'), cleanups);
    const err = await rejection(
      publishMacPaths(backend.cloud.client, { tailnet: TAILNET, port: PORT }),
    );
    expect(err).toBeInstanceOf(CloudError);
    expect(err).toMatchObject({ code: 'not_found', status: 404 });
    expect((err as CloudError).message).not.toContain('SECRET');
  });

  it('an answer that is not { updatedAt } is invalid_response even from a 200', async () => {
    const backend = await macPathsBackend(() => accepted({ ok: true }), cleanups);
    const err = await rejection(
      publishMacPaths(backend.cloud.client, { tailnet: TAILNET, port: PORT }),
    );
    expect(err).toMatchObject({ code: 'invalid_response' });
  });
});
