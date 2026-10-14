import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import CloudPanel from './CloudPanel';
import { cloudApi } from '@/lib/cloudApi';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
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
  vi.spyOn(cloudApi, 'status').mockResolvedValue({
    connection: binding,
    state: 'connected',
    lastError: null,
  });
});
afterEach(() => vi.restoreAllMocks());
function show() {
  return render(
    <MemoryRouter initialEntries={['/resources?section=cloud']}>
      <CloudPanel />
    </MemoryRouter>,
  );
}
it('revoked_token_is_shown_and_the_pairing_form_stays_available', async () => {
  vi.mocked(cloudApi.status).mockResolvedValue({
    connection: binding,
    state: 'revoked',
    lastError: 'revoked',
  });
  show();
  expect(await screen.findByText(/Cloud · revoked/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Connect device' })).toBeDisabled();
  expect(screen.getByLabelText('One-use pairing code')).toBeInTheDocument();
});
it('disconnect_keeps_local_library and does not activate notes', async () => {
  const activate = vi.spyOn(useSkillNotesStore.getState(), 'useCloudNotes');
  const disconnect = vi.spyOn(cloudApi, 'disconnect').mockResolvedValue({
    connection: null,
    state: 'disconnected',
    lastError: null,
  });
  show();
  await screen.findByRole('button', { name: 'Disconnect' });
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  await waitFor(() => expect(disconnect).toHaveBeenCalledWith(
    { ...binding },
    expect.any(AbortSignal),
  ));
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
  show();
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
  expect(recheck).toHaveBeenCalledWith(binding, expect.any(AbortSignal));
  expect(activate).not.toHaveBeenCalled();
});
it('a status failure is reported without inventing a connection', async () => {
  vi.mocked(cloudApi.status).mockRejectedValue(new Error('Cloud is unreachable'));
  show();
  expect((await screen.findByText('Cloud is unreachable')).closest('[role="alert"]')).not.toBeNull();
  expect(screen.getByText(/Cloud · disconnected/)).toBeInTheDocument();
});
