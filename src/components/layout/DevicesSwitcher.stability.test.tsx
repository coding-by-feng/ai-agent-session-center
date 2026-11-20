// DevicesSwitcher.stability.test.tsx — what must hold while answers arrive out of order (code review, Nov 20 2026):
// a row stays the same row whatever the directory says, two computers can wait for Allow at once, and an answer
// that started before a Connect or a Dismiss never puts the old state back.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { showToast } from '@/components/ui/ToastContainer';
import type { AccountDirectory, RemoteComputer, RemoteComputerCheck, RemoteResult } from '@/types/electron';
import {
  HERE, directoryOf, installWorld, linked, machine, ok, online, pending, record, refused, renderSwitcher, unproved,
  type World,
} from './DevicesSwitcher.fixtures';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const IMAC = machine({ deviceId: 'd-imac', name: 'Studio iMac' });
const LINUX = machine({ deviceId: 'd-linux', name: 'Linux box' });
const IMAC_WAITING = record({ id: 'r-imac', name: 'Studio iMac', backendDeviceId: 'd-imac', status: 'pending', confirmCode: '482913' });
const NEW_LINK = linked({ id: 'r-new', name: 'New Mac', status: 'pending', confirmCode: '654321' });
const IMAC_WORDS = 'Waiting for Allow on Studio iMac · code 482 913';

let world: World;

beforeEach(() => {
  world = installWorld();
});

afterEach(() => {
  delete window.electronAPI;
  vi.useRealTimers();
  vi.clearAllMocks();
});

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const checked = () => world.api.check.mock.calls.map((call) => call[0] as string);
const allow = (id: string, answer: RemoteComputerCheck) => {
  world.answers = { ...world.answers, [id]: answer };
  world.stored = world.stored.map((c) => (c.id === id ? { ...c, status: 'active', confirmCode: null } : c));
};

describe('DevicesSwitcher — a row stays the same row', () => {
  it('when the directory lands after the list: a rename being typed is kept', async () => {
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [record({})];
    let land: (v: RemoteResult<AccountDirectory>) => void = () => {};
    world.api.accountMachines.mockImplementation(() => new Promise((r) => { land = r; }));
    renderSwitcher();
    await screen.findByText('Online · Tailscale · 4 shared');
    const row = screen.getByText('Mac mini').closest('li');
    fireEvent.click(button('More for Mac mini'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Computer name' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Office' } });

    await act(async () => land({ ok: true, data: world.directory }));
    await screen.findByRole('region', { name: 'This computer' });
    expect(screen.getByRole('textbox', { name: 'Computer name' })).toBe(input);
    expect(input.value).toBe('Office');
    expect(input.closest('li')).toBe(row);
  });

  it('when a later read finds AASC Cloud unreachable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [record({})];
    renderSwitcher();
    await screen.findByRole('region', { name: 'This computer' });
    await screen.findByText('Online · Tailscale · 4 shared');
    const row = screen.getByText('Mac mini').closest('li');
    world.directory = { state: 'unreachable', machines: [] };
    await tick(60_000);
    await screen.findByText(/^Can’t reach AASC Cloud/);
    expect(screen.getByText('Mac mini').closest('li')).toBe(row);
  });
});

