// DevicesSwitcher.counts.test.tsx — "needs you" in the Switch part (plan 18 §5.4): how many sessions wait for an
// approval or an answer, on another computer's row (from its check) and on this computer's (from the session store).
import { Profiler } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session, SessionStatus } from '@/types';
import DevicesSwitcher from './DevicesSwitcher';
import { HERE, directoryOf, installWorld, linked, machine, offline, online, record, renderSwitcher, type World } from './DevicesSwitcher.fixtures';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

let world: World;

function session(sessionId: string, status: SessionStatus, over: Partial<Session> = {}): Session {
  return { sessionId, status, title: sessionId, projectName: 'p', lastActivityAt: 1, ...over } as Session;
}

function seed(...sessions: Session[]): void {
  useSessionStore.setState({ sessions: new Map(sessions.map((s) => [s.sessionId, s])) });
}

beforeEach(() => {
  world = installWorld();
  seed();
});

afterEach(() => {
  delete window.electronAPI;
  seed();
  vi.clearAllMocks();
});

const here = () => screen.findByRole('region', { name: 'This computer' });

describe('DevicesSwitcher — another computer’s row', () => {
  it('ends an online row’s second line with how many sessions need the person', async () => {
    world.directory = directoryOf(HERE, machine({}), machine({ deviceId: 'd-vps', name: 'VPS' }));
    world.stored = [record({}), record({ id: 'r-vps', name: 'VPS', backendDeviceId: 'd-vps' }), linked()];
    world.answers = {
      'r-mini': online({ needsYou: 2 }),
      'r-vps': online({ via: 'lan', sharedSessions: 1, needsYou: 1 }),
      'r-nuc': online({ via: 'https', sharedSessions: 7, needsYou: 3 }),
    };
    renderSwitcher();
    expect(await screen.findByText('Online · Tailscale · 4 shared · 2 need you')).toBeTruthy();
    expect(screen.getByText('Online · Home network · 1 shared · 1 needs you')).toBeTruthy();
    // A computer paired by link says it the same way.
    expect(screen.getByText('Online · Secure HTTPS · 7 shared · 3 need you')).toBeTruthy();
  });

  it('adds nothing for none, for an unknown count, or for a row that is not online', async () => {
    world.directory = directoryOf(HERE, machine({}), machine({ deviceId: 'd-vps', name: 'VPS' }), machine({ deviceId: 'd-imac', name: 'Studio iMac' }));
    world.stored = [
      record({}),
      record({ id: 'r-vps', name: 'VPS', backendDeviceId: 'd-vps' }),
      record({ id: 'r-imac', name: 'Studio iMac', backendDeviceId: 'd-imac' }),
    ];
    world.answers = { 'r-mini': online({ needsYou: 0 }), 'r-vps': online({ needsYou: null }), 'r-imac': { ...offline(), needsYou: 4 } };
    renderSwitcher();
    await waitFor(() => expect(screen.getAllByText('Online · Tailscale · 4 shared')).toHaveLength(2));
    expect(screen.getByText('Offline')).toBeTruthy();
    expect(screen.queryByText(/need you|needs you/)).toBeNull();
  });
});

describe('DevicesSwitcher — this computer’s row', () => {
  it('has a second line with its sessions and how many need the person', async () => {
    seed(session('a', 'working'), session('b', 'approval'), session('c', 'input'), session('d', 'idle'), session('e', 'waiting'));
    renderSwitcher();
    const row = within(await here());
    expect(row.getByText('MacBook Pro')).toBeTruthy();
    expect(row.getByText('here')).toBeTruthy();
    expect(row.getByText('5 sessions · 2 need you')).toBeTruthy();
  });

  it('says "1 needs you" for one, and nothing after the count for none', async () => {
    seed(session('a', 'approval'));
    const view = renderSwitcher();
    expect(within(await here()).getByText('1 session · 1 needs you')).toBeTruthy();
    view.unmount();
    seed(session('a', 'working'), session('b', 'idle'));
    renderSwitcher();
    expect(within(await here()).getByText('2 sessions')).toBeTruthy();
    expect(screen.queryByText(/need you|needs you/)).toBeNull();
  });

  it('has no second line with no sessions', async () => {
    renderSwitcher();
    const row = await here();
    expect(row.querySelectorAll('li > span')).toHaveLength(1);
    expect(within(row).queryByText(/session/)).toBeNull();
  });

  it('counts the sessions the dashboard lists: not an ended one, not an AI popup’s', async () => {
    seed(
      session('a', 'working'),
      session('gone', 'ended'),
      session('popup', 'input', { isFloating: true }),
      session('b', 'input'),
    );
    renderSwitcher();
    expect(within(await here()).getByText('2 sessions · 1 needs you')).toBeTruthy();
  });

  it('follows the store: a session that starts waiting changes the line', async () => {
    seed(session('a', 'working'), session('b', 'working'));
    renderSwitcher();
    const row = within(await here());
    expect(row.getByText('2 sessions')).toBeTruthy();
    act(() => seed(session('a', 'approval'), session('b', 'working'), session('c', 'prompting')));
    expect(row.getByText('3 sessions · 1 needs you')).toBeTruthy();
  });

  it('does not redraw the part for a session update that changes neither number', async () => {
    seed(session('a', 'working'), session('b', 'approval'));
    let commits = 0;
    render(
      <MemoryRouter>
        <Profiler id="switch" onRender={() => { commits += 1; }}>
          <DevicesSwitcher />
        </Profiler>
      </MemoryRouter>,
    );
    expect(within(await here()).getByText('2 sessions · 1 needs you')).toBeTruthy();
    // Let the first reads and checks land, so nothing else is about to commit.
    await waitFor(() => expect(world.api.accountMachines).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    const before = commits;
    // What every hook event does: a new map, a session object replaced, its status as it was.
    act(() => seed(session('a', 'working', { lastActivityAt: 99, title: 'renamed' }), session('b', 'approval', { lastActivityAt: 100 })));
    act(() => seed(session('a', 'prompting'), session('b', 'input')));
    expect(commits).toBe(before);
    act(() => seed(session('a', 'input'), session('b', 'input')));
    expect(commits).toBe(before + 1);
    expect(within(await here()).getByText('2 sessions · 2 need you')).toBeTruthy();
  });
});
