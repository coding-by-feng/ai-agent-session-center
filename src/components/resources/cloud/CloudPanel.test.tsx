import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import CloudPanel from './CloudPanel';
import { CATALOG } from '@/__tests__/fixtures/resourceCatalog';
import { cloudApi } from '@/lib/cloudApi';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
const binding = {
  backendOrigin: 'https://fixture.invalid',
  accountId: '00000000-0000-4000-8000-000000000001',
  deviceId: '00000000-0000-4000-8000-000000000002',
  deviceName: 'Fixture',
  generation: 1,
};
const version = {
  manifest: {
    resourceId: binding.deviceId,
    agent: 'claude' as const,
    kind: 'skill' as const,
    name: 'Fixture skill',
    scope: 'global' as const,
    projectId: null,
    files: [{ path: 'fixture/SKILL.md', sha256: 'a'.repeat(64), bytes: 10, mode: 420 as const }],
    dependencies: [],
  },
  version: 1,
  digest: 'a'.repeat(64),
  createdAt: '2026-10-10T00:00:00.000Z',
};
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.spyOn(cloudApi, 'status').mockResolvedValue({
    connection: binding,
    state: 'connected',
    lastError: null,
  });
  vi.spyOn(cloudApi, 'listResources').mockResolvedValue({ items: [version], nextCursor: null });
  vi.spyOn(cloudApi, 'listProjects').mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(() => vi.restoreAllMocks());
function show(tab = 'resources') {
  return render(
    <MemoryRouter initialEntries={['/resources?section=cloud&cloudTab=' + tab]}>
      <CloudPanel catalog={CATALOG} selection={[]} onSelection={vi.fn()} />
    </MemoryRouter>,
  );
}
it('download_is_not_install', async () => {
  const download = vi
    .spyOn(cloudApi, 'download')
    .mockResolvedValue({ id: binding.deviceId, kind: 'download', state: 'complete', steps: [] });
  const install = vi.spyOn(cloudApi, 'planInstall');
  show();
  await screen.findByText('Fixture skill');
  fireEvent.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(download).toHaveBeenCalled());
  expect(install).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Save ZIP' })).toBeInTheDocument();
});
it('revoked_token_is_shown_and_the_pairing_form_stays_available', async () => {
  vi.mocked(cloudApi.status).mockResolvedValue({
    connection: binding,
    state: 'revoked',
    lastError: 'revoked',
  });
  show('connection');
  expect(await screen.findByText(/Cloud · revoked/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Connect device' })).toBeDisabled();
  expect(screen.getByLabelText('One-use pairing code')).toBeInTheDocument();
});
it('revoked_token_has_reconnect', async () => {
  vi.mocked(cloudApi.status).mockResolvedValue({
    connection: binding,
    state: 'revoked',
    lastError: 'revoked',
  });
  show();
  expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
});
it('disconnect_keeps_local_library and does not activate notes', async () => {
  const activate = vi.spyOn(useSkillNotesStore.getState(), 'useCloudNotes');
  const disconnect = vi.spyOn(cloudApi, 'disconnect').mockResolvedValue({
    connection: null,
    state: 'disconnected',
    lastError: null,
  });
  show('connection');
  await screen.findByRole('button', { name: 'Disconnect' });
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  await waitFor(() =>
    expect(disconnect).toHaveBeenCalledWith({ ...binding }, expect.any(AbortSignal)),
  );
  expect(await screen.findByText(/Cloud · disconnected/)).toBeInTheDocument();
  expect(screen.getByText(/Local resources and saved notes remain/)).toBeInTheDocument();
  expect(activate).not.toHaveBeenCalled();
});
it('connect sends only the typed pairing input and clears the one-use code', async () => {
  vi.mocked(cloudApi.status).mockResolvedValue({
    connection: null,
    state: 'disconnected',
    lastError: null,
  });
  const connect = vi.spyOn(cloudApi, 'connect').mockResolvedValue(binding);
  show('connection');
  await screen.findByRole('button', { name: 'Connect device' });
  fireEvent.change(screen.getByLabelText('Backend URL'), {
    target: { value: binding.backendOrigin },
  });
  fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'Fixture' } });
  fireEvent.change(screen.getByLabelText('One-use pairing code'), {
    target: { value: 'c'.repeat(22) },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect device' }));
  await waitFor(() =>
    expect(connect).toHaveBeenCalledWith(
      { backendUrl: binding.backendOrigin, pairingCode: 'c'.repeat(22), deviceName: 'Fixture' },
      expect.any(AbortSignal),
    ),
  );
  expect(await screen.findByText(/Cloud · connected/)).toBeInTheDocument();
  expect(screen.getByLabelText('One-use pairing code')).toHaveValue('');
});
it('ignores delayed results after account leave and return', async () => {
  let finish!: (v: { items: (typeof version)[]; nextCursor: null }) => void;
  vi.mocked(cloudApi.listResources)
    .mockResolvedValue({ items: [], nextCursor: null })
    .mockImplementationOnce(() => new Promise((r) => (finish = r)));
  show();
  await waitFor(() => expect(cloudApi.listResources).toHaveBeenCalled());
  await act(async () => {
    useSkillNotesStore.setState({
      connection: { ...binding, profileId: 'default', generation: 2 },
    });
    useSkillNotesStore.setState({ connection: { ...binding, profileId: 'default' } });
    finish({ items: [version], nextCursor: null });
  });
  expect(screen.queryByText('Fixture skill')).not.toBeInTheDocument();
});
it('a delayed plan cannot open a hidden tab dialog or strand its focus trap', async () => {
  let finish!: (p: Awaited<ReturnType<typeof cloudApi.planInstall>>) => void;
  vi.spyOn(cloudApi, 'planInstall').mockImplementation(() => new Promise((r) => (finish = r)));
  show();
  await screen.findByText('Fixture skill');
  fireEvent.click(screen.getByRole('button', { name: 'Install on this device' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Projects' }));
  await act(async () => {
    finish({ id: binding.deviceId, items: [] });
  });
  expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Resources' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('offline paired restart with local notes exposes identity-bound health refresh', async () => {
  vi.mocked(cloudApi.status).mockResolvedValue({
    connection: binding,
    state: 'offline',
    lastError: null,
  });
  const recheck = vi
    .spyOn(cloudApi, 'recheck')
    .mockResolvedValue({ connection: binding, state: 'connected', lastError: null });
  const activate = vi.spyOn(useSkillNotesStore.getState(), 'useCloudNotes');
  show();
  await screen.findByText(/Cloud · offline/);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh connection' }));
  await screen.findByText(/Cloud · connected/);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Refresh resources' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh resources' }));
  await screen.findByText('Fixture skill');
  expect(recheck).toHaveBeenCalledWith(binding, expect.any(AbortSignal));
  expect(activate).not.toHaveBeenCalled();
});
it('a status failure is reported without inventing a connection', async () => {
  vi.mocked(cloudApi.status).mockRejectedValue(new Error('Cloud is unreachable'));
  show();
  expect(
    (await screen.findByText('Cloud is unreachable')).closest('[role="alert"]'),
  ).not.toBeNull();
  expect(screen.getByText(/Cloud · disconnected/)).toBeInTheDocument();
});