describe('DevicesSwitcher — two computers waiting for Allow at once', () => {
  async function pairByLink(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: '+ Add a computer by link' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Pairing link' }), { target: { value: 'https://aasc.work/pair#v=2' } });
    fireEvent.click(button('Pair'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('On New Mac, press Allow for this computer.'));
  }

  async function connectIMac(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Studio iMac' }));
    await screen.findByText(IMAC_WORDS);
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    world.directory = directoryOf(HERE, IMAC);
    world.answers = { 'r-new': pending(), 'r-imac': pending() };
    world.api.add.mockImplementation(() => {
      world.stored = [...world.stored, NEW_LINK];
      return ok(NEW_LINK);
    });
    world.api.accountConnect.mockImplementation(() => {
      world.stored = [...world.stored, IMAC_WAITING];
      return ok(IMAC_WAITING);
    });
  });

  it('a link pairing, then an account Connect: both are asked every 3 s, the card stays, each finishes its own way', async () => {
    renderSwitcher();
    await pairByLink();
    await connectIMac();
    expect(screen.getByRole('status').textContent).toContain('Check it shows 654 321.');

    world.api.check.mockClear();
    await tick(3_000);
    expect(checked()).toEqual(expect.arrayContaining(['r-new', 'r-imac']));

    allow('r-new', online({ via: 'lan', sharedSessions: 1 }));
    await tick(3_000);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(showToast).toHaveBeenCalledWith('New Mac is paired', 'info', 3000);
    expect(await screen.findByText('Online · Home network · 1 shared')).toBeTruthy();
    expect(screen.getByText(IMAC_WORDS)).toBeTruthy();

    // The account computer is still asked every 3 s, and finishes without a toast.
    world.api.check.mockClear();
    await tick(3_000);
    expect(checked()).toContain('r-imac');
    allow('r-imac', online());
    await tick(3_000);
    expect(await screen.findByText('Online · Tailscale · 4 shared')).toBeTruthy();
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('an account Connect, then a link pairing: the same', async () => {
    renderSwitcher();
    await connectIMac();
    await pairByLink();
    expect(screen.getByText(IMAC_WORDS)).toBeTruthy();

    world.api.check.mockClear();
    await tick(3_000);
    expect(checked()).toEqual(expect.arrayContaining(['r-new', 'r-imac']));

    allow('r-imac', online());
    await tick(3_000);
    expect(await screen.findByText('Online · Tailscale · 4 shared')).toBeTruthy();
    expect(showToast).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('On New Mac, press Allow for this computer.');

    world.api.check.mockClear();
    await tick(3_000);
    expect(checked()).toContain('r-new');
    allow('r-new', online({ via: 'lan', sharedSessions: 1 }));
    await tick(3_000);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(showToast).toHaveBeenCalledWith('New Mac is paired', 'info', 3000);
  });
});

describe('DevicesSwitcher — an answer that started before a Connect or a Dismiss', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  /** The next check of the 30 s round is left hanging; returns how to answer it later. */
  async function hangNextCheck(): Promise<(v: RemoteResult<RemoteComputerCheck>) => void> {
    let land: (v: RemoteResult<RemoteComputerCheck>) => void = () => {};
    world.api.check.mockImplementationOnce(() => new Promise((r) => { land = r; }));
    const before = world.api.check.mock.calls.length;
    await tick(30_000);
    expect(world.api.check.mock.calls.length).toBe(before + 1);
    return (v) => land(v);
  }

  /** The next read of the list (the 30 s round's) is left hanging; returns how to answer it later. */
  async function hangNextList(): Promise<(v: RemoteComputer[]) => void> {
    let land: (v: RemoteComputer[]) => void = () => {};
    world.api.list.mockImplementationOnce(() => new Promise((r) => { land = r; }));
    const before = world.api.list.mock.calls.length;
    await tick(30_000);
    expect(world.api.list.mock.calls.length).toBe(before + 1);
    return (v) => land(v);
  }

  function unprovedMini(): void {
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [record({})];
    world.answers = { 'r-mini': unproved('Mac mini') };
    world.api.accountConnect.mockImplementation(() => {
      world.answers = { 'r-mini': online() };
      return ok(record({}));
    });
  }

  it('an old check that lands after the Connect is dropped: the row is checked afresh and stays as that check found it', async () => {
    unprovedMini();
    renderSwitcher();
    await screen.findByRole('button', { name: 'Connect Mac mini' });
    const landOld = await hangNextCheck();
    fireEvent.click(button('Connect Mac mini'));
    // Not held up by the check that is still out.
    expect(await screen.findByText('Online · Tailscale · 4 shared')).toBeTruthy();
    await act(async () => landOld({ ok: true, data: unproved('Mac mini') }));
    expect(screen.getByText('Online · Tailscale · 4 shared')).toBeTruthy();
    expect(screen.queryByText(/Something else answered/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect Mac mini' })).toBeNull();
  });

  it('an old check that lands while the Connect is still running shows until the Connect answers', async () => {
    unprovedMini();
    let connected: (v: RemoteResult<RemoteComputer>) => void = () => {};
    world.api.accountConnect.mockImplementation(() => new Promise((r) => { connected = r; }));
    renderSwitcher();
    await screen.findByRole('button', { name: 'Connect Mac mini' });
    const landOld = await hangNextCheck();
    fireEvent.click(button('Connect Mac mini'));
    await act(async () => landOld({ ok: true, data: unproved('Mac mini') }));
    expect(screen.getByText('Connecting…')).toBeTruthy();
    world.answers = { 'r-mini': online() };
    await act(async () => connected({ ok: true, data: record({}) }));
    expect(await screen.findByText('Online · Tailscale · 4 shared')).toBeTruthy();
  });

  // The round that read the old list goes on to check every row in it before it reads the list again, and one
  // slow computer can take seconds: `slowChecks` keeps it there, so what the old list did stays visible.
  const slowChecks = () => world.api.check.mockImplementation(() => new Promise(() => {}));

  it('an old list that lands after the Connect does not drop the record just connected', async () => {
    world.directory = directoryOf(HERE, IMAC);
    world.stored = [linked()];
    world.api.accountConnect.mockImplementation(() => {
      world.stored = [linked(), IMAC_WAITING];
      world.answers = { 'r-imac': pending() };
      return ok(IMAC_WAITING);
    });
    renderSwitcher();
    await screen.findByRole('button', { name: 'Connect Studio iMac' });
    const landOld = await hangNextList();
    fireEvent.click(button('Connect Studio iMac'));
    await screen.findByText(IMAC_WORDS);
    slowChecks();
    await act(async () => landOld([linked()]));
    expect(screen.getByText(IMAC_WORDS)).toBeTruthy();
    expect(screen.queryByText('Not connected yet')).toBeNull();
    expect(button('Dismiss Studio iMac')).toBeTruthy();
  });

  it('an old list that lands before the Connect answers changes nothing either', async () => {
    world.directory = directoryOf(HERE, IMAC);
    let connected: (v: RemoteResult<RemoteComputer>) => void = () => {};
    world.api.accountConnect.mockImplementation(() => new Promise((r) => { connected = r; }));
    renderSwitcher();
    await screen.findByRole('button', { name: 'Connect Studio iMac' });
    const landOld = await hangNextList();
    fireEvent.click(button('Connect Studio iMac'));
    await act(async () => landOld([]));
    expect(screen.getByText('Connecting…')).toBeTruthy();
    world.stored = [IMAC_WAITING];
    world.answers = { 'r-imac': pending() };
    await act(async () => connected({ ok: true, data: IMAC_WAITING }));
    expect(await screen.findByText(IMAC_WORDS)).toBeTruthy();
  });

  it('an old list that lands after a Dismiss does not bring the record back', async () => {
    const waitingLinux = record({ id: 'r-linux', name: 'Linux box', backendDeviceId: 'd-linux', status: 'pending', confirmCode: '482913' });
    world.directory = directoryOf(HERE, LINUX);
    world.stored = [waitingLinux];
    world.answers = { 'r-linux': pending() };
    renderSwitcher();
    await screen.findByRole('button', { name: 'Dismiss Linux box' });
    const landOld = await hangNextList();
    fireEvent.click(button('Dismiss Linux box'));
    expect(await screen.findByText('Not connected yet')).toBeTruthy();
    slowChecks();
    await act(async () => landOld([waitingLinux]));
    expect(screen.getByText('Not connected yet')).toBeTruthy();
    expect(screen.queryByText(/Waiting for Allow/)).toBeNull();
  });
});

describe('DevicesSwitcher — a row’s own error does not outlive what it was about', () => {
  it('Open’s error gives way when Connect runs, so Connect’s own answer shows', async () => {
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [record({})];
    world.api.open.mockImplementationOnce(() => {
      world.answers = { 'r-mini': unproved('Mac mini') };
      return refused('Mac mini did not prove itself. Its window was not opened.');
    });
    renderSwitcher();
    await screen.findByText('Online · Tailscale · 4 shared');
    fireEvent.click(button('Open Mac mini'));
    expect((await screen.findByRole('alert')).textContent).toBe('Mac mini did not prove itself. Its window was not opened.');
    const connect = await screen.findByRole('button', { name: 'Connect Mac mini' });

    let answer: (v: RemoteResult<RemoteComputer>) => void = () => {};
    world.api.accountConnect.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    fireEvent.click(connect);
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => answer({ ok: false, error: 'Sign in to AASC Cloud again on Mac mini, then connect.' }));
    expect(screen.getByRole('alert').textContent).toBe('Sign in to AASC Cloud again on Mac mini, then connect.');
  });

  it('an error on a row that waits for Allow goes once the computer is allowed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    world.directory = directoryOf(HERE, IMAC);
    world.stored = [IMAC_WAITING];
    world.answers = { 'r-imac': pending() };
    world.api.remove.mockImplementationOnce(() => refused('Couldn’t forget Studio iMac just now.'));
    renderSwitcher();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Studio iMac' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t forget Studio iMac just now.');
    allow('r-imac', online());
    await tick(30_000);
    expect(await screen.findByText('Online · Tailscale · 4 shared')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a computer paired by link keeps the error that says what to do after it was removed there', async () => {
    world.stored = [linked()];
    world.api.open.mockImplementationOnce(() => {
      world.stored = [linked({ status: 'revoked' })];
      return refused('Old NUC removed this computer. Remove it here and pair again.');
    });
    renderSwitcher();
    const byLink = await screen.findByRole('region', { name: 'Paired by link' });
    await within(byLink).findByText('Online · Tailscale · 4 shared');
    fireEvent.click(button('Open Old NUC'));
    expect(await within(byLink).findByText('Removed on that computer')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Old NUC removed this computer. Remove it here and pair again.');
  });
});
