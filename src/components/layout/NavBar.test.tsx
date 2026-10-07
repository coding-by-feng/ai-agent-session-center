// NavBar.test.tsx — which route tabs a device gets.
//
// RESOURCES lists everything in ~/.claude, ~/.codex and ~/.agents, and its
// /api/resources routes answer loopback requests only. So the tab is shown
// only when the SERVER has confirmed this device is local (presence
// `isLocal`) — never inferred from screen size or `electronAPI`, because a
// desktop browser on the LAN is remote too. Before presence arrives the tab is
// hidden: the absent state is the safe state.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { AgendaTask, DevicePresence } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({
  getClientId: () => 'me',
  getClientLabel: () => 'Test Device',
}));

import NavBar from './NavBar';
import { usePresenceStore } from '@/stores/presenceStore';
import { useAgendaStore } from '@/stores/agendaStore';

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

// The AGENDA count is a CountBadge: digits for the eye, "N open tasks" for a
// screen reader, and the tab's visible label stays exactly "AGENDA".
describe('NavBar — AGENDA count', () => {
  function task(id: string, completed: boolean): AgendaTask {
    return {
      id, title: id, priority: 'medium', tags: [], completed,
      createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z',
    };
  }

  afterEach(() => {
    useAgendaStore.setState({ tasks: new Map() });
  });

  it('counts only open tasks and names them for a screen reader', () => {
    useAgendaStore.setState({
      tasks: new Map([['a', task('a', false)], ['b', task('b', false)], ['c', task('c', true)]]),
    });
    renderNav();
    expect(screen.getByRole('link', { name: /AGENDA\s*2 open tasks/ })).toBeTruthy();
    expect(screen.getByText('2').getAttribute('aria-hidden')).toBe('true');
  });

  it('shows no badge when everything is done', () => {
    useAgendaStore.setState({ tasks: new Map([['c', task('c', true)]]) });
    renderNav();
    expect(screen.getByRole('link', { name: 'AGENDA' })).toBeTruthy();
  });
});

// Starting a session lives in the session panel's strip (+ and the recent-
// directories icon) and, with no session yet, on the LIVE page's card. The top
// bar's + NEW and DIRS duplicated the strip's and were removed (Oct 2026).
describe('NavBar — no session launchers', () => {
  it('has no + NEW or DIRS: the top bar is the route tabs', () => {
    setDevices([device('me', true)]);
    renderNav();
    expect(screen.queryByRole('button', { name: '+ NEW' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^DIRS$|recent (working )?directories/i })).toBeNull();
    expect(screen.queryByText('+ NEW')).toBeNull();
    expect(screen.queryByText('DIRS')).toBeNull();
  });
});
