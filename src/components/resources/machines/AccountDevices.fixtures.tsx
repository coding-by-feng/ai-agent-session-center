// AccountDevices.fixtures.tsx — a fake of this computer's cloud routes for the "Devices on your account" tests:
// the connection status the RESOURCES tab reads, the device list, and signing a device out.
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { CloudHarness } from '@/__tests__/cloudHarness';
import type { AccountDevice } from '@/lib/cloudApi';
import type { CloudStatus } from '@/types/cloud';
import AccountDevices from './AccountDevices';

export const DEVICES_URL = '/api/resources/cloud/account/devices';

export const CONNECTION = {
  backendOrigin: 'https://cloud.example',
  accountId: 'd23c54de-1b99-4802-87bf-d84ddba2fdf1',
  deviceId: '0b6f6a6e-3f0c-4c53-9d0e-5a0a3f1f2c11',
  deviceName: 'MacBook Pro',
  generation: 7,
  accountEmail: 'me@example.com',
};

const HOUR = 3_600_000;

export function device(over: Partial<AccountDevice>): AccountDevice {
  return {
    // `server` is the account's kind for every AASC computer (server/cloud/devices.ts).
    id: 'dev-mini', name: 'Mac mini', kind: 'server', platform: 'macos', edition: 'full', appVersion: '2.10.80',
    createdAt: Date.now() - 30 * 24 * HOUR, lastUsedAt: Date.now() - 2 * HOUR, current: false, ...over,
  };
}

export const here = () => device({ id: 'dev-here', name: 'MacBook Pro', current: true, lastUsedAt: Date.now() - 20_000 });
export const mini = () => device({});
export const phone = () => device({ id: 'dev-phone', name: 'Kason’s iPhone', kind: 'phone', platform: 'ios', edition: null, appVersion: '1.1.0', lastUsedAt: null });

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const refusal = (status: number, code: string, message: string) => json(status, { success: false, error: { code, message } });

export interface Call { method: string; url: string; headers: Record<string, string>; body: string | undefined }

/** The fake server; a test changes `devices` or replaces an answer to choose what comes next. */
export interface FakeCloud {
  /** What the connection status says; `none` is a computer not signed in to AASC Cloud. */
  state: CloudStatus['state'] | 'none';
  /** The connection the status names: a test changes it to stand for a sign-in from another window. */
  connection: typeof CONNECTION;
  devices: AccountDevice[];
  /** The list's answer; by default the devices as they stand. */
  onList: () => Response | Promise<Response>;
  /** A sign-out's answer; by default the device goes. */
  onSignOut: (id: string) => Response | Promise<Response>;
  calls: Call[];
  lists: () => Call[];
  signOuts: () => Call[];
}

/** Call in `beforeEach`. */
export function installCloud(): FakeCloud {
  const cloud: FakeCloud = {
    state: 'connected',
    connection: CONNECTION,
    devices: [here(), mini(), phone()],
    onList: () => json(200, { success: true, data: { devices: cloud.devices } }),
    onSignOut: (id) => {
      cloud.devices = cloud.devices.filter((d) => d.id !== id);
      return json(200, { success: true, data: { revoked: true } });
    },
    calls: [],
    lists: () => cloud.calls.filter((c) => c.method === 'GET' && c.url === DEVICES_URL),
    signOuts: () => cloud.calls.filter((c) => c.method === 'DELETE'),
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    cloud.calls.push({ method, url, headers, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url === '/api/resources/cloud/status') {
      const connected = cloud.state !== 'none';
      return json(200, { success: true, data: { connection: connected ? cloud.connection : null, state: connected ? cloud.state : 'disconnected', lastError: null } });
    }
    if (url === DEVICES_URL && method === 'GET') return cloud.onList();
    if (url.startsWith(`${DEVICES_URL}/`) && method === 'DELETE') return cloud.onSignOut(decodeURIComponent(url.slice(DEVICES_URL.length + 1)));
    return json(404, { success: false, error: { code: 'not_found', message: 'Not found' } });
  }));
  return cloud;
}

/** The section inside the cloud session RESOURCES provides, as MachinesPanel mounts it. */
export function showDevices({ open = true, onAccount = vi.fn() }: { open?: boolean; onAccount?: () => void } = {}) {
  const tree = (isOpen: boolean) => (
    <CloudHarness>
      <AccountDevices open={isOpen} onAccount={onAccount} />
    </CloudHarness>
  );
  const view = render(tree(open));
  return { ...view, onAccount, setOpen: (isOpen: boolean) => view.rerender(tree(isOpen)) };
}
