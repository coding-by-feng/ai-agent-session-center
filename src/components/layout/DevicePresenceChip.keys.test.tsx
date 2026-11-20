// DevicePresenceChip.keys.test.tsx — Escape on the devices panel as it is WITHOUT the Switch part (a browser on this
// computer, another device, an app without the account channels), and that the `switchDevice` key means nothing
// there. The two-part panel's keys are in DevicePresenceChip.parts.cases.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import DevicePresenceChip from './DevicePresenceChip';
import { DEVICES_SWITCH_EVENT } from '@/lib/devicesSwitcher';
import { usePresenceStore } from '@/stores/presenceStore';
import type { DevicePresence } from '@/types';
import type { RemoteComputersAPI } from '@/types/electron';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'me' }));
vi.mock('@/lib/presenceClient', () => ({ releaseAllControls: vi.fn().mockResolvedValue({ ok: true, released: [] }) }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

function device(overrides: Partial<DevicePresence>): DevicePresence {
  return { clientId: 'me', label: 'MacBook Pro', address: '::1', isLocal: true, connections: 1, connectedAt: Date.now(), lastSeenAt: Date.now(), ...overrides };
}

beforeEach(() => {
  usePresenceStore.setState({ devices: [device({})], controllers: new Map() });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/config') return json(200, { localIP: '192.168.6.42', passwordEnabled: true });
    if (url === '/api/mobile/devices') return json(200, { success: true, data: { devices: [], pairingOffered: true } });
    if (url === '/api/mobile/cloud-phones') return json(200, { success: true, data: { cloud: false } });
    if (url === '/api/sharing-default') return json(200, { shareNewSessions: false });
    return json(404, { error: 'Not found' });
  }));
});

afterEach(() => {
  delete window.electronAPI;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const chip = () => screen.getByRole('button', { name: /devices? connected/ });
const dialog = () => screen.queryByRole('dialog', { name: 'Connected devices' });

async function openPanel(): Promise<HTMLElement> {
  fireEvent.click(chip());
  return screen.findByRole('dialog', { name: 'Connected devices' });
}

describe('DevicePresenceChip — Escape on the panel without the Switch part', () => {
  it('closes it and returns focus to the chip from inside the panel', async () => {
    render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
    const panel = await openPanel();
    const copy = await within(panel).findByRole('button', { name: 'Copy address' });
    copy.focus();
    fireEvent.keyDown(copy, { key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it('opening it moves no focus: there is no Switch part to go to', async () => {
    render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
    chip().focus();
    const panel = await openPanel();
    await within(panel).findByRole('button', { name: 'Copy address' });
    expect(document.activeElement).toBe(chip());
    expect(panel.hasAttribute('tabindex')).toBe(false);
  });

  it('is the panel’s alone: a listener on the window (the session panel’s) does not hear it', async () => {
    const heard: string[] = [];
    const listen = (e: KeyboardEvent) => heard.push(e.key);
    window.addEventListener('keydown', listen);
    try {
      render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
      await openPanel();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(dialog()).toBeNull();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(heard).toEqual(['Escape']);
    } finally {
      window.removeEventListener('keydown', listen);
    }
  });
});

describe('DevicePresenceChip — the switchDevice key without the Switch part', () => {
  const ask = () => fireEvent(document, new CustomEvent(DEVICES_SWITCH_EVENT));

  it('opens nothing in a browser on this computer', () => {
    render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
    ask();
    expect(dialog()).toBeNull();
  });

  it('opens nothing in an app whose main process has no account channels (a Client edition)', () => {
    window.electronAPI = { remotes: { list: vi.fn(() => Promise.resolve([])), check: vi.fn() } as unknown as RemoteComputersAPI } as typeof window.electronAPI;
    render(<MemoryRouter><DevicePresenceChip /></MemoryRouter>);
    ask();
    expect(dialog()).toBeNull();
  });

  it('a chip-less host draws nothing there, whatever asks', () => {
    const { container } = render(<MemoryRouter><DevicePresenceChip chipless /></MemoryRouter>);
    ask();
    expect(dialog()).toBeNull();
    expect(container.innerHTML).toBe('');
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});
