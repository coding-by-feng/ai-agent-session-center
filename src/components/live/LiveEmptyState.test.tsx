// LiveEmptyState.test.tsx — the 3D-off LIVE page on a desktop before the user
// has any session: what it is for and three ways to get one. Each button is
// the SAME action as the top-bar control it is named after, so the card also
// teaches where those controls live.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'me', getClientLabel: () => 'Test Device' }));

import LiveEmptyState from './LiveEmptyState';
import { useUiStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useWsStore } from '@/stores/wsStore';

const device = (isLocal: boolean) => ({
  clientId: 'me', label: 'Test Device', address: isLocal ? '127.0.0.1' : '192.168.1.20', isLocal,
  connections: 1, connectedAt: 1, lastSeenAt: 1,
});

beforeEach(() => {
  useUiStore.setState({ activeModal: null, workdirLauncherOpen: false });
  usePresenceStore.setState({ devices: [device(true)] } as never);
  useWsStore.setState({ hiddenCount: 0 });
});

describe('LiveEmptyState', () => {
  it('says there are no sessions yet, as a heading', () => {
    render(<LiveEmptyState />);
    expect(screen.getByRole('heading', { name: /No agent sessions yet/i })).toBeInTheDocument();
  });

  it('+ NEW opens the new-session form, like the top bar', () => {
    render(<LiveEmptyState />);
    fireEvent.click(screen.getByRole('button', { name: '+ NEW' }));
    expect(useUiStore.getState().activeModal).toBe('new-session');
  });

  it('DIRS opens the recent-directories launcher in the top bar', () => {
    render(<LiveEmptyState />);
    fireEvent.click(screen.getByRole('button', { name: 'DIRS' }));
    expect(useUiStore.getState().workdirLauncherOpen).toBe(true);
  });

  it('explains that a claude started in any terminal shows up by itself', () => {
    render(<LiveEmptyState />);
    // Claude only: Codex hooks are not installed by default (enabledClis
    // defaults to ['claude']) and the process scan finds `claude` only, so
    // promising it for `codex` would be false on a fresh install.
    expect(screen.getByText('claude')).toBeInTheDocument();
    expect(screen.getByText(/any terminal/i)).toBeInTheDocument();
    expect(screen.queryByText('codex')).toBeNull();
  });

  it('offers the 3D office and turns it on', () => {
    let turnedOn: boolean | null = null;
    const real = useSettingsStore.getState().setScene3dEnabled;
    useSettingsStore.setState({ setScene3dEnabled: (on: boolean) => { turnedOn = on; } } as never);
    try {
      render(<LiveEmptyState />);
      fireEvent.click(screen.getByRole('button', { name: /Turn on 3D/i }));
      expect(turnedOn).toBe(true);
    } finally {
      useSettingsStore.setState({ setScene3dEnabled: real } as never);
    }
  });
});

// A device that is not this machine (a phone or LAN browser) only sees sessions
// someone shared with it (server/sessionVisibility.ts), and sessions it starts
// stay hidden from it too. The usual copy ("every session you start here gets a
// card", "it shows up here by itself") would be false there.
describe('LiveEmptyState on a device that is not this machine', () => {
  it('says nothing is shared with it, instead of promising cards', () => {
    usePresenceStore.setState({ devices: [device(false)] } as never);
    render(<LiveEmptyState />);
    expect(screen.getByRole('heading', { name: /No sessions shared with this device/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ NEW' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'DIRS' })).toBeNull();
    expect(screen.queryByText(/shows up here by itself/i)).toBeNull();
  });

  it('counts the sessions the host is keeping from it', () => {
    usePresenceStore.setState({ devices: [device(false)] } as never);
    useWsStore.setState({ hiddenCount: 3 });
    render(<LiveEmptyState />);
    expect(screen.getByText(/3 sessions are running on the host but not shared with this device/i)).toBeInTheDocument();
  });

  it('a hidden count alone is enough to tell, before presence has loaded', () => {
    usePresenceStore.setState({ devices: [] } as never);
    useWsStore.setState({ hiddenCount: 1 });
    render(<LiveEmptyState />);
    expect(screen.getByText(/1 session is running on the host but not shared with this device/i)).toBeInTheDocument();
  });

  it('this machine, or presence not loaded with nothing hidden, gets the normal card', () => {
    usePresenceStore.setState({ devices: [] } as never);
    render(<LiveEmptyState />);
    expect(screen.getByRole('heading', { name: /No agent sessions yet/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ NEW' })).toBeInTheDocument();
  });
});
