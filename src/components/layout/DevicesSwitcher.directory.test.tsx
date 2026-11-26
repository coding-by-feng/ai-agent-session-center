// DevicesSwitcher.directory.test.tsx — what the Switch part says for each state of the account's directory, and
// when it reads the directory (plan 18 stage 2).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { useLocation } from 'react-router';
import type { AccountDirectory, RemoteComputer, RemoteResult } from '@/types/electron';
import {
  HERE, directoryOf, installWorld, linked, machine, ok, record, refused, renderSwitcher, type World,
} from './DevicesSwitcher.fixtures';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const SIGNED_OUT = 'Sign in to AASC Cloud to list your computers.';
const NEEDS_SIGN_IN = 'This computer signed in before its computers could be listed. Sign out of AASC Cloud and sign in again.';
const UNREACHABLE = 'Can’t reach AASC Cloud. Computers you already connected still work.';
const UNSUPPORTED = 'AASC Cloud can’t list your account’s computers yet. Computers you already connected still work.';
const ONLY_THIS_ONE = 'Sign in on another computer with the same Google account and it shows up here.';

/** Where the router is, for the one action that leaves the panel. */
function Where() {
  const location = useLocation();
  return <span data-testid="where">{location.pathname + location.search}</span>;
}

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
const reads = () => world.api.accountMachines.mock.calls.length;

/** The link list stays usable under whatever the directory says. */
async function expectLinkListUsable(): Promise<void> {
  const byLink = await screen.findByRole('region', { name: 'Paired by link' });
  expect(await within(byLink).findByText('Online · Tailscale · 4 shared')).toBeTruthy();
  expect(button('Open Old NUC').disabled).toBe(false);
  expect(button('+ Add a computer by link')).toBeTruthy();
}

