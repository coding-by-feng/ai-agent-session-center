// CloudPanel.test.tsx — RESOURCES › Projects' frame (Nov 13 2026: Cloud sync was removed and
// Connection became the cloud account dialog, so Projects is all this panel holds). The status bar
// shows only when the connection needs you; a revoked Mac's one Reconnect is the header's account
// button (ResourcesView.test.tsx). Projects' own lists are CloudProjects.test.tsx.
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CloudHarness } from '@/__tests__/cloudHarness';
import { CATALOG } from '@/__tests__/fixtures/resourceCatalog';
import { cloudApi } from '@/lib/cloudApi';
import CloudPanel from './CloudPanel';

const binding = {
  backendOrigin: 'https://fixture.invalid',
  accountId: '00000000-0000-4000-8000-000000000001',
  deviceId: '00000000-0000-4000-8000-000000000002',
  deviceName: 'Fixture',
  generation: 1,
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.spyOn(cloudApi, 'listProjects').mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(() => vi.restoreAllMocks());

function show() {
  render(
    <CloudHarness>
      <CloudPanel catalog={CATALOG} open />
    </CloudHarness>,
  );
}

it('a revoked Mac shows the status bar, without a Reconnect of its own', async () => {
  vi.spyOn(cloudApi, 'status').mockResolvedValue({ connection: binding, state: 'revoked', lastError: 'revoked' });
  show();
  expect(await screen.findByText(/Cloud · revoked/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refresh connection' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
});

it('a working connection keeps the bar out of the way', async () => {
  const status = vi
    .spyOn(cloudApi, 'status')
    .mockResolvedValue({ connection: binding, state: 'connected', lastError: null });
  show();
  await waitFor(() => expect(status).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText(/Cloud · checking connection/)).not.toBeInTheDocument());
  expect(screen.queryByText(/Cloud · connected/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Refresh connection' })).not.toBeInTheDocument();
});

it('an offline Mac shows the bar with Refresh connection, without Reconnect', async () => {
  vi.spyOn(cloudApi, 'status').mockResolvedValue({ connection: binding, state: 'offline', lastError: null });
  show();
  expect(await screen.findByText(/Cloud · offline/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refresh connection' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
});

it('never shows Cloud sync', async () => {
  vi.spyOn(cloudApi, 'status').mockResolvedValue({ connection: binding, state: 'connected', lastError: null });
  const sync = vi.spyOn(cloudApi, 'syncStatus');
  show();
  await waitFor(() => expect(cloudApi.status).toHaveBeenCalled());
  expect(screen.queryByText(/cloud sync/i)).not.toBeInTheDocument();
  expect(sync).not.toHaveBeenCalled();
});
