// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import type { RemoteComputer, RemoteComputersAPI } from '@/types/electron';
import ClientHome, { LAST_COMPUTER_KEY } from './ClientHome';

const LINK = 'https://aasc.work/pair#v=2&name=studio-mac&lan=192.168.1.20&p=3334&mc=ABCDEFGHJK';
const computer = (id: string, status: RemoteComputer['status'] = 'active', confirmCode: string | null = null): RemoteComputer => ({
  id, name: id, lan: '192.168.1.20', tailnet: null, port: 3334, status, confirmCode, addedAt: 1, lastSeenAt: null,
}) as RemoteComputer;

function installApi(list: RemoteComputer[], overrides: Partial<RemoteComputersAPI> = {}): RemoteComputersAPI {
  const api: RemoteComputersAPI = {
    list: vi.fn(async () => list),
    add: vi.fn(async () => ({ ok: true as const, data: computer('studio-mac', 'pending', '482913') })),
    check: vi.fn(async () => ({ ok: true as const, data: { state: 'online' as const, via: 'lan' as const, sharedSessions: 2, message: null } })),
    open: vi.fn(async () => ({ ok: true as const, data: null })),
    remove: vi.fn(async () => ({ ok: true as const, data: { unpairedRemotely: true } })),
    rename: vi.fn(async () => ({ ok: true as const, data: computer('x') })),
    ...overrides,
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { remotes: api };
  return api;
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.useRealTimers();
});
const start = () => window.history.replaceState(null, '', '/?start=1');

