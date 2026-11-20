// DevicesSwitcher.test.tsx — the Switch part of the devices panel (plan 18 stage 2): its sections and every row state.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { showToast } from '@/components/ui/ToastContainer';
import type { RemoteComputer, RemoteResult } from '@/types/electron';
import {
  HERE, directoryOf, installWorld, linked, machine, offline, ok, online, pending, record, refused, renderSwitcher, unproved,
  type World,
} from './DevicesSwitcher.fixtures';
import DevicesSwitcher from './DevicesSwitcher';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const VPS = machine({ deviceId: 'd-vps', name: 'VPS' });
const IMAC = machine({ deviceId: 'd-imac', name: 'Studio iMac' });
const LINUX = machine({ deviceId: 'd-linux', name: 'Linux box' });

let world: World;

beforeEach(() => {
  world = installWorld();
});

afterEach(() => {
  delete window.electronAPI;
  vi.useRealTimers();
  vi.clearAllMocks();
});

const region = (name: string) => screen.getByRole('region', { name });
const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('DevicesSwitcher — sections', () => {
  it('renders nothing without the account channels (a browser, an older app, a Client edition)', () => {
    delete (world.api as Partial<World['api']>).accountMachines;
    const { container } = render(<DevicesSwitcher />);
    expect(container.textContent).toBe('');
    expect(world.api.list).not.toHaveBeenCalled();
  });

  it('draws This computer, My computers and Paired by link in that order, one action per row', async () => {
    world.directory = directoryOf(HERE, machine({}), VPS, IMAC, LINUX);
    world.stored = [
      record({}),
      record({ id: 'r-vps', name: 'VPS', backendDeviceId: 'd-vps' }),
      record({ id: 'r-linux', name: 'Linux box', backendDeviceId: 'd-linux', status: 'pending', confirmCode: '482913' }),
      linked(),
    ];
    world.answers = { 'r-vps': offline(), 'r-linux': pending(), 'r-nuc': online({ via: 'lan', sharedSessions: 1 }) };
    renderSwitcher();

    const here = await screen.findByRole('region', { name: 'This computer' });
    expect(within(here).getByText('MacBook Pro')).toBeTruthy();
    expect(within(here).getByText('here')).toBeTruthy();
    expect(within(here).queryByRole('button')).toBeNull();

    const mine = region('My computers');
    expect(await within(mine).findByText('Online · Tailscale · 4 shared')).toBeTruthy();
    expect(within(mine).getByText('1 of 4 online')).toBeTruthy();
    expect(within(mine).getAllByRole('listitem').map((li) => li.querySelector('[title]')?.textContent ?? li.textContent))
      .toEqual(['Mac mini', 'VPS', 'Studio iMac', 'Linux box']);

    // Online and offline: Open (offline retries), with the ⋯ menu.
    expect(button('Open Mac mini').disabled).toBe(false);
    expect(button('More for Mac mini')).toBeTruthy();
    expect(within(mine).getByText('Offline')).toBeTruthy();
    expect(button('Open VPS').disabled).toBe(false);
    expect(button('More for VPS')).toBeTruthy();
    // Never connected: Connect alone.
    expect(within(mine).getByText('Not connected yet')).toBeTruthy();
    expect(button('Connect Studio iMac')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More for Studio iMac' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Studio iMac' })).toBeNull();
    // Waiting for Allow: Dismiss alone, with the code formatted as the link rows format it.
    expect(within(mine).getByText('Waiting for Allow on Linux box · code 482 913')).toBeTruthy();
    expect(button('Dismiss Linux box')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open Linux box' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More for Linux box' })).toBeNull();

    const byLink = region('Paired by link');
    expect(within(byLink).getByText('Old NUC')).toBeTruthy();
    expect(within(byLink).getByText('Online · Home network · 1 shared')).toBeTruthy();
    expect(button('Open Old NUC').disabled).toBe(false);
    expect(button('More for Old NUC')).toBeTruthy();

    const add = button('+ Add a computer by link');
    expect(follows(here, mine)).toBe(true);
    expect(follows(mine, byLink)).toBe(true);
    expect(follows(byLink, add)).toBe(true);
  });

  it('never lists an account record under Paired by link as well', async () => {
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [record({}), linked()];
    world.answers = { 'r-nuc': online({ via: 'lan', sharedSessions: 1 }) };
    renderSwitcher();
    await screen.findByText('Online · Tailscale · 4 shared');
    await screen.findByText('Online · Home network · 1 shared');
    expect(screen.getAllByText('Mac mini')).toHaveLength(1);
    expect(within(region('Paired by link')).queryByText('Mac mini')).toBeNull();
    expect(within(region('Paired by link')).getAllByRole('listitem')).toHaveLength(1);
    expect(within(region('My computers')).queryByText('Old NUC')).toBeNull();
  });

  it('draws no section that has no rows', async () => {
    world.directory = directoryOf(machine({}));
    world.stored = [record({})];
    renderSwitcher();
    await screen.findByText('Online · Tailscale · 4 shared');
    expect(screen.queryByRole('region', { name: 'This computer' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Paired by link' })).toBeNull();
    expect(button('+ Add a computer by link')).toBeTruthy();
  });

  it('pairs by link from the switcher, with the same card to compare the code', async () => {
    const added = linked({ id: 'r-new', name: 'New Mac', status: 'pending', confirmCode: '654321' });
    world.api.add.mockImplementation(() => {
      world.stored = [added];
      return ok(added);
    });
    world.answers = { 'r-new': pending() };
    renderSwitcher();
    fireEvent.click(await screen.findByRole('button', { name: '+ Add a computer by link' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Pairing link' }), { target: { value: 'https://aasc.work/pair#v=2' } });
    fireEvent.click(button('Pair'));
    await waitFor(() => expect(world.api.add).toHaveBeenCalledWith('https://aasc.work/pair#v=2'));
    expect((await screen.findByRole('status')).textContent).toContain('On New Mac, press Allow for this computer. Check it shows 654 321.');
    expect(within(region('Paired by link')).getByText('Waiting for Allow · code 654 321')).toBeTruthy();
  });
});

describe('DevicesSwitcher — an account computer’s row', () => {
  it('says "Checking…" with Open off until the first check answers', async () => {
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [record({})];
    world.api.check.mockImplementation(() => new Promise(() => {}));
    renderSwitcher();
    expect(await screen.findByText('Checking…')).toBeTruthy();
    expect(button('Open Mac mini').disabled).toBe(true);
    expect(within(region('My computers')).getByText('0 of 1 online')).toBeTruthy();
  });

  it('gives the check’s reason when nothing answered, and Open still retries', async () => {
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [record({})];
    world.answers = { 'r-mini': offline('No answer from Mac mini at any of its addresses.') };
    renderSwitcher();
    expect(await screen.findByText('Offline: No answer from Mac mini at any of its addresses.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect Mac mini' })).toBeNull();
    fireEvent.click(button('Open Mac mini'));
    await waitFor(() => expect(world.api.open).toHaveBeenCalledWith('r-mini'));
    expect(world.api.accountConnect).not.toHaveBeenCalled();
  });

  // What a removal on the machine looks like for an account record: Open could never fix it, Connect enrolls again.
  it('offers Connect when something answered and proved nothing, and follows the record it enrolls again', async () => {
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [record({})];
    world.answers = { 'r-mini': unproved('Mac mini') };
    const again = record({ status: 'pending', confirmCode: '482913' });
    world.api.accountConnect.mockImplementation(() => {
      world.stored = [again];
      world.answers = { 'r-mini': pending() };
      return ok(again);
    });
    renderSwitcher();
    expect(await screen.findByText('Offline: Something else answered at Mac mini’s address.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open Mac mini' })).toBeNull();
    expect(button('More for Mac mini')).toBeTruthy();
    expect(world.api.open).not.toHaveBeenCalled();
    const connect = button('Connect Mac mini');
    connect.focus();
    fireEvent.click(connect);
    expect(world.api.accountConnect).toHaveBeenCalledWith('d-mini');
    // The same row, now waiting for Allow with the new code.
    expect(await screen.findByText('Waiting for Allow on Mac mini · code 482 913')).toBeTruthy();
    expect(screen.getAllByText('Mac mini')).toHaveLength(1);
    expect(button('Dismiss Mac mini')).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Connect Mac mini' })).toBeNull();
  });

  it('never offers Connect on a computer paired by link, whatever its check says', async () => {
    world.stored = [linked(), linked({ id: 'r-old', name: 'Old laptop', status: 'revoked' })];
    world.answers = { 'r-nuc': unproved('Old NUC') };
    renderSwitcher();
    const byLink = await screen.findByRole('region', { name: 'Paired by link' });
    expect(await within(byLink).findByText('Offline: Something else answered at Old NUC’s address.')).toBeTruthy();
    expect(within(byLink).getByText('Removed on that computer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Connect / })).toBeNull();
    expect(button('Open Old NUC').disabled).toBe(false);
    expect(button('Open Old laptop').disabled).toBe(true);
  });

  it.each([
    ['the stored record is removed', record({ status: 'revoked' }), undefined],
    ['the check calls it revoked', record({}), { state: 'revoked' as const, via: 'lan' as const, sharedSessions: null, message: null }],
  ])('offers Connect in place of Open when %s', async (_label, stored, answer) => {
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [stored];
    if (answer) world.answers = { 'r-mini': answer };
    world.api.accountConnect.mockImplementation(() => new Promise(() => {}));
    renderSwitcher();
    const connect = await screen.findByRole('button', { name: 'Connect Mac mini' });
    expect(within(region('My computers')).getByText('Removed on that computer')).toBeTruthy();
    // A grey dot: the row can be connected again, so it is not the red a link row's "Removed" gets.
    expect(connect.closest('li')?.querySelector('span[aria-hidden="true"]')?.className).not.toMatch(/revoked/);
    expect(screen.queryByRole('button', { name: 'Open Mac mini' })).toBeNull();
    expect(button('More for Mac mini')).toBeTruthy();
    fireEvent.click(connect);
    expect(world.api.accountConnect).toHaveBeenCalledWith('d-mini');
  });

  it('shows a refused check as given under the row, and clears it when a check answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [record({})];
    world.api.check.mockImplementation(() => refused('Too many tries from this computer. Wait a minute.'));
    renderSwitcher();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Too many tries from this computer. Wait a minute.');
    // The reason is said once: the status words stay plain.
    expect(within(region('My computers')).getByText('Offline')).toBeTruthy();
    world.api.check.mockImplementation(() => ok(online()));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(await screen.findByText('Online · Tailscale · 4 shared')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows why Open failed, and clears it on the next try', async () => {
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [record({})];
    world.api.open.mockImplementationOnce(() => refused('Mac mini’s window could not be opened.'));
    renderSwitcher();
    await screen.findByText('Online · Tailscale · 4 shared');
    fireEvent.click(button('Open Mac mini'));
    expect((await screen.findByRole('alert')).textContent).toBe('Mac mini’s window could not be opened.');
    let finish: (v: RemoteResult<null>) => void = () => {};
    world.api.open.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    fireEvent.click(button('Open Mac mini'));
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => finish({ ok: true, data: null }));
  });

  it('renames and removes from the ⋯ menu as a computer paired by link does, then reads the directory again', async () => {
    world.directory = directoryOf(HERE, machine({}));
    world.stored = [record({})];
    renderSwitcher();
    await screen.findByText('Online · Tailscale · 4 shared');
    fireEvent.click(button('More for Mac mini'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Computer name' });
    fireEvent.change(input, { target: { value: 'Office mini' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(world.api.rename).toHaveBeenCalledWith('r-mini', 'Office mini'));
    expect(await screen.findByText('Office mini')).toBeTruthy();

    const reads = world.api.accountMachines.mock.calls.length;
    fireEvent.click(button('More for Office mini'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove…' }));
    expect(world.api.remove).not.toHaveBeenCalled();
    fireEvent.click(button('Remove'));
    await waitFor(() => expect(world.api.remove).toHaveBeenCalledWith('r-mini'));
    // The machine is still on the account: its row goes back to the start, under the directory's name.
    expect(await screen.findByText('Not connected yet')).toBeTruthy();
    const connect = button('Connect Mac mini');
    await waitFor(() => expect(world.api.accountMachines.mock.calls.length).toBe(reads + 1));
    expect(connect).toHaveFocus();
  });

  it('Dismiss forgets a record that waits for Allow at once, and the row offers Connect again', async () => {
    world.directory = directoryOf(HERE, LINUX);
    world.stored = [record({ id: 'r-linux', name: 'Linux box', backendDeviceId: 'd-linux', status: 'pending', confirmCode: '482913' })];
    world.answers = { 'r-linux': pending() };
    renderSwitcher();
    const dismiss = await screen.findByRole('button', { name: 'Dismiss Linux box' });
    const reads = world.api.accountMachines.mock.calls.length;
    dismiss.focus();
    fireEvent.click(dismiss);
    await waitFor(() => expect(world.api.remove).toHaveBeenCalledWith('r-linux'));
    expect(await screen.findByText('Not connected yet')).toBeTruthy();
    expect(screen.queryByText(/Waiting for Allow/)).toBeNull();
    await waitFor(() => expect(world.api.accountMachines.mock.calls.length).toBe(reads + 1));
    expect(button('Connect Linux box')).toHaveFocus();
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('DevicesSwitcher — Connect', () => {
  const waiting: RemoteComputer = record({ id: 'r-imac', name: 'Studio iMac', backendDeviceId: 'd-imac', status: 'pending', confirmCode: '482913' });

  it('runs once, follows the pending record with its code at once, and polls every 3 s until it is allowed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    world.directory = directoryOf(HERE, IMAC);
    let answer: (v: RemoteResult<RemoteComputer>) => void = () => {};
    world.api.accountConnect.mockImplementation(() => new Promise((r) => { answer = r; }));
    renderSwitcher();
    const connect = await screen.findByRole('button', { name: 'Connect Studio iMac' });
    const reads = world.api.accountMachines.mock.calls.length;
    connect.focus();
    fireEvent.click(connect);
    expect(world.api.accountConnect).toHaveBeenCalledWith('d-imac');
    // Running: the words say so, and the button is held without losing focus.
    expect(within(region('My computers')).getByText('Connecting…')).toBeTruthy();
    expect(screen.queryByText('Not connected yet')).toBeNull();
    expect(button('Connect Studio iMac').getAttribute('aria-disabled')).toBe('true');
    expect(button('Connect Studio iMac')).toHaveFocus();
    fireEvent.click(button('Connect Studio iMac'));
    expect(world.api.accountConnect).toHaveBeenCalledTimes(1);

    world.stored = [waiting];
    world.answers = { 'r-imac': pending() };
    await act(async () => answer({ ok: true, data: waiting }));
    expect(screen.getByText('Waiting for Allow on Studio iMac · code 482 913')).toBeTruthy();
    expect(button('Dismiss Studio iMac')).toHaveFocus();
    await waitFor(() => expect(world.api.accountMachines.mock.calls.length).toBe(reads + 1));

    const before = world.api.check.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(world.api.check.mock.calls.length).toBeGreaterThan(before);
    expect(screen.getByText('Waiting for Allow on Studio iMac · code 482 913')).toBeTruthy();

    world.answers = { 'r-imac': online() };
    world.stored = [{ ...waiting, status: 'active', confirmCode: null }];
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(await screen.findByText('Online · Tailscale · 4 shared')).toBeTruthy();
    expect(button('Open Studio iMac').disabled).toBe(false);
    expect(within(region('My computers')).getByText('1 of 1 online')).toBeTruthy();
    // The row said it all: no card to compare a code, no toast.
    expect(screen.queryByRole('status')).toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('stops the 3 s poll after 10 minutes; the row keeps waiting on the 30 s round', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    world.directory = directoryOf(HERE, IMAC);
    world.api.accountConnect.mockImplementation(() => {
      world.stored = [waiting];
      return ok(waiting);
    });
    world.answers = { 'r-imac': pending() };
    renderSwitcher();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Studio iMac' }));
    await screen.findByText('Waiting for Allow on Studio iMac · code 482 913');
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000 + 3_000));
    const calls = world.api.check.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(9_000));
    expect(world.api.check.mock.calls.length).toBe(calls);
    expect(screen.getByText('Waiting for Allow on Studio iMac · code 482 913')).toBeTruthy();
  });

  it('follows a record that needed no Allow straight to its check', async () => {
    const active = record({ id: 'r-imac', name: 'Studio iMac', backendDeviceId: 'd-imac' });
    world.directory = directoryOf(HERE, IMAC);
    world.api.accountConnect.mockImplementation(() => {
      world.stored = [active];
      return ok(active);
    });
    renderSwitcher();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Studio iMac' }));
    expect(await screen.findByText('Online · Tailscale · 4 shared')).toBeTruthy();
    expect(world.api.check).toHaveBeenCalledWith('r-imac');
    expect(button('Open Studio iMac').disabled).toBe(false);
  });

  it('shows why it failed as given, and clears that on the next try', async () => {
    world.directory = directoryOf(HERE, IMAC);
    world.api.accountConnect.mockImplementationOnce(() => refused('Sign in to AASC Cloud again on Studio iMac, then connect.'));
    renderSwitcher();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Studio iMac' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Sign in to AASC Cloud again on Studio iMac, then connect.');
    expect(screen.getByText('Not connected yet')).toBeTruthy();
    expect(button('Connect Studio iMac').getAttribute('aria-disabled')).toBeNull();

    world.api.accountConnect.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(button('Connect Studio iMac'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(world.api.accountConnect).toHaveBeenCalledTimes(2);
  });

  // Electron's own words for a rejected call ("Error invoking remote method 'remote:…': Error: …") are not for people.
  it('says the app could not be reached when the call itself fails', async () => {
    world.directory = directoryOf(HERE, IMAC);
    world.api.accountConnect.mockImplementationOnce(() => Promise.reject(new Error("Error invoking remote method 'remote:accountConnect': Error: No handler registered")));
    renderSwitcher();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Studio iMac' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t reach the AASC app on this computer. Try again.');
  });
});
