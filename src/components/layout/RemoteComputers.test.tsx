// RemoteComputers.test.tsx — the device panel's list of other AASC computers (Oct 28 2026).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import RemoteComputers from './RemoteComputers';
import { showToast } from '@/components/ui/ToastContainer';
import type { RemoteComputer, RemoteComputerCheck, RemoteComputersAPI, RemoteResult } from '@/types/electron';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

function computer(over: Partial<RemoteComputer>): RemoteComputer {
  return {
    id: 'r1', name: 'Studio Mac', lan: '192.168.4.20', tailnet: null, port: 3333, status: 'active',
    confirmCode: null, addedAt: 0, lastSeenAt: null, ...over,
  };
}

const online = (over: Partial<RemoteComputerCheck> = {}): RemoteComputerCheck =>
  ({ state: 'online', via: 'tailnet', sharedSessions: 12, message: null, ...over });

let stored: RemoteComputer[];
let answers: Record<string, RemoteComputerCheck>;
let api: { [K in keyof RemoteComputersAPI]: ReturnType<typeof vi.fn> };

function ok<T>(data: T): Promise<RemoteResult<T>> {
  return Promise.resolve({ ok: true, data });
}

beforeEach(() => {
  stored = [];
  answers = {};
  api = {
    list: vi.fn(() => Promise.resolve(stored)),
    check: vi.fn((id: string) => ok(answers[id] ?? online())),
    add: vi.fn(),
    open: vi.fn(() => ok(null)),
    remove: vi.fn((id: string) => {
      stored = stored.filter((c) => c.id !== id);
      return ok({ unpairedRemotely: true });
    }),
    rename: vi.fn((id: string, name: string) => {
      stored = stored.map((c) => (c.id === id ? { ...c, name } : c));
      return ok(stored.find((c) => c.id === id));
    }),
  };
  window.electronAPI = { remotes: api as unknown as RemoteComputersAPI } as typeof window.electronAPI;
});

