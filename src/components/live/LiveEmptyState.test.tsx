// LiveEmptyState.test.tsx — the LIVE page on a desktop before the user has any
// session: what it is for and three ways to get one. With no session there is
// no session panel, and so none of the strip's launch icons: this card is the
// only place in the app to start one (the top bar's + NEW / DIRS were removed).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'me', getClientLabel: () => 'Test Device' }));
// DIRS is a real recent-directories launcher; give it one known project.
const { KNOWN } = vi.hoisted(() => ({ KNOWN: ['/Users/me/agent-manager'] }));
vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => KNOWN }));

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
  useUiStore.setState({ activeModal: null });
  useSettingsStore.setState({ scene3dEnabled: false } as never);
  usePresenceStore.setState({ devices: [device(true)] } as never);
  useWsStore.setState({ hiddenCount: 0 });
});

describe('LiveEmptyState', () => {
  it('says there are no sessions yet, as a heading', () => {
    render(<LiveEmptyState />);
    expect(screen.getByRole('heading', { name: /No agent sessions yet/i })).toBeInTheDocument();
  });

  it('+ NEW opens the new-session form', () => {
    render(<LiveEmptyState />);
    fireEvent.click(screen.getByRole('button', { name: '+ NEW' }));
    expect(useUiStore.getState().activeModal).toBe('new-session');
  });

  // It used to open the top bar's DIRS menu; that copy is gone, so a button
  // that only asked for it would now do nothing at all.
  it('DIRS opens a recent-directories menu of its own, ready to launch', () => {
    render(<LiveEmptyState />);
    const dirs = screen.getByRole('button', { name: 'DIRS' });
    expect(dirs).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(dirs);
    expect(dirs).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Recent Directories')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Launch Claude in agent-manager' })).toBeInTheDocument();
  });

  it('DIRS keeps the look of the card\'s other button', () => {
    render(<LiveEmptyState />);
    expect(screen.getByRole('button', { name: 'DIRS' }).className)
      .toBe(screen.getByRole('button', { name: '+ NEW' }).className);
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

  // With the 3D scene on, the card sits over the empty scene (LiveView): an
  // offer to turn on what is already on would be nonsense.
  it('with 3D already on, still offers both ways to start, but not "Turn on 3D"', () => {
    useSettingsStore.setState({ scene3dEnabled: true } as never);
    render(<LiveEmptyState />);
    expect(screen.getByRole('button', { name: '+ NEW' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'DIRS' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Turn on 3D/i })).toBeNull();
  });
});

// Over the 3D scene the card shows while the office has no robot. A robot is
// drawn only for a session the dashboard launched, so a claude started in a
// terminal elsewhere is listed but never appears here: the card must not
// promise that it will, and must say where such sessions are.
describe('LiveEmptyState over the 3D scene', () => {
  beforeEach(() => useSettingsStore.setState({ scene3dEnabled: true } as never));

  it('names the office and offers the two ways to put a session in it', () => {
    render(<LiveEmptyState overScene />);
    expect(screen.getByRole('heading', { name: /No sessions in the 3D office yet/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ NEW' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'DIRS' })).toBeInTheDocument();
    expect(screen.queryByText(/any terminal/i)).toBeNull();
    expect(screen.queryByText(/outside the dashboard/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Turn on 3D/i })).toBeNull();
  });

  it('says how many sessions run outside the dashboard and how to open one', () => {
    const { rerender } = render(<LiveEmptyState overScene outsideCount={1} />);
    expect(screen.getByText(/1 session is running outside the dashboard/i)).toHaveTextContent(/press LIVE to open one/i);
    rerender(<LiveEmptyState overScene outsideCount={3} />);
    expect(screen.getByText(/3 sessions are running outside the dashboard/i)).toBeInTheDocument();
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

  // The card points at the button the host really has: it reads HOST ONLY
  // (SHARED once pressed). It used to say "the 📡 button", which no longer exists.
  it('tells the user which button on the host shares a session', () => {
    usePresenceStore.setState({ devices: [device(false)] } as never);
    render(<LiveEmptyState />);
    expect(screen.getByText(/HOST ONLY button in its session panel/)).toHaveTextContent(/SHARED/);
    expect(screen.queryByText(/📡/)).toBeNull();
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