describe('first launch', () => {
  it('asks for the pairing link straight away', async () => {
    start();
    const api = installApi([]);
    render(<ClientHome />);
    expect(await screen.findByRole('heading', { name: 'Connect to your AASC' })).toBeTruthy();
    expect(screen.getByLabelText(/Pairing link/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    expect(api.open).not.toHaveBeenCalled();
  });

  it('offers no local or remote choice: this app is remote', async () => {
    installApi([]);
    render(<ClientHome />);
    await screen.findByRole('heading', { name: 'Connect to your AASC' });
    expect(screen.queryByText(/local mode/i)).toBeNull();
    expect(screen.queryByText(/remote mode/i)).toBeNull();
  });

  it('shows the confirmation code, and opens the computer once its owner allows it', async () => {
    const list: RemoteComputer[] = [];
    const api = installApi(list);
    render(<ClientHome />);
    fireEvent.change(await screen.findByLabelText(/Pairing link/), { target: { value: LINK } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith(LINK));
    expect(await screen.findByText('482 913')).toBeTruthy();
    expect(api.open).not.toHaveBeenCalled();
    await waitFor(() => expect(api.open).toHaveBeenCalledWith('studio-mac'), { timeout: 5000 });
    expect(localStorage.getItem(LAST_COMPUTER_KEY)).toBe('studio-mac');
  }, 10000);

  it('stays on the code while the other computer has not answered', async () => {
    const api = installApi([], {
      check: vi.fn(async () => ({ ok: true as const, data: { state: 'pending' as const, via: 'lan' as const, sharedSessions: null, message: 'waiting' } })),
    });
    render(<ClientHome />);
    fireEvent.change(await screen.findByLabelText(/Pairing link/), { target: { value: LINK } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('482 913')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 3300));
    expect(api.open).not.toHaveBeenCalled();
  }, 10000);

  it('shows why a link was refused and keeps it for correcting', async () => {
    installApi([], { add: vi.fn(async () => ({ ok: false as const, error: 'That code has expired.' })) });
    render(<ClientHome />);
    const box = await screen.findByLabelText(/Pairing link/);
    fireEvent.change(box, { target: { value: LINK } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect((await screen.findByRole('alert')).textContent).toContain('That code has expired.');
    expect((screen.getByLabelText(/Pairing link/) as HTMLTextAreaElement).value).toBe(LINK);
  });
});

describe('a later launch', () => {
  it('opens the last computer and says so while it does', async () => {
    start();
    localStorage.setItem(LAST_COMPUTER_KEY, 'b');
    let finish: (value: { ok: true; data: null }) => void = () => {};
    const api = installApi([computer('a'), computer('b')], {
      open: vi.fn(() => new Promise<{ ok: true; data: null }>((resolve) => { finish = resolve; })),
    });
    render(<ClientHome />);
    expect(await screen.findByText(/Opening b/)).toBeTruthy();
    expect(api.open).toHaveBeenCalledWith('b');
    finish({ ok: true, data: null });
    expect(await screen.findByRole('heading', { name: 'Your computers' })).toBeTruthy();
  });

  it('says why it could not reach the computer once, in that computer\'s row', async () => {
    start();
    const reason = 'No answer from 192.168.1.20 on port 3334.';
    installApi([computer('studio-mac')], {
      open: vi.fn(async () => ({ ok: false as const, error: reason })),
      check: vi.fn(async () => ({ ok: true as const, data: { state: 'offline' as const, via: null, sharedSessions: null, message: reason } })),
    });
    render(<ClientHome />);
    expect(await screen.findByRole('heading', { name: 'Your computers' })).toBeTruthy();
    expect(await screen.findByText(`Offline: ${reason}`)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open studio-mac' })).toBeTruthy();
    expect(screen.queryByLabelText(/Pairing link/)).toBeNull();
  });

  it('also leaves it to the row when the check itself fails', async () => {
    start();
    installApi([computer('studio-mac')], {
      open: vi.fn(async () => ({ ok: false as const, error: 'No answer.' })),
      check: vi.fn(async () => ({ ok: false as const, error: 'No answer.' })),
    });
    render(<ClientHome />);
    expect(await screen.findByText('Offline: No answer.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a failure above the list when the row would say Online', async () => {
    start();
    installApi([computer('studio-mac')], {
      open: vi.fn(async () => ({ ok: false as const, error: 'The window could not be opened.' })),
    });
    render(<ClientHome />);
    expect((await screen.findByRole('alert')).textContent).toBe('The window could not be opened.');
  });

  it('shows the failure when the check throws rather than answers', async () => {
    start();
    installApi([computer('studio-mac')], {
      open: vi.fn(async () => { throw new Error('IPC broke'); }),
      check: vi.fn(async () => { throw new Error('IPC broke'); }),
    });
    render(<ClientHome />);
    expect((await screen.findByRole('alert')).textContent).toBe('IPC broke');
  });

  it('asks which when several are paired and none was opened last', async () => {
    start();
    const api = installApi([computer('a'), computer('b')]);
    render(<ClientHome />);
    await screen.findByRole('heading', { name: 'Your computers' });
    expect(api.open).not.toHaveBeenCalled();
  });

  // A reload of this same window, by hand or after a renderer crash, is not a new launch.
  it('forgets that the launch asked for it once it has read that', async () => {
    start();
    localStorage.setItem(LAST_COMPUTER_KEY, 'a');
    const api = installApi([computer('a')]);
    render(<ClientHome />);
    await waitFor(() => expect(api.open).toHaveBeenCalledTimes(1));
    expect(window.location.search).toBe('');
  });

  // Every silent address costs 3 s, and a second round to find the wording would double what the person waits.
  it('shows the list as soon as opening fails, while the row works out why', async () => {
    start();
    localStorage.setItem(LAST_COMPUTER_KEY, 'a');
    const never = new Promise<never>(() => {});
    installApi([computer('a')], {
      open: vi.fn(async () => ({ ok: false as const, error: 'No answer' })),
      check: vi.fn(() => never),
    });
    render(<ClientHome />);
    expect(await screen.findByRole('heading', { name: 'Your computers' })).toBeTruthy();
    expect(screen.queryByText(/Opening/)).toBeNull();
  });

  // Opening the list again after a dashboard closes must not throw the person straight back into it.
  it('opens nothing by itself unless the launch asked for it', async () => {
    localStorage.setItem(LAST_COMPUTER_KEY, 'a');
    const api = installApi([computer('a')]);
    render(<ClientHome />);
    await screen.findByRole('heading', { name: 'Your computers' });
    expect(api.open).not.toHaveBeenCalled();
  });

  // The list spends its life hidden behind a dashboard, so without this it comes back saying Offline for a computer that
  // returned minutes ago, and stays that way until the next round.
  it('checks again as soon as the app brings the list back, and stops listening when it goes', async () => {
    const api = installApi([computer('a')]);
    const listeners = new Set<() => void>();
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.onHomeShown = (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const { unmount } = render(<ClientHome />);
    await screen.findByRole('button', { name: 'Open a' });
    await waitFor(() => expect(api.check).toHaveBeenCalledTimes(1));
    listeners.forEach((listener) => listener());
    await waitFor(() => expect(api.check).toHaveBeenCalledTimes(2));
    unmount();
    expect(listeners.size).toBe(0);
  });

  it('remembers a computer opened from the list', async () => {
    installApi([computer('a'), computer('b')]);
    render(<ClientHome />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open b' }));
    await waitFor(() => expect(localStorage.getItem(LAST_COMPUTER_KEY)).toBe('b'));
  });
});