afterEach(() => {
  delete window.electronAPI;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('RemoteComputers', () => {
  it('renders nothing without the remotes API (a browser, an older app)', () => {
    delete window.electronAPI;
    const { container } = render(<RemoteComputers />);
    expect(container.textContent).toBe('');
  });

  it('lists each computer with a status word, and Open only for an allowed one', async () => {
    stored = [
      computer({ id: 'a', name: 'Studio Mac' }),
      computer({ id: 'b', name: 'Home PC' }),
      computer({ id: 'c', name: 'Old laptop', status: 'revoked' }),
      computer({ id: 'd', name: 'New Mac', status: 'pending', confirmCode: '123456' }),
    ];
    answers = {
      a: online(),
      b: { state: 'offline', via: null, sharedSessions: null, message: 'no answer' },
      d: { state: 'pending', via: 'lan', sharedSessions: null, message: null },
    };
    render(<RemoteComputers />);
    expect(await screen.findByText('Online · Tailscale · 12 shared')).toBeTruthy();
    expect(await screen.findByText('Offline: no answer')).toBeTruthy();
    expect(screen.getByText('Removed on that computer')).toBeTruthy();
    expect(screen.getByText('Waiting for Allow · code 123 456')).toBeTruthy();
    const openOf = (name: string) => screen.getByRole('button', { name: `Open ${name}` }) as HTMLButtonElement;
    expect(openOf('Studio Mac').disabled).toBe(false);
    expect(openOf('Home PC').disabled).toBe(false);
    expect(openOf('Old laptop').disabled).toBe(true);
    expect(openOf('New Mac').disabled).toBe(true);
    // A revoked computer is not asked again.
    expect(api.check).not.toHaveBeenCalledWith('c');
  });

  it('reads the home network, an unknown share count and a bare offline', async () => {
    stored = [computer({ id: 'a', name: 'A' }), computer({ id: 'b', name: 'B' }), computer({ id: 'c', name: 'C' })];
    answers = {
      a: online({ via: 'lan', sharedSessions: 3 }),
      b: online({ via: null, sharedSessions: null }),
      c: { state: 'offline', via: null, sharedSessions: null, message: null },
    };
    render(<RemoteComputers />);
    expect(await screen.findByText('Online · Home network · 3 shared')).toBeTruthy();
    expect(screen.getByText('Online')).toBeTruthy();
    expect(screen.getByText('Offline')).toBeTruthy();
  });

  it('says "Checking…" until the first answer', async () => {
    stored = [computer({})];
    api.check.mockImplementation(() => new Promise(() => {}));
    render(<RemoteComputers />);
    expect(await screen.findByText('Checking…')).toBeTruthy();
  });

  it('re-checks every 30 s, never two checks of the same row at once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stored = [computer({ id: 'a' })];
    let release: (v: RemoteResult<RemoteComputerCheck>) => void = () => {};
    api.check.mockImplementation(() => new Promise((r) => { release = r; }));
    render(<RemoteComputers />);
    await screen.findByText('Studio Mac');
    await waitFor(() => expect(api.check).toHaveBeenCalledTimes(1));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(api.check).toHaveBeenCalledTimes(1); // the first one is still running
    await act(async () => release({ ok: true, data: online() }));
    expect(await screen.findByText('Online · Tailscale · 12 shared')).toBeTruthy();
    api.check.mockImplementation(() => ok(online({ sharedSessions: 2 })));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(api.check).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Online · Tailscale · 2 shared')).toBeTruthy();
  });

  it('shows "Opening…" while Open runs, and its error inline', async () => {
    stored = [computer({})];
    let finish: (v: RemoteResult<null>) => void = () => {};
    api.open.mockImplementation(() => new Promise((r) => { finish = r; }));
    render(<RemoteComputers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Studio Mac' }));
    expect(screen.getByRole('button', { name: 'Open Studio Mac' }).textContent).toBe('Opening…');
    expect(api.open).toHaveBeenCalledWith('r1');
    await act(async () => finish({ ok: false, error: 'Sign-in refused' }));
    expect(screen.getByRole('alert').textContent).toBe('Sign-in refused');
    expect(screen.getByRole('button', { name: 'Open Studio Mac' }).textContent).toBe('Open');
  });

  // E2E Oct 28 2026: after the remote revoked this computer, Open said so but the row still read
  // "Online · … shared" with a green dot until the next 30 s check.
  it('re-checks a row whose Open failed, so its status line follows the error', async () => {
    stored = [computer({})];
    answers = { r1: online() };
    render(<RemoteComputers />);
    expect(await screen.findByText('Online · Tailscale · 12 shared')).toBeTruthy();
    api.open.mockImplementation(() => Promise.resolve({ ok: false, error: 'Studio Mac removed this computer. Remove it here and pair again.' }));
    answers = { r1: { state: 'revoked', via: 'lan', sharedSessions: null, message: null } };
    fireEvent.click(screen.getByRole('button', { name: 'Open Studio Mac' }));
    expect(await screen.findByText('Removed on that computer')).toBeTruthy();
    expect(screen.queryByText(/Online/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('removed this computer');
    expect((screen.getByRole('button', { name: 'Open Studio Mac' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('pairs from a link, shows the code to compare, and polls every 3 s until allowed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const added = computer({ id: 'n', name: 'New Mac', status: 'pending', confirmCode: '654321' });
    api.add.mockImplementation(() => {
      stored = [added];
      return ok(added);
    });
    answers = { n: { state: 'pending', via: 'lan', sharedSessions: null, message: null } };
    render(<RemoteComputers />);
    expect(await screen.findByText('No remote computers yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '+ Add a computer' }));
    const field = screen.getByRole('textbox', { name: 'Pairing link' });
    expect(screen.getByText(/press “Pair a phone or computer” and copy its link/)).toBeTruthy();
    fireEvent.change(field, { target: { value: '  https://aasc.work/pair#v=2&mc=X  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith('https://aasc.work/pair#v=2&mc=X'));
    const card = await screen.findByRole('status');
    expect(card.textContent).toContain('On New Mac, press Allow for this computer. Check it shows 654 321.');

    const before = api.check.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(api.check.mock.calls.length).toBeGreaterThan(before);
    expect(screen.getByRole('status')).toBeTruthy();

    answers = { n: online() };
    stored = [{ ...added, status: 'active', confirmCode: null }];
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(showToast).toHaveBeenCalledWith('New Mac is paired', 'info', 3000);
    expect(await screen.findByText('Online · Tailscale · 12 shared')).toBeTruthy();
  });

  it('stops waiting after 10 minutes and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const added = computer({ id: 'n', name: 'New Mac', status: 'pending', confirmCode: '654321' });
    api.add.mockImplementation(() => {
      stored = [added];
      return ok(added);
    });
    answers = { n: { state: 'pending', via: 'lan', sharedSessions: null, message: null } };
    render(<RemoteComputers />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add a computer' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Pairing link' }), { target: { value: 'https://aasc.work/pair#x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    await screen.findByRole('status');
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000 + 3_000));
    expect(screen.getByRole('status').textContent).toContain('Stopped waiting after 10 minutes');
    const calls = api.check.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(9_000));
    expect(api.check.mock.calls.length).toBe(calls); // no more 3-second polls (the 30 s round is not due)
  });

  it('shows why a link was refused, under the field', async () => {
    api.add.mockImplementation(() => Promise.resolve({ ok: false, error: 'That pairing link has expired' }));
    render(<RemoteComputers />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add a computer' }));
    const pair = screen.getByRole('button', { name: 'Pair' }) as HTMLButtonElement;
    expect(pair.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Pairing link' }), { target: { value: 'https://aasc.work/pair#old' } });
    fireEvent.click(pair);
    expect((await screen.findByRole('alert')).textContent).toBe('That pairing link has expired');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renames from the ⋯ menu: Enter saves', async () => {
    stored = [computer({})];
    render(<RemoteComputers />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Studio Mac' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Computer name' }) as HTMLInputElement;
    expect(input.value).toBe('Studio Mac');
    fireEvent.change(input, { target: { value: 'Office Mac' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.rename).toHaveBeenCalledWith('r1', 'Office Mac'));
    expect(await screen.findByText('Office Mac')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Computer name' })).toBeNull();
  });

  it('removes only after confirming, and drops the row', async () => {
    stored = [computer({})];
    render(<RemoteComputers />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Studio Mac' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove…' }));
    expect(screen.getByText('Remove Studio Mac? It is unpaired there too when it answers.')).toBeTruthy();
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByText(/It is unpaired there too/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'More for Studio Mac' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(screen.queryByText('Studio Mac')).toBeNull());
    expect(showToast).toHaveBeenCalledWith('Removed Studio Mac and unpaired it there', 'info', 4000);
    // Focus is handed on, not dropped to <body> with the row.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '+ Add a computer' }));
  });
});
