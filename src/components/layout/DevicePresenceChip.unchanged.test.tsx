// DevicePresenceChip.switcher.test.tsx — the devices panel's two parts (plan 18 stage 2, Nov 20 2026).
//
// With the account channels (`electronAPI.remotes.accountMachines`) on this computer's desktop app, the panel
// shows Switch and This computer. Everywhere else it is the panel it was: the three "unchanged" snapshots below
// were recorded on the code from before the switcher, and must never need re-recording for a switcher change.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import DevicePresenceChip from './DevicePresenceChip';
import { usePresenceStore } from '@/stores/presenceStore';
import type { DevicePresence } from '@/types';
import type { AccountDirectory, RemoteComputer, RemoteComputersAPI, RemoteResult } from '@/types/electron';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'me' }));
vi.mock('@/lib/presenceClient', () => ({ releaseAllControls: vi.fn().mockResolvedValue({ ok: true, released: [] }) }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const SETTINGS_URL = '/api/resources/cloud/machines/settings';

function device(overrides: Partial<DevicePresence>): DevicePresence {
  // A fixed time well in the past would read "5h ago" and drift; "now" always reads "just now".
  return { clientId: 'me', label: 'MacBook Pro', address: '::1', isLocal: true, connections: 1, connectedAt: Date.now(), lastSeenAt: Date.now(), ...overrides };
}

function seed(devices: DevicePresence[]): void {
  usePresenceStore.setState({ devices, controllers: new Map() });
}

const SETTINGS = {
  showOnAccount: true,
  addresses: { lan: true, tailnet: true, public: false },
  computerEnroll: 'ask',
  pinned: { showOnAccount: false, computerEnroll: false },
  publisher: { state: 'published', published: { lan: '192.168.1.57', tailnet: null, public: null, port: 3333 } },
};

let fetched: string[];

function stubFetch(): void {
  fetched = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/config') return json(200, { localIP: '192.168.6.42', passwordEnabled: true });
    if (url === '/api/mobile/devices') return json(200, { success: true, data: { devices: [], pairingOffered: true } });
    if (url === '/api/mobile/cloud-phones') return json(200, { success: true, data: { cloud: false } });
    if (url === '/api/sharing-default') return json(200, { shareNewSessions: false });
    if (url === SETTINGS_URL) return json(200, { success: true, data: SETTINGS });
    return json(404, { error: 'Not found' });
  }));
}

const linked: RemoteComputer = {
  id: 'r1', name: 'Old NUC', lan: '192.168.4.20', tailnet: null, port: 3333, status: 'active', confirmCode: null,
  addedAt: 0, lastSeenAt: null, origin: 'link',
};

function ok<T>(data: T): Promise<RemoteResult<T>> {
  return Promise.resolve({ ok: true, data });
}

/** The API of an app from before the account channels, and of a Client edition: no `accountMachines`. */
function linkOnlyApi(): RemoteComputersAPI {
  return {
    list: vi.fn(() => Promise.resolve([linked])),
    check: vi.fn(() => ok({ state: 'online' as const, via: 'tailnet' as const, sharedSessions: 12, message: null })),
    add: vi.fn(),
    open: vi.fn(() => ok(null)),
    remove: vi.fn(),
    rename: vi.fn(),
  };
}

const DIRECTORY: AccountDirectory = {
  state: 'ok',
  machines: [
    {
      deviceId: 'd-here', name: 'MacBook Pro', platform: 'macos', edition: 'full', appVersion: '2.11.0', lastUsedAt: 1,
      current: true, connectable: true, relation: 'self', addresses: null, record: null,
    },
    {
      deviceId: 'd-mini', name: 'Mac mini', platform: 'macos', edition: 'full', appVersion: '2.11.0', lastUsedAt: 1,
      current: false, connectable: true, relation: 'self', addresses: { lan: '192.168.4.30', tailnet: null, publicAddress: null, port: 3333 },
      record: null,
    },
  ],
};

function accountApi(): RemoteComputersAPI {
  return {
    ...linkOnlyApi(),
    accountMachines: vi.fn(() => ok(DIRECTORY)),
    accountConnect: vi.fn(),
  };
}

/** One tag per line, so a failed snapshot shows which element changed. */
function pretty(html: string): string {
  return html.replace(/></g, '>\n<');
}

async function openPanel(): Promise<HTMLElement> {
  render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button'));
  const panel = await screen.findByRole('dialog', { name: 'Connected devices' });
  await within(panel).findByText(/^http:\/\/192\.168\.6\.42/);
  // The panel's own box is not in its innerHTML: its width is pinned here.
  expect(panel.style.width).toBe('320px');
  return panel;
}

