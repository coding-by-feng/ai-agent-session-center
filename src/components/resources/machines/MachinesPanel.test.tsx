// MachinesPanel.test.tsx — RESOURCES › Machines (Nov 13 2026) starts with This Mac: its Tailscale
// address and how paired phones reach it away from home (the old Connection › Remote access). It
// reads Tailscale only while the tab is in front, needs no cloud connection, and its "Open cloud
// account" opens the account dialog. The card's own states are CloudRemoteAccess.test.tsx.
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CloudHarness } from '@/__tests__/cloudHarness';
import { cloudApi } from '@/lib/cloudApi';
import type { RemoteAccessView } from '@/types/remoteAccess';
import MachinesPanel from './MachinesPanel';

const remoteView = (state: 'no-cloud' | 'published' = 'published'): RemoteAccessView => ({
  tailscale: {
    state: 'connected',
    address: '100.101.102.103',
    account: null,
    tailnet: null,
    dnsName: null,
    canOpenApp: true,
  },
  publish: {
    state,
    tailnet: state === 'published' ? '100.101.102.103' : null,
    port: 3334,
    at: state === 'published' ? Date.now() : null,
  },
  phones: [],
  port: 3334,
});

beforeEach(() => {
  vi.spyOn(cloudApi, 'status').mockResolvedValue({ connection: null, state: 'disconnected', lastError: null });
});
afterEach(() => vi.restoreAllMocks());

function show({ open = true, onAccount = vi.fn() } = {}) {
  const view = render(
    <CloudHarness>
      <MachinesPanel open={open} onAccount={onAccount} />
    </CloudHarness>,
  );
  return { ...view, onAccount };
}

it('This Mac holds Remote access, and it does not wait for a cloud connection', async () => {
  const read = vi.spyOn(cloudApi, 'remoteAccess').mockResolvedValue(remoteView('no-cloud'));
  show();
  const thisMac = screen.getByRole('region', { name: 'This Mac' });
  expect(within(thisMac).getByRole('heading', { name: /This Mac/ })).toBeInTheDocument();
  expect(await within(thisMac).findByText('Connected · 100.101.102.103')).toBeVisible();
  expect(screen.getByText(/This Mac isn't connected to AASC Cloud/)).toBeVisible();
  expect(read).toHaveBeenCalledTimes(1);
});

it('does not read Tailscale while Machines is not the tab in front', async () => {
  const read = vi.spyOn(cloudApi, 'remoteAccess').mockResolvedValue(remoteView());
  show({ open: false });
  await waitFor(() => expect(cloudApi.status).toHaveBeenCalled());
  await act(async () => {});
  expect(read).not.toHaveBeenCalled();
});

it('Open cloud account in Remote access opens the account dialog', async () => {
  vi.spyOn(cloudApi, 'remoteAccess').mockResolvedValue(remoteView('no-cloud'));
  const { onAccount } = show();
  fireEvent.click(await screen.findByRole('button', { name: 'Open cloud account' }));
  expect(onAccount).toHaveBeenCalledTimes(1);
});
