// AccountDevices.test.tsx — RESOURCES → Machines › Devices on your account (plan 18): when the section shows, what
// a row says, and the one line for each state the list can be in. Signing a device out is
// AccountDevices.signOut.test.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import {
  device, here, installCloud, mini, phone, refusal, showDevices, type FakeCloud,
} from './AccountDevices.fixtures';

const NEEDS_SIGN_IN = 'This computer signed in before devices could be listed. Sign out of AASC Cloud and sign in again.';
const UNREACHABLE = 'Can’t reach AASC Cloud.';

let cloud: FakeCloud;

beforeEach(() => {
  cloud = installCloud();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const section = () => screen.findByRole('region', { name: 'Devices on your account' });
const row = (name: RegExp) => screen.getByRole('row', { name });
/** The status read has landed and nothing further is on its way. */
async function settled(): Promise<void> {
  await waitFor(() => expect(cloud.calls.some((c) => c.url.endsWith('/status'))).toBe(true));
  await act(async () => {});
}

describe('AccountDevices — when the section shows', () => {
  it('is absent on a computer that is not connected to AASC Cloud, and asks for no list', async () => {
    cloud.state = 'none';
    const { container } = showDevices();
    await settled();
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('region', { name: 'Devices on your account' })).toBeNull();
    expect(cloud.lists()).toHaveLength(0);
  });

  it('is absent once this computer’s access was revoked', async () => {
    cloud.state = 'revoked';
    const { container } = showDevices();
    await settled();
    expect(container.textContent).toBe('');
    expect(cloud.lists()).toHaveLength(0);
  });

  it('reads nothing while Machines is not the tab in front, then reads when it opens, and again each time it opens', async () => {
    const view = showDevices({ open: false });
    await settled();
    expect(cloud.lists()).toHaveLength(0);
    view.setOpen(true);
    await within(await section()).findByText('Mac mini');
    expect(cloud.lists()).toHaveLength(1);
    view.setOpen(false);
    await act(async () => {});
    expect(cloud.lists()).toHaveLength(1);
    view.setOpen(true);
    await waitFor(() => expect(cloud.lists()).toHaveLength(2));
    // The rows stay on screen while it reads again.
    expect(screen.getByText('Mac mini')).toBeTruthy();
  });

  it('is absent when the server says this computer is not connected after all', async () => {
    cloud.onList = () => refusal(409, 'not_connected', 'This computer isn’t signed in to AASC Cloud.');
    const { container } = showDevices();
    await waitFor(() => expect(cloud.lists()).toHaveLength(1));
    await act(async () => {});
    expect(container.textContent).toBe('');
  });
});

describe('AccountDevices — the list', () => {
  it('draws a table in the server’s order: name, kind and system in words, when it was last used, one action', async () => {
    showDevices();
    const table = await within(await section()).findByRole('table', { name: 'Devices on your account' });
    await within(table).findByText('Mac mini');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Kind', 'Last used', 'Actions']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['MacBook Prothis computer', 'Mac mini', 'Kason’s iPhone']);

    const miniCells = within(row(/Mac mini/)).getAllByRole('cell').map((c) => c.textContent);
    expect(miniCells).toEqual(['Mac · macOS · Full 2.10.80', 'Last used 2 h ago', 'Sign out…']);
    const phoneCells = within(row(/Kason’s iPhone/)).getAllByRole('cell').map((c) => c.textContent);
    expect(phoneCells).toEqual(['Phone · iOS · 1.1.0', 'Never used', 'Sign out…']);
    expect(screen.getByRole('button', { name: 'Sign out Mac mini…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out Kason’s iPhone…' })).toBeTruthy();
  });

  it('marks this computer’s row and gives it no action', async () => {
    showDevices();
    await within(await section()).findByText('Mac mini');
    const mine = row(/MacBook Pro/);
    expect(within(mine).getByText('this computer')).toBeTruthy();
    expect(within(mine).queryByRole('button')).toBeNull();
    expect(within(mine).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Mac · macOS · Full 2.10.80', 'Last used just now', '']);
  });

  it('leaves out what the account does not know, and shows a code it does not know as given', async () => {
    cloud.devices = [
      here(),
      device({ id: 'a', name: 'Old box', kind: null, platform: null, edition: null, appVersion: null }),
      device({ id: 'b', name: 'Tab', kind: 'tablet', platform: 'ipados', edition: null, appVersion: null }),
    ];
    showDevices();
    await within(await section()).findByText('Old box');
    expect(within(row(/Old box/)).getAllByRole('cell')[0].textContent).toBe('');
    expect(within(row(/^Tab/)).getAllByRole('cell')[0].textContent).toBe('tablet · ipados');
  });

  it('with only this computer on the account: its row, and no line beside it', async () => {
    cloud.devices = [here()];
    showDevices();
    const region = await section();
    await within(region).findByText('MacBook Pro');
    expect(within(region).getAllByRole('row')).toHaveLength(2);
    expect(within(region).queryByRole('alert')).toBeNull();
    expect(within(region).queryByRole('status')).toBeNull();
    expect(within(region).getAllByRole('button').map((b) => b.textContent)).toEqual(['Check again']);
  });
});

describe('AccountDevices — the states of the list', () => {
  it('says "Checking…" until the first list lands', async () => {
    let land: (r: Response) => void = () => {};
    const list = cloud.onList;
    cloud.onList = () => new Promise<Response>((r) => { land = r; });
    showDevices();
    const region = await section();
    expect(within(region).getByRole('status').textContent).toBe('Checking…');
    expect(within(region).queryByRole('table')).toBeNull();
    await act(async () => land(await list()));
    expect(await within(region).findByText('Mac mini')).toBeTruthy();
    expect(within(region).queryByText('Checking…')).toBeNull();
  });

  it('needs_sign_in: one line, and the way to the cloud account', async () => {
    cloud.onList = () => refusal(409, 'needs_sign_in', 'Sign in again to list devices.');
    const { onAccount } = showDevices();
    const region = await section();
    expect(await within(region).findByText(NEEDS_SIGN_IN)).toBeTruthy();
    expect(within(region).queryByRole('table')).toBeNull();
    expect(within(region).queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'Open cloud account' }));
    expect(onAccount).toHaveBeenCalledTimes(1);
  });

  it('cloud_unavailable: one line with Retry, which says "Checking…" while it reads and keeps the button', async () => {
    cloud.onList = () => refusal(502, 'cloud_unavailable', 'AASC Cloud did not answer.');
    showDevices();
    const region = await section();
    expect(await within(region).findByText(UNREACHABLE)).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Open cloud account' })).toBeNull();

    let land: (r: Response) => void = () => {};
    cloud.onList = () => new Promise<Response>((r) => { land = r; });
    const retry = within(region).getByRole('button', { name: 'Retry' });
    retry.focus();
    fireEvent.click(retry);
    expect(within(region).getByRole('status').textContent).toBe('Checking…');
    expect(within(region).queryByText(UNREACHABLE)).toBeNull();
    expect(within(region).getByRole('button', { name: 'Retry' })).toHaveFocus();
    // A second press while the read is out asks nothing more.
    fireEvent.click(within(region).getByRole('button', { name: 'Retry' }));
    expect(cloud.lists()).toHaveLength(2);

    cloud.devices = [here(), mini()];
    await act(async () => land(new Response(JSON.stringify({ success: true, data: { devices: cloud.devices } }), { status: 200 })));
    expect(await within(region).findByText('Mac mini')).toBeTruthy();
    expect(within(region).queryByText(UNREACHABLE)).toBeNull();
  });

  it('any other refusal shows the server’s own words, with Retry', async () => {
    cloud.onList = () => refusal(500, 'cloud_error', 'The device list could not be read.');
    showDevices();
    const region = await section();
    expect((await within(region).findByRole('alert')).textContent).toBe('The device list could not be read.');
    expect(within(region).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('a row that cannot be read is left out, and the rows around it show; a very long name is listed', async () => {
    const long = `Workshop ${'M'.repeat(240)}`;
    cloud.onList = () => new Response(JSON.stringify({ success: true, data: { devices: [
      here(), { id: 'odd', name: 7 }, mini(), 'not a row', device({ id: 'dev-long', name: long }),
    ] } }), { status: 200 });
    showDevices();
    const region = await section();
    await within(region).findByText('Mac mini');
    expect(within(region).getAllByRole('row').slice(1).map((r) => within(r).getByRole('rowheader').textContent))
      .toEqual(['MacBook Prothis computer', 'Mac mini', long]);
    expect(within(region).getByTitle(long)).toBeTruthy();
    expect(within(region).queryByRole('alert')).toBeNull();
  });

  it('a list with no row it could read draws no empty table, and no error either', async () => {
    cloud.onList = () => new Response(JSON.stringify({ success: true, data: { devices: [{ id: 'odd', name: 7 }, null] } }), { status: 200 });
    showDevices();
    const region = await section();
    expect(await within(region).findByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(within(region).queryByRole('table')).toBeNull();
    expect(within(region).queryByRole('columnheader')).toBeNull();
    expect(within(region).queryByRole('alert')).toBeNull();
  });

  it('an answer that is not a device list is not shown as one', async () => {
    cloud.onList = () => new Response(JSON.stringify({ success: true, data: { devices: 'nope' } }), { status: 200 });
    showDevices();
    const region = await section();
    expect((await within(region).findByRole('alert')).textContent).toBe('Couldn’t list the devices on your account.');
    expect(within(region).queryByRole('table')).toBeNull();
  });

  it('a refresh that fails keeps the rows, and says they may be out of date', async () => {
    showDevices();
    const region = await section();
    await within(region).findByText('Mac mini');
    cloud.onList = () => refusal(502, 'cloud_unavailable', 'AASC Cloud did not answer.');
    fireEvent.click(within(region).getByRole('button', { name: 'Check again' }));
    expect((await within(region).findByRole('alert')).textContent).toContain("Couldn't refresh. Showing the last results.");
    expect(within(region).getByText('Mac mini')).toBeTruthy();
    expect(within(region).queryByText(UNREACHABLE)).toBeNull();
  });

  it('Check again reads the list again and says so while it does; a second press waits for the first', async () => {
    showDevices();
    const region = await section();
    await within(region).findByText('Mac mini');
    let land: (r: Response) => void = () => {};
    cloud.onList = () => new Promise<Response>((r) => { land = r; });
    const check = within(region).getByRole('button', { name: 'Check again' });
    fireEvent.click(check);
    expect(within(region).getByRole('status').textContent).toBe('Checking…');
    fireEvent.click(check);
    expect(cloud.lists()).toHaveLength(2);
    cloud.devices = [here(), mini(), phone(), device({ id: 'dev-new', name: 'New Mac' })];
    await act(async () => land(new Response(JSON.stringify({ success: true, data: { devices: cloud.devices } }), { status: 200 })));
    expect(await within(region).findByText('New Mac')).toBeTruthy();
    expect(within(region).queryByRole('status')).toBeNull();
  });
});
