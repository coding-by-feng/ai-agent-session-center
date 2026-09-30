// NavBar.test.tsx — which route tabs a device gets.
//
// RESOURCES lists everything in ~/.claude, ~/.codex and ~/.agents, and its
// /api/resources routes answer loopback requests only. So the tab is shown
// only when the SERVER has confirmed this device is local (presence
// `isLocal`) — never inferred from screen size or `electronAPI`, because a
// desktop browser on the LAN is remote too. Before presence arrives the tab is
// hidden: the absent state is the safe state.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { DevicePresence } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({
  getClientId: () => 'me',
  getClientLabel: () => 'Test Device',
}));

// The recent-directories launcher fetches and reads stores of its own; this
// suite is about the route tabs only.
vi.mock('./WorkdirLauncher', () => ({ default: () => null }));

import NavBar from './NavBar';
import { usePresenceStore } from '@/stores/presenceStore';

function device(clientId: string, isLocal: boolean): DevicePresence {
  return {
    clientId,
    label: clientId,
    address: isLocal ? '127.0.0.1' : '192.168.1.20',
    isLocal,
    connections: 1,
    connectedAt: 1,
    lastSeenAt: 1,
  };
}

function setDevices(devices: DevicePresence[]): void {
  usePresenceStore.getState().applyPresence({
    devices,
    controllers: [],
    restoreOwner: null,
    workspaceWriter: null,
  });
}

function renderNav(): void {
  render(
    <MemoryRouter initialEntries={['/']}>
      <NavBar />
    </MemoryRouter>,
  );
}

function tabLabels(): string[] {
  return screen.getAllByRole('link').map((a) => a.textContent ?? '');
}

beforeEach(() => {
  setDevices([]);
});

describe('NavBar — RESOURCES tab', () => {
  it('is hidden until presence confirms this device is local', () => {
    renderNav();
    expect(screen.queryByRole('link', { name: 'RESOURCES' })).toBeNull();
  });

  it('is shown on a local device, last in the row, linking to /resources', () => {
    setDevices([device('me', true)]);
    renderNav();

    const link = screen.getByRole('link', { name: 'RESOURCES' });
    expect(link.getAttribute('href')).toBe('/resources');
    expect(tabLabels()).toEqual(['LIVE', 'AGENDA', 'HISTORY', 'PROMPTS', 'QUEUE', 'REVIEW', 'RESOURCES']);
  });

  it('is hidden on a remote device even while the desktop is connected locally', () => {
    setDevices([device('desktop', true), device('me', false)]);
    renderNav();
    expect(screen.queryByRole('link', { name: 'RESOURCES' })).toBeNull();
  });

  it('leaves every existing tab in place for a remote device', () => {
    setDevices([device('me', false)]);
    renderNav();
    expect(tabLabels()).toEqual(['LIVE', 'AGENDA', 'HISTORY', 'PROMPTS', 'QUEUE', 'REVIEW']);
  });
});
