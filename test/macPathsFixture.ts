// test/macPathsFixture.ts - AASC-60 Remote access, Task 7: the real cloud connection in front of a fake backend.
//
// The Mac-paths tests need the real transport in the loop for facts the publisher leans on: which cloud errors a 403 and a
// 404 become, what the device token is attached to, and that a saved connection reads `offline` until its first request.
// The backend is a fake `fetch`; nothing here touches the network.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { createCloudConnection } from '../server/cloud/connection.js';
import { createFileSecretStore } from '../server/cloud/secretStore.js';
import type { CloudConnector } from '../server/cloud/types.js';

export const OWNER = '00000000-0000-4000-8000-000000000001';
export const DEVICE = '00000000-0000-4000-8000-000000000002';
export const TOKEN = 't'.repeat(43);
export const ORIGIN = 'https://backend.example';

export interface BackendCall {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}
/** The backend's answer to its nth request (1-based), pairing excluded. */
type Answer = (call: BackendCall, nth: number) => Response | Promise<Response>;

export const accepted = (data: unknown): Response => Response.json({ success: true, data });
/** An error as the backend writes it, with text the Mac must never repeat. */
export const refused = (status: number, code: string): Response =>
  new Response(
    JSON.stringify({ success: false, error: { code, message: `SECRET backend text ${TOKEN}` } }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  );

/**
 * A connected cloud connector whose backend answers with `answer`. `reload()` is an AASC restart: the first connector stops
 * and a second one opens over the same saved connection.
 */
export async function macPathsBackend(answer: Answer, cleanups: Array<() => Promise<unknown>>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-mac-paths-')));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const calls: BackendCall[] = [];
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== ORIGIN) throw new Error('unexpected origin');
    if (url.pathname === '/v1/devices/pair') {
      return Response.json({
        success: true,
        data: { token: TOKEN, ownerId: OWNER, deviceId: DEVICE },
      });
    }
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get('authorization'),
    });
    return answer(calls[calls.length - 1]!, calls.length);
  });
  const open = async (): Promise<CloudConnector> => {
    const cloud = await createCloudConnection({
      directory: join(dir, 'cloud'),
      secrets: createFileSecretStore(join(dir, 'secrets')),
      fetch: fetcher as unknown as typeof fetch,
    });
    cleanups.push(() => cloud.stop());
    return cloud;
  };
  const cloud = await open();
  await cloud.connectCloud({
    backendUrl: ORIGIN,
    pairingCode: 'c'.repeat(22),
    deviceName: 'Kason MBP',
  });
  return {
    cloud,
    calls,
    async reload(): Promise<CloudConnector> {
      await cloud.stop();
      return open();
    },
  };
}