describe('DevicesSwitcher — the directory’s states', () => {
  it('says "Checking…" until the first read answers', async () => {
    world.stored = [linked()];
    world.api.accountMachines.mockImplementation(() => new Promise(() => {}));
    renderSwitcher();
    expect((await screen.findAllByRole('status')).some((el) => el.textContent === 'Checking…')).toBe(true);
    await expectLinkListUsable();
  });

  it.each([
    ['signed-out', SIGNED_OUT],
    ['needs-sign-in', NEEDS_SIGN_IN],
  ] as const)('%s: one line, and "Open AASC Cloud" goes to the account dialog on RESOURCES', async (state, words) => {
    world.directory = { state, machines: [] };
    world.stored = [linked()];
    const onLeave = vi.fn();
    renderSwitcher(onLeave, <Where />);
    expect(await screen.findByText(words)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'This computer' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'My computers' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await expectLinkListUsable();
    expect(screen.getByTestId('where').textContent).toBe('/');
    fireEvent.click(button('Open AASC Cloud'));
    expect(screen.getByTestId('where').textContent).toBe('/resources?account=1');
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('unreachable: one line with Retry, and the account computers already connected stay usable', async () => {
    world.directory = { state: 'unreachable', machines: [] };
    world.stored = [record({}), linked()];
    renderSwitcher();
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open AASC Cloud' })).toBeNull();
    const mine = screen.getByRole('region', { name: 'My computers' });
    expect(await within(mine).findByText('Online · Tailscale · 4 shared')).toBeTruthy();
    expect(within(mine).getByText('1 of 1 online')).toBeTruthy();
    expect(button('Open Mac mini').disabled).toBe(false);
    expect(within(screen.getByRole('region', { name: 'Paired by link' })).queryByText('Mac mini')).toBeNull();
    expect(screen.queryByRole('region', { name: 'This computer' })).toBeNull();
    await expectLinkListUsable();

    const before = reads();
    world.directory = directoryOf(HERE, machine({}));
    fireEvent.click(button('Retry'));
    await waitFor(() => expect(reads()).toBe(before + 1));
    await waitFor(() => expect(screen.queryByText(UNREACHABLE)).toBeNull());
    expect(screen.getByRole('region', { name: 'This computer' })).toBeTruthy();
    expect(screen.getAllByText('Mac mini')).toHaveLength(1);
  });

  it('unsupported: says the cloud can’t list computers yet, with no Retry, and links still work', async () => {
    world.directory = { state: 'unsupported', machines: [] };
    world.stored = [linked()];
    renderSwitcher();
    expect(await screen.findByText(UNSUPPORTED)).toBeTruthy();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open AASC Cloud' })).toBeNull();
    await expectLinkListUsable();
  });

  it('a read that fails outright shows its reason as given, with Retry', async () => {
    world.stored = [linked()];
    world.api.accountMachines.mockImplementation(() => refused<AccountDirectory>('This window may not ask for the account’s computers.'));
    renderSwitcher();
    expect((await screen.findByRole('alert')).textContent).toBe('This window may not ask for the account’s computers.');
    expect(button('Retry')).toBeTruthy();
    await expectLinkListUsable();
  });

  it('a read whose call fails says the app could not be reached, not Electron’s own words', async () => {
    world.stored = [linked()];
    world.api.accountMachines.mockImplementation(() => Promise.reject(new Error("Error invoking remote method 'remote:accountMachines': Error: boom")));
    renderSwitcher();
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t reach the AASC app on this computer. Try again.');
    expect(button('Retry')).toBeTruthy();
  });

  it.each([
    ['unreachable', () => ok<AccountDirectory>({ state: 'unreachable', machines: [] }), UNREACHABLE],
    ['a failed read', () => refused<AccountDirectory>('This window may not ask for the account’s computers.'), 'This window may not ask for the account’s computers.'],
  ])('Retry after %s says "Checking…" while its read is out, and keeps the button', async (_label, respond, words) => {
    world.api.accountMachines.mockImplementation(respond);
    renderSwitcher();
    expect(await screen.findByText(words)).toBeTruthy();
    let answer: (v: RemoteResult<AccountDirectory>) => void = () => {};
    world.api.accountMachines.mockImplementation(() => new Promise((r) => { answer = r; }));
    const retry = button('Retry');
    retry.focus();
    fireEvent.click(retry);
    expect(screen.getByRole('status').textContent).toBe('Checking…');
    expect(screen.queryByText(words)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button('Retry')).toHaveFocus();
    expect(button('Retry').getAttribute('aria-busy')).toBe('true');
    await act(async () => answer(await respond()));
    expect(screen.getByText(words)).toBeTruthy();
    expect(screen.queryByText('Checking…')).toBeNull();
    expect(button('Retry').getAttribute('aria-busy')).toBeNull();
  });

  it('ok with no computer but this one: says how another shows up, with no action', async () => {
    world.stored = [linked()];
    renderSwitcher();
    expect(await screen.findByText(ONLY_THIS_ONE)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'This computer' })).getByText('MacBook Pro')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'My computers' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open AASC Cloud' })).toBeNull();
    await expectLinkListUsable();
  });

  it('ok with other computers: none of the lines', async () => {
    world.directory = directoryOf(HERE, machine({}));
    renderSwitcher();
    expect(await screen.findByText('Not connected yet')).toBeTruthy();
    for (const words of [SIGNED_OUT, NEEDS_SIGN_IN, UNREACHABLE, ONLY_THIS_ONE, 'Checking…']) expect(screen.queryByText(words)).toBeNull();
  });
});

describe('DevicesSwitcher — Manage devices…', () => {
  const MACHINES = '/resources?section=machines';

  it('with the directory listed: a link beside "+ Add a computer by link" that goes to RESOURCES → Machines and closes the panel', async () => {
    world.directory = directoryOf(HERE, machine({}));
    const onLeave = vi.fn();
    renderSwitcher(onLeave, <Where />);
    const link = await screen.findByRole('link', { name: 'Manage devices…' });
    expect(link.getAttribute('href')).toBe(MACHINES);
    // Beside the add button: the two share one footer row (which wraps when the panel is too narrow for both).
    expect(link.parentElement).toBe(button('+ Add a computer by link').parentElement);
    expect(button('+ Add a computer by link').compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(link);
    expect(screen.getByTestId('where').textContent).toBe(MACHINES);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('is there with only this computer on the account too', async () => {
    renderSwitcher(() => {}, <Where />);
    await screen.findByText(ONLY_THIS_ONE);
    expect(screen.getByRole('link', { name: 'Manage devices…' })).toBeTruthy();
  });

  it.each<[string, () => Promise<RemoteResult<AccountDirectory>>, string | RegExp]>([
    ['the first read is out', () => new Promise(() => {}), 'Checking…'],
    ['signed-out', () => ok({ state: 'signed-out', machines: [] }), SIGNED_OUT],
    ['needs-sign-in', () => ok({ state: 'needs-sign-in', machines: [] }), NEEDS_SIGN_IN],
    ['unreachable', () => ok({ state: 'unreachable', machines: [] }), UNREACHABLE],
    ['the read failed', () => refused('This window may not ask for the account’s computers.'), /may not ask/],
  ])('is absent while %s', async (_label, respond, words) => {
    world.api.accountMachines.mockImplementation(respond);
    renderSwitcher(() => {}, <Where />);
    await screen.findByText(words);
    await screen.findByRole('button', { name: '+ Add a computer by link' });
    expect(screen.queryByRole('link', { name: 'Manage devices…' })).toBeNull();
    expect(screen.queryByText(/Manage devices/)).toBeNull();
  });

  it('gives way to the pairing-link form, and is back when the form closes', async () => {
    world.directory = directoryOf(HERE, machine({}));
    renderSwitcher(() => {}, <Where />);
    await screen.findByRole('link', { name: 'Manage devices…' });
    fireEvent.click(button('+ Add a computer by link'));
    expect(screen.getByRole('textbox', { name: 'Pairing link' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Manage devices…' })).toBeNull();
    fireEvent.click(button('Cancel'));
    expect(screen.getByRole('link', { name: 'Manage devices…' })).toBeTruthy();
  });
});

describe('DevicesSwitcher — a machine that signed in before it could take a connection', () => {
  const IMAC = machine({ deviceId: 'd-imac', name: 'Studio iMac', connectable: false });

  it('says what to do there, with no Connect here, in line with the other rows', async () => {
    world.directory = directoryOf(HERE, IMAC, machine({}));
    renderSwitcher();
    const line = await screen.findByText('Sign in to AASC Cloud again on Studio iMac to connect it.');
    const row = line.closest('li') as HTMLElement;
    expect(within(row).getByText('Studio iMac')).toBeTruthy();
    // Only the ⋯ menu (Remove…, Nov 27 2026): an old sign-in is what a person may want off the account.
    expect(within(row).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['More for Studio iMac']);
    expect(within(row).queryByText('Not connected yet')).toBeNull();
    // The place of the action is kept, so the row is as tall as its neighbours.
    expect(row.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(1);
    expect(button('Connect Mac mini')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'My computers' })).getByText('0 of 2 online')).toBeTruthy();
  });

  it('keeps the row of a record this computer already holds for it', async () => {
    world.directory = directoryOf(HERE, IMAC);
    world.stored = [record({ id: 'r-imac', name: 'Studio iMac', backendDeviceId: 'd-imac' })];
    renderSwitcher();
    expect(await screen.findByText('Online · Tailscale · 4 shared')).toBeTruthy();
    expect(button('Open Studio iMac').disabled).toBe(false);
    expect(screen.queryByText(/Sign in to AASC Cloud again on Studio iMac/)).toBeNull();
  });
});

describe('DevicesSwitcher — reading the directory', () => {
  it('reads on open and every 60 s, never two reads at once, and none after it closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer: (v: RemoteResult<AccountDirectory>) => void = () => {};
    world.api.accountMachines.mockImplementation(() => new Promise((r) => { answer = r; }));
    const { unmount } = renderSwitcher();
    await waitFor(() => expect(reads()).toBe(1));
    // The first read is still out: the 60 s rounds wait for it.
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(reads()).toBe(1);
    await act(async () => answer({ ok: true, data: directoryOf(HERE, machine({})) }));
    expect(await screen.findByText('Not connected yet')).toBeTruthy();
    expect(reads()).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(reads()).toBe(2);
    await act(async () => answer({ ok: true, data: directoryOf(HERE, machine({})) }));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(reads()).toBe(3);

    unmount();
    await act(async () => answer({ ok: true, data: directoryOf(HERE) }));
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(reads()).toBe(3);
  });

  it('a Retry pressed while a read is out starts one more when it lands, never a second beside it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    world.directory = { state: 'unreachable', machines: [] };
    renderSwitcher();
    await screen.findByRole('button', { name: 'Retry' });
    expect(reads()).toBe(1);
    const out: Array<(v: RemoteResult<AccountDirectory>) => void> = [];
    world.api.accountMachines.mockImplementation(() => new Promise((r) => { out.push(r); }));
    fireEvent.click(button('Retry'));
    expect(reads()).toBe(2);
    fireEvent.click(button('Retry'));
    fireEvent.click(button('Retry'));
    expect(reads()).toBe(2);
    await act(async () => out[0]({ ok: true, data: { state: 'unreachable', machines: [] } }));
    expect(reads()).toBe(3);
    await act(async () => out[1]({ ok: true, data: directoryOf(HERE, machine({})) }));
    expect(await screen.findByText('Not connected yet')).toBeTruthy();
    expect(reads()).toBe(3);
  });

  it('a read that is out when the panel closes changes nothing and starts nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer: (v: RemoteResult<AccountDirectory>) => void = () => {};
    world.api.accountMachines.mockImplementation(() => new Promise((r) => { answer = r; }));
    const { unmount } = renderSwitcher();
    await waitFor(() => expect(reads()).toBe(1));
    unmount();
    await act(async () => answer({ ok: true, data: directoryOf(HERE) }));
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(reads()).toBe(1);
  });

  it('a Connect that answers after the panel closed starts no check and no read', async () => {
    world.directory = directoryOf(HERE, machine({}));
    let connected: (v: RemoteResult<RemoteComputer>) => void = () => {};
    world.api.accountConnect.mockImplementation(() => new Promise((r) => { connected = r; }));
    const { unmount } = renderSwitcher();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Mac mini' }));
    expect(world.api.accountConnect).toHaveBeenCalledWith('d-mini');
    const before = reads();
    unmount();
    await act(async () => connected({ ok: true, data: record({}) }));
    expect(world.api.check).not.toHaveBeenCalled();
    expect(reads()).toBe(before);
  });
});
