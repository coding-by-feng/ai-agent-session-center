// DevicesSwitcher.remove.test.tsx — Remove… on an account computer this one never connected to (Nov 27 2026): the
// row's ⋯ menu signs that device out of the AASC Cloud account (the call Manage devices → Sign out… makes), after a
// question in the row. A stale record of a computer (an old sign-in under the same name) goes this way.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CloudApiError } from '@/lib/cloudApi';
import { HERE, directoryOf, installWorld, machine, renderSwitcher, type World } from './DevicesSwitcher.fixtures';

const cloud = vi.hoisted(() => ({
  status: vi.fn(),
  signOutAccountDevice: vi.fn(),
}));

vi.mock('@/lib/cloudApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cloudApi')>();
  return { ...real, cloudApi: { ...real.cloudApi, ...cloud } };
});
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const CONNECTION = { backendOrigin: 'https://api.aasc.work', accountId: 'acct-1', generation: 7 };
const STALE = machine({ deviceId: 'd-old', name: 'kason-mac', addresses: null });
const AIR = machine({ deviceId: 'd-air', name: 'MacBook-Air-M1' });

let world: World;

beforeEach(() => {
  world = installWorld();
  world.directory = directoryOf(HERE, STALE, AIR);
  cloud.status.mockResolvedValue({ connection: CONNECTION, state: 'connected', lastError: null });
  cloud.signOutAccountDevice.mockImplementation(() => {
    world.directory = directoryOf(HERE, AIR);
    return Promise.resolve({ revoked: true });
  });
});

afterEach(() => {
  delete window.electronAPI;
  vi.clearAllMocks();
});

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const mine = () => screen.getByRole('region', { name: 'My computers' });

async function askToRemove(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: `More for ${name}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove…' }));
}

describe('DevicesSwitcher — Remove… on an account computer not connected yet', () => {
  it('asks in the row first: nothing is signed out until Remove', async () => {
    renderSwitcher();
    await askToRemove('kason-mac');
    const question = await screen.findByText('Remove kason-mac from your AASC Cloud account? It is signed out there.');
    expect(question).toBeTruthy();
    expect(cloud.signOutAccountDevice).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Cancel'));
  });

  it('Cancel keeps the row and asks nothing of the cloud', async () => {
    renderSwitcher();
    await askToRemove('kason-mac');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/from your AASC Cloud account\?/)).toBeNull();
    expect(cloud.signOutAccountDevice).not.toHaveBeenCalled();
    expect(within(mine()).getByText('kason-mac')).toBeTruthy();
  });

  it('Remove signs that device out under the current connection, and the row goes', async () => {
    renderSwitcher();
    await askToRemove('kason-mac');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(within(mine()).queryByText('kason-mac')).toBeNull());
    expect(cloud.signOutAccountDevice).toHaveBeenCalledTimes(1);
    expect(cloud.signOutAccountDevice.mock.calls[0].slice(0, 2)).toEqual(['d-old', CONNECTION]);
    expect(within(mine()).getByText('MacBook-Air-M1')).toBeTruthy();
    // The directory is read again, so the count beside "My computers" follows.
    await waitFor(() => expect(within(mine()).getByText('0 of 1 online')).toBeTruthy());
  });

  it('a refusal keeps the row and says why', async () => {
    cloud.signOutAccountDevice.mockRejectedValue(new CloudApiError('offline', 'AASC Cloud is offline.'));
    renderSwitcher();
    await askToRemove('kason-mac');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect((await screen.findByRole('alert')).textContent).toBe('AASC Cloud is offline.');
    expect(within(mine()).getByText('kason-mac')).toBeTruthy();
  });

  it('says so when this computer is no longer signed in, and asks nothing else', async () => {
    cloud.status.mockResolvedValue({ connection: null, state: 'disconnected', lastError: null });
    renderSwitcher();
    await askToRemove('kason-mac');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Sign in to AASC Cloud on this computer first.');
    expect(cloud.signOutAccountDevice).not.toHaveBeenCalled();
  });

  it('presses once however often Remove is pressed', async () => {
    let finish: (v: { revoked: true }) => void = () => {};
    cloud.signOutAccountDevice.mockImplementation(() => new Promise((r) => { finish = r; }));
    renderSwitcher();
    await askToRemove('kason-mac');
    const remove = await screen.findByRole('button', { name: 'Remove' });
    fireEvent.click(remove);
    await waitFor(() => expect(cloud.signOutAccountDevice).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /Remov/ }));
    expect(cloud.signOutAccountDevice).toHaveBeenCalledTimes(1);
    finish({ revoked: true });
  });

  it('this computer’s own row has no menu', async () => {
    renderSwitcher();
    await screen.findByRole('button', { name: 'More for kason-mac' });
    const here = screen.getByRole('region', { name: 'This computer' });
    expect(within(here).queryByRole('button')).toBeNull();
  });
});