beforeEach(() => {
  seed([device({})]);
  stubFetch();
});

afterEach(() => {
  delete window.electronAPI;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('DevicePresenceChip — the panel is unchanged without the account channels', () => {
  it('in a browser on this computer', async () => {
    const panel = await openPanel();
    await within(panel).findByText('No phones or computers paired.');
    await waitFor(() => expect((within(panel).getByRole('switch') as HTMLInputElement).disabled).toBe(false));
    expect(within(panel).queryByRole('tablist')).toBeNull();
    expect(fetched).not.toContain(SETTINGS_URL);
    expect(pretty(panel.innerHTML)).toMatchInlineSnapshot(`
      "<section class="_section_df707b" aria-label="Sharing">
      <span class="_title_df707b">Sharing</span>
      <label class="_row_df707b">
      <input role="switch" class="_switch_df707b" aria-label="Share new sessions with my devices" type="checkbox">
      <span class="_label_df707b">Share new sessions with my devices</span>
      </label>
      <p class="_hint_df707b">New sessions show on your phones and other signed-in devices at once. 📡 on a session still hides it.</p>
      <div>
      <button type="button" class="_button_d410bc _sm_d410bc">Share all open sessions now</button>
      </div>
      </section>
      <section class="_section_4ee228" aria-label="Paired phones and computers">
      <div class="_head_4ee228">
      <span class="_title_4ee228">Phones &amp; computers</span>
      <button type="button" class="_button_d410bc _sm_d410bc">Pair a phone or computer</button>
      </div>
      <p class="_empty_4ee228">No phones or computers paired.</p>
      </section>
      <div class="_panelHead_42e01d">Connected devices</div>
      <ul class="_deviceList_42e01d">
      <li class="_device_42e01d">
      <span class="_deviceIcon_42e01d">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-kind="computer">
      <rect x="2" y="3" width="12" height="8" rx="1">
      </rect>
      <path d="M6 14h4M8 11v3">
      </path>
      </svg>
      </span>
      <span class="_deviceMain_42e01d">
      <span class="_deviceLabel_42e01d">
      <span class="_deviceName_42e01d" title="MacBook Pro">MacBook Pro</span>
      <span class="_youTag_42e01d">this device</span>
      </span>
      <span class="_deviceMeta_42e01d">watching only · joined just now</span>
      <span class="_deviceAddress_42e01d">127.0.0.1</span>
      </span>
      </li>
      </ul>
      <p class="_explainer_42e01d">Everyone sees every session live. Only the device driving a session can type into it — open a session to take over.</p>
      <div class="_networkInfo_42e01d">
      <span class="_networkLabel_42e01d">Connect a phone at</span>
      <span class="_networkRow_42e01d">
      <span class="_networkUrl_42e01d">http://192.168.6.42:3000</span>
      <button type="button" class="_copyBtn_42e01d" title="Copy address" aria-label="Copy address">⧉</button>
      </span>
      </div>"
    `);
  });

  it('in a desktop app whose remotes API has no accountMachines (an older app, a Client edition)', async () => {
    const api = linkOnlyApi();
    window.electronAPI = { remotes: api } as unknown as typeof window.electronAPI;
    const panel = await openPanel();
    await within(panel).findByText('No phones or computers paired.');
    await within(panel).findByText('Online · Tailscale · 12 shared');
    await waitFor(() => expect((within(panel).getByRole('switch') as HTMLInputElement).disabled).toBe(false));
    expect(within(panel).queryByRole('tablist')).toBeNull();
    expect(within(panel).queryByText('My computers')).toBeNull();
    expect(fetched).not.toContain(SETTINGS_URL);
    expect(pretty(panel.innerHTML)).toMatchInlineSnapshot(`
      "<section class="_section_df707b" aria-label="Sharing">
      <span class="_title_df707b">Sharing</span>
      <label class="_row_df707b">
      <input role="switch" class="_switch_df707b" aria-label="Share new sessions with my devices" type="checkbox">
      <span class="_label_df707b">Share new sessions with my devices</span>
      </label>
      <p class="_hint_df707b">New sessions show on your phones and other signed-in devices at once. 📡 on a session still hides it.</p>
      <div>
      <button type="button" class="_button_d410bc _sm_d410bc">Share all open sessions now</button>
      </div>
      </section>
      <section class="_section_4ee228" aria-label="Paired phones and computers">
      <div class="_head_4ee228">
      <span class="_title_4ee228">Phones &amp; computers</span>
      <button type="button" class="_button_d410bc _sm_d410bc">Pair a phone or computer</button>
      </div>
      <p class="_empty_4ee228">No phones or computers paired.</p>
      </section>
      <section class="_section_7f2149" aria-label="Remote computers">
      <div class="_head_7f2149">
      <span class="_title_7f2149">Remote computers</span>
      <button type="button" class="_button_d410bc _sm_d410bc">+ Add a computer</button>
      </div>
      <ul class="_list_7f2149">
      <li class="_row_7f2149">
      <span class="_top_7f2149">
      <span class="_dot_7f2149 _online_7f2149" aria-hidden="true">
      </span>
      <span class="_name_7f2149" title="Old NUC">Old NUC</span>
      <span class="_rowActions_7f2149">
      <button aria-label="Open Old NUC" type="button" class="_button_d410bc _primary_d410bc _sm_d410bc">Open</button>
      <div class="_wrap_bbffea">
      <span class="_trigger_95283f">
      <button aria-haspopup="menu" aria-expanded="false" type="button" class="_iconButton_d410bc _iconSm_d410bc" aria-label="More for Old NUC">
      <span aria-hidden="true">⋯</span>
      </button>
      </span>
      </div>
      </span>
      </span>
      <span class="_meta_7f2149">Online · Tailscale · 12 shared</span>
      </li>
      </ul>
      </section>
      <div class="_panelHead_42e01d">Connected devices</div>
      <ul class="_deviceList_42e01d">
      <li class="_device_42e01d">
      <span class="_deviceIcon_42e01d">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-kind="computer">
      <rect x="2" y="3" width="12" height="8" rx="1">
      </rect>
      <path d="M6 14h4M8 11v3">
      </path>
      </svg>
      </span>
      <span class="_deviceMain_42e01d">
      <span class="_deviceLabel_42e01d">
      <span class="_deviceName_42e01d" title="MacBook Pro">MacBook Pro</span>
      <span class="_youTag_42e01d">this device</span>
      </span>
      <span class="_deviceMeta_42e01d">watching only · joined just now</span>
      <span class="_deviceAddress_42e01d">127.0.0.1</span>
      </span>
      </li>
      </ul>
      <p class="_explainer_42e01d">Everyone sees every session live. Only the device driving a session can type into it — open a session to take over.</p>
      <div class="_networkInfo_42e01d">
      <span class="_networkLabel_42e01d">Connect a phone at</span>
      <span class="_networkRow_42e01d">
      <span class="_networkUrl_42e01d">http://192.168.6.42:3000</span>
      <button type="button" class="_copyBtn_42e01d" title="Copy address" aria-label="Copy address">⧉</button>
      </span>
      </div>"
    `);
  });

  it('on another device, even one whose app has the account channels', async () => {
    window.electronAPI = { remotes: accountApi() } as unknown as typeof window.electronAPI;
    seed([device({ isLocal: false, address: '192.168.6.50' })]);
    const panel = await openPanel();
    expect(within(panel).queryByRole('tablist')).toBeNull();
    expect(window.electronAPI?.remotes?.accountMachines).not.toHaveBeenCalled();
    expect(fetched).not.toContain(SETTINGS_URL);
    expect(pretty(panel.innerHTML)).toMatchInlineSnapshot(`
      "<div class="_panelHead_42e01d">Connected devices</div>
      <ul class="_deviceList_42e01d">
      <li class="_device_42e01d">
      <span class="_deviceIcon_42e01d">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-kind="computer">
      <rect x="2" y="3" width="12" height="8" rx="1">
      </rect>
      <path d="M6 14h4M8 11v3">
      </path>
      </svg>
      </span>
      <span class="_deviceMain_42e01d">
      <span class="_deviceLabel_42e01d">
      <span class="_deviceName_42e01d" title="MacBook Pro">MacBook Pro</span>
      <span class="_youTag_42e01d">this device</span>
      </span>
      <span class="_deviceMeta_42e01d">watching only · joined just now</span>
      <span class="_deviceAddress_42e01d">192.168.6.50</span>
      </span>
      </li>
      </ul>
      <p class="_explainer_42e01d">Everyone sees every session live. Only the device driving a session can type into it — open a session to take over.</p>
      <div class="_networkInfo_42e01d">
      <span class="_networkLabel_42e01d">Connect a phone at</span>
      <span class="_networkRow_42e01d">
      <span class="_networkUrl_42e01d">http://192.168.6.42:3000</span>
      <button type="button" class="_copyBtn_42e01d" title="Copy address" aria-label="Copy address">⧉</button>
      </span>
      </div>"
    `);
  });
});
