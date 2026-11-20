// AccountDevices.signOut.test.tsx — signing a device out of the account from RESOURCES → Machines (plan 18): it
// asks first, in the row; it carries the reviewed connection; the row goes and focus moves on.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import {
  CONNECTION, DEVICES_URL, here, installCloud, json, mini, phone, refusal, showDevices, type FakeCloud,
} from './AccountDevices.fixtures';

const QUESTION = 'Sign out Mac mini? It has to sign in again to use your account. Computers signed in to your account disconnect it within 5 minutes.';

let cloud: FakeCloud;

beforeEach(() => {
  cloud = installCloud();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const row = (name: RegExp) => screen.getByRole('row', { name });

async function listed(): Promise<HTMLElement> {
  showDevices();
  const region = await screen.findByRole('region', { name: 'Devices on your account' });
  await within(region).findByText('Mac mini');
  return region;
}

describe('AccountDevices — Sign out…', () => {
  it('asks first, in the row: Cancel first and focused, and nothing where Sign out… was', async () => {
    await listed();
    const ask = button('Sign out Mac mini…');
    ask.focus();
    fireEvent.click(ask);
    const mine = row(/Mac mini/);
    expect(within(mine).getByText(QUESTION)).toBeTruthy();
    const actions = within(mine).getAllByRole('button');
    expect(actions.map((b) => b.textContent)).toEqual(['Cancel', 'Sign out']);
    expect(actions[0]).toHaveFocus();
    // The action column is still there, and empty: a second click where Sign out… was presses nothing.
    const cells = within(mine).getAllByRole('cell');
    expect(cells).toHaveLength(2);
    expect(cells[1].textContent).toBe('');
    expect(within(cells[1]).queryByRole('button')).toBeNull();
    expect(cloud.signOuts()).toHaveLength(0);
    // The other rows are as they were.
    expect(button('Sign out Kason’s iPhone…')).toBeTruthy();
  });

  it('Cancel puts the row back and focus on its Sign out…', async () => {
    await listed();
    fireEvent.click(button('Sign out Mac mini…'));
    fireEvent.click(within(row(/Mac mini/)).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(button('Sign out Mac mini…')).toHaveFocus();
    expect(within(row(/Mac mini/)).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Mac · macOS · Full 2.10.80', 'Last used 2 h ago', 'Sign out…']);
    expect(cloud.signOuts()).toHaveLength(0);
  });

  it('sends the sign-out with the connection it was reviewed under; the row goes, focus moves to the next row’s action, and the list is read again', async () => {
    await listed();
    const lists = cloud.lists().length;
    fireEvent.click(button('Sign out Mac mini…'));
    fireEvent.click(within(row(/Mac mini/)).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(cloud.signOuts()).toHaveLength(1));
    const sent = cloud.signOuts()[0];
    expect(sent.url).toBe(`${DEVICES_URL}/dev-mini`);
    expect(sent.headers).toMatchObject({
      'x-aasc-cloud-backend': CONNECTION.backendOrigin,
      'x-aasc-cloud-account': CONNECTION.accountId,
      'x-aasc-cloud-generation': String(CONNECTION.generation),
      'content-type': 'application/json',
    });
    await waitFor(() => expect(screen.queryByText('Mac mini')).toBeNull());
    expect(button('Sign out Kason’s iPhone…')).toHaveFocus();
    await waitFor(() => expect(cloud.lists()).toHaveLength(lists + 1));
    await act(async () => {});
    // Once, not once for the sign-out and once more for the row that went.
    expect(cloud.lists()).toHaveLength(lists + 1);
    expect(screen.getByText('MacBook Pro')).toBeTruthy();
  });

  it('from the last row, focus moves to the row before it', async () => {
    await listed();
    fireEvent.click(button('Sign out Kason’s iPhone…'));
    fireEvent.click(within(row(/Kason’s iPhone/)).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByText('Kason’s iPhone')).toBeNull());
    expect(button('Sign out Mac mini…')).toHaveFocus();
  });

  it('when no other device is left, focus moves to the section’s heading', async () => {
    cloud.devices = [here(), mini()];
    const region = await listed();
    fireEvent.click(button('Sign out Mac mini…'));
    fireEvent.click(within(row(/Mac mini/)).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByText('Mac mini')).toBeNull());
    const focused = document.activeElement as HTMLElement;
    expect(region.contains(focused)).toBe(true);
    expect(within(focused).getByRole('heading', { name: 'Devices on your account' })).toBeTruthy();
    expect(within(region).queryByRole('button', { name: /^Sign out/ })).toBeNull();
  });

  it('a second press while the sign-out is out does nothing', async () => {
    let land: (r: Response) => void = () => {};
    cloud.onSignOut = () => new Promise<Response>((r) => { land = r; });
    await listed();
    fireEvent.click(button('Sign out Mac mini…'));
    const confirm = within(row(/Mac mini/)).getByRole('button', { name: 'Sign out' }) as HTMLButtonElement;
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(cloud.signOuts()).toHaveLength(1));
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    // Held, not disabled: focus stays where it is.
    expect(confirm.disabled).toBe(false);
    cloud.devices = [here(), phone()];
    await act(async () => land(json(200, { success: true, data: { revoked: true } })));
    await waitFor(() => expect(screen.queryByText('Mac mini')).toBeNull());
    expect(cloud.signOuts()).toHaveLength(1);
  });

  it.each([
    [409, 'own_device', 'Sign out of AASC Cloud on this computer instead.'],
    [404, 'device_not_found', 'That device isn’t on this AASC Cloud account any more.'],
    [400, 'invalid_input', 'Not a device id.'],
    [502, 'cloud_unavailable', 'AASC Cloud didn’t answer. Try again.'],
  ])('when the server refuses (%i %s), the row stays and its words show', async (status, code, message) => {
    cloud.onSignOut = () => refusal(status, code, message);
    await listed();
    fireEvent.click(button('Sign out Mac mini…'));
    fireEvent.click(within(row(/Mac mini/)).getByRole('button', { name: 'Sign out' }));
    const mine = row(/Mac mini/);
    expect((await within(mine).findByRole('alert')).textContent).toBe(message);
    expect(within(mine).getByText(QUESTION)).toBeTruthy();
    expect(within(mine).getByRole('button', { name: 'Sign out' }).getAttribute('aria-busy')).toBeNull();
    // Cancel leaves the row as it was, with no error left on it.
    fireEvent.click(within(mine).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button('Sign out Mac mini…')).toBeTruthy();
  });

  // The page's review of the connection is stale (another window signed in again). The row says what to do here,
  // in its own words: neither the cloud views' stock sentence about a draft, nor the server's "review this action".
  it.each([
    'The cloud connection changed. Refresh and review this action again.',
    'A current cloud connection review is required.',
  ])('connection_changed (%s): says to check again, keeps the row, and reads the list again', async (serverWords) => {
    cloud.onSignOut = () => refusal(409, 'connection_changed', serverWords);
    await listed();
    const lists = cloud.lists().length;
    fireEvent.click(button('Sign out Mac mini…'));
    fireEvent.click(within(row(/Mac mini/)).getByRole('button', { name: 'Sign out' }));
    const mine = row(/Mac mini/);
    expect((await within(mine).findByRole('alert')).textContent).toBe('The cloud connection changed. Check again, then sign it out.');
    await waitFor(() => expect(cloud.lists()).toHaveLength(lists + 1));
    expect(within(row(/Mac mini/)).getByText(QUESTION)).toBeTruthy();
    expect(screen.queryByText(/draft|review/)).toBeNull();
  });

  // Without this the page kept its old review of the connection until the status poll, 15 s later, and every
  // retry in between was refused again.
  it('connection_changed: the page reads the connection again at once, so a retry carries the new one', async () => {
    cloud.onSignOut = () => {
      // Another window signed in again: the same account, a newer connection.
      cloud.connection = { ...CONNECTION, generation: 8 };
      return refusal(409, 'connection_changed', 'The cloud connection changed. Refresh and review this action again.');
    };
    await listed();
    const statusReads = () => cloud.calls.filter((c) => c.url.endsWith('/status')).length;
    const before = statusReads();
    fireEvent.click(button('Sign out Mac mini…'));
    const confirm = within(row(/Mac mini/)).getByRole('button', { name: 'Sign out' });
    fireEvent.click(confirm);
    await within(row(/Mac mini/)).findByRole('alert');
    await waitFor(() => expect(statusReads()).toBe(before + 1));
    await act(async () => {});
    // The same account: the row is still asking, with its line still there.
    expect(within(row(/Mac mini/)).getByText(QUESTION)).toBeTruthy();

    cloud.onSignOut = (id) => {
      cloud.devices = cloud.devices.filter((d) => d.id !== id);
      return json(200, { success: true, data: { revoked: true } });
    };
    fireEvent.click(within(row(/Mac mini/)).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(cloud.signOuts()).toHaveLength(2));
    expect(cloud.signOuts().map((c) => c.headers['x-aasc-cloud-generation'])).toEqual(['7', '8']);
    await waitFor(() => expect(screen.queryByText('Mac mini')).toBeNull());
  });

  it('connection_changed because another account signed in: the section starts afresh for that account', async () => {
    cloud.onSignOut = () => {
      cloud.connection = { ...CONNECTION, accountId: '7f0c1d2e-3a4b-4c5d-8e6f-0a1b2c3d4e5f', generation: 1 };
      cloud.devices = [here()];
      return refusal(409, 'connection_changed', 'The cloud connection changed. Refresh and review this action again.');
    };
    await listed();
    fireEvent.click(button('Sign out Mac mini…'));
    fireEvent.click(within(row(/Mac mini/)).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByText('Mac mini')).toBeNull());
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await screen.findByText('MacBook Pro')).toBeTruthy();
  });

  // Whatever a sign-out came to, the list says what is true now: it is read once more after every one.
  it('a refusal reads the list again once; a device that is still there keeps its row and its message', async () => {
    cloud.onSignOut = () => refusal(409, 'own_device', 'Sign out of AASC Cloud on this computer instead.');
    await listed();
    const lists = cloud.lists().length;
    fireEvent.click(button('Sign out Mac mini…'));
    fireEvent.click(within(row(/Mac mini/)).getByRole('button', { name: 'Sign out' }));
    await within(row(/Mac mini/)).findByRole('alert');
    await waitFor(() => expect(cloud.lists()).toHaveLength(lists + 1));
    await act(async () => {});
    expect(cloud.lists()).toHaveLength(lists + 1);
    expect(within(row(/Mac mini/)).getByRole('alert').textContent).toBe('Sign out of AASC Cloud on this computer instead.');
  });

  it('device_not_found: the device is gone, so its row goes with the fresh list', async () => {
    cloud.onSignOut = () => {
      cloud.devices = [here(), phone()];
      return refusal(404, 'device_not_found', 'That device isn’t on this AASC Cloud account any more.');
    };
    await listed();
    fireEvent.click(button('Sign out Mac mini…'));
    fireEvent.click(within(row(/Mac mini/)).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByText('Mac mini')).toBeNull());
    expect(screen.getByText('Kason’s iPhone')).toBeTruthy();
  });

  // The connection is read again while the DELETE is out (the 15 s status poll finds a newer one): the row's own
  // follow-up is cancelled with the old connection, and the row used to stay, saying nothing, for a device
  // that was in fact signed out.
  it('a sign-out that worked while the connection was read again still shows: the list is read and the row goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let land: (r: Response) => void = () => {};
    cloud.onSignOut = () => new Promise<Response>((r) => { land = r; });
    await listed();
    fireEvent.click(button('Sign out Mac mini…'));
    fireEvent.click(within(row(/Mac mini/)).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(cloud.signOuts()).toHaveLength(1));
    cloud.connection = { ...CONNECTION, generation: 8 };
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    const lists = cloud.lists().length;
    cloud.devices = [here(), phone()];
    await act(async () => land(json(200, { success: true, data: { revoked: true } })));
    await waitFor(() => expect(cloud.lists()).toHaveLength(lists + 1));
    await waitFor(() => expect(screen.queryByText('Mac mini')).toBeNull());
    expect(screen.getByText('Kason’s iPhone')).toBeTruthy();
  });

  it('a sign-out that never gets an answer says so in the page’s words, not the browser’s', async () => {
    cloud.onSignOut = () => Promise.reject(new TypeError('Failed to fetch'));
    await listed();
    fireEvent.click(button('Sign out Mac mini…'));
    fireEvent.click(within(row(/Mac mini/)).getByRole('button', { name: 'Sign out' }));
    expect((await within(row(/Mac mini/)).findByRole('alert')).textContent).toBe('Couldn’t sign out Mac mini. Try again.');
  });

  it('an error goes when the sign-out is tried again', async () => {
    cloud.onSignOut = () => refusal(502, 'cloud_unavailable', 'AASC Cloud didn’t answer. Try again.');
    await listed();
    fireEvent.click(button('Sign out Mac mini…'));
    const confirm = within(row(/Mac mini/)).getByRole('button', { name: 'Sign out' });
    fireEvent.click(confirm);
    await within(row(/Mac mini/)).findByRole('alert');
    cloud.onSignOut = () => new Promise<Response>(() => {});
    fireEvent.click(confirm);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a list that was read before the sign-out does not bring the row back', async () => {
    const region = await listed();
    const before = [here(), mini(), phone()];
    // Only the first read from here on is answered, late; the one the sign-out starts never is.
    const reads: Array<(r: Response) => void> = [];
    cloud.onList = () => new Promise<Response>((r) => { reads.push(r); });
    fireEvent.click(within(region).getByRole('button', { name: 'Check again' }));
    expect(reads).toHaveLength(1);
    fireEvent.click(button('Sign out Mac mini…'));
    fireEvent.click(within(row(/Mac mini/)).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByText('Mac mini')).toBeNull());
    await waitFor(() => expect(reads).toHaveLength(2));
    await act(async () => reads[0](json(200, { success: true, data: { devices: before } })));
    expect(screen.queryByText('Mac mini')).toBeNull();
    expect(screen.getByText('Kason’s iPhone')).toBeTruthy();
  });
});
