// CloudAccountPanel.test.tsx — the cloud account dialog's contents (the Connection tab until Nov 13
// 2026): the status line, then the device connection card — sign in with Google or pair, defaults,
// disconnect. Rendered inside the cloud session as ResourcesView provides it (cloudHarness).
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CloudHarness } from '@/__tests__/cloudHarness';
import { cloudApi } from '@/lib/cloudApi';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import CloudAccountPanel from './CloudAccountPanel';
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
    <CloudHarness>
      <CloudAccountPanel />
    </CloudHarness>,
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
  show();
  await screen.findByRole('button', { name: 'Connect device' });
  fireEvent.change(screen.getByLabelText('Backend URL'), {
    target: { value: binding.backendOrigin },
  });
  fireEvent.change(screen.getByLabelText("This Mac's name"), { target: { value: 'Fixture' } });
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
  // Connected: the sign-in and pairing form goes away, one-use code with it.
  expect(screen.queryByLabelText('One-use pairing code')).toBeNull();
});

it('a disconnected Mac starts with the AASC backend and its own name filled in', async () => {
  vi.mocked(cloudApi.status).mockResolvedValue({
    connection: null,
    state: 'disconnected',
    lastError: null,
  });
  vi.spyOn(cloudApi, 'defaults').mockResolvedValue({
    backendUrl: 'https://api.aasc.work',
    deviceName: 'kason-mac',
  });
  show();
  await waitFor(() =>
    expect(screen.getByLabelText('Backend URL')).toHaveValue('https://api.aasc.work'),
  );
  expect(screen.getByLabelText("This Mac's name")).toHaveValue('kason-mac');
  expect(screen.getByLabelText('One-use pairing code')).toHaveValue('');
});

it('defaults never overwrite what was typed first', async () => {
  vi.mocked(cloudApi.status).mockResolvedValue({
    connection: null,
    state: 'disconnected',
    lastError: null,
  });
  let answer!: (v: { backendUrl: string; deviceName: string }) => void;
  vi.spyOn(cloudApi, 'defaults').mockImplementation(() => new Promise((r) => (answer = r)));
  show();
  await screen.findByRole('button', { name: 'Connect device' });
  fireEvent.change(screen.getByLabelText("This Mac's name"), { target: { value: 'Studio' } });
  await act(async () => answer({ backendUrl: 'https://api.aasc.work', deviceName: 'kason-mac' }));
  expect(screen.getByLabelText("This Mac's name")).toHaveValue('Studio');
  expect(screen.getByLabelText('Backend URL')).toHaveValue('https://api.aasc.work');
});

const disconnected = { connection: null, state: 'disconnected' as const, lastError: null };
function signInDefaults() {
  vi.mocked(cloudApi.status).mockResolvedValue(disconnected);
  vi.spyOn(cloudApi, 'defaults').mockResolvedValue({
    backendUrl: 'https://api.aasc.work',
    deviceName: 'kason-mac',
  });
}
it('a disconnected Mac offers Sign in with Google with its own name, and keeps the typed form under Advanced', async () => {
  signInDefaults();
  show();
  // The button renders disabled until the defaults (the Mac's name) arrive: wait for it, with
  // room for a full-suite load.
  const signIn = await screen.findByRole(
    'button',
    { name: 'Sign in with Google' },
    { timeout: 5000 },
  );
  await waitFor(() => expect(signIn).toBeEnabled(), { timeout: 5000 });
  await waitFor(() => expect(screen.getByLabelText("This Mac's name")).toHaveValue('kason-mac'), {
    timeout: 5000,
  });
  const advanced = screen
    .getByText('Advanced: another backend or a pairing code')
    .closest('details')!;
  expect(advanced).not.toHaveAttribute('open');
  expect(within(advanced).getByLabelText('One-use pairing code')).toBeInTheDocument();
});

it('sign-in opens the backend in the browser, waits, and turns connected when status does', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    signInDefaults();
    const start = vi
      .spyOn(cloudApi, 'googleStart')
      .mockResolvedValue({ url: 'https://api.aasc.work/v1/auth/google/start?c=x' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    show();
    await waitFor(() => expect(screen.getByLabelText("This Mac's name")).toHaveValue('kason-mac'));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({ deviceName: 'kason-mac' }, expect.any(AbortSignal)),
    );
    expect(open).toHaveBeenCalledWith(
      'https://api.aasc.work/v1/auth/google/start?c=x',
      '_blank',
      'noopener',
    );
    expect(await screen.findByText(/Finish signing in in your browser/)).toBeInTheDocument();
    vi.mocked(cloudApi.status).mockResolvedValue({
      connection: { ...binding, accountEmail: 'owner@example.com' },
      state: 'connected',
      lastError: null,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(await screen.findByText('Signed in as owner@example.com · Fixture')).toBeInTheDocument();
    expect(screen.queryByText(/Finish signing in in your browser/)).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it('cancel stops waiting and tells the Mac to drop the sign-in', async () => {
  signInDefaults();
  vi.spyOn(cloudApi, 'googleStart').mockResolvedValue({
    url: 'https://api.aasc.work/v1/auth/google/start',
  });
  const cancel = vi.spyOn(cloudApi, 'googleCancel').mockResolvedValue(undefined);
  vi.spyOn(window, 'open').mockReturnValue(null);
  show();
  await waitFor(() => expect(screen.getByLabelText("This Mac's name")).toHaveValue('kason-mac'));
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(cancel).toHaveBeenCalled());
  expect(screen.queryByText(/Finish signing in in your browser/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeEnabled();
});

it('a failed sign-in shows the reason from the connection status', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    signInDefaults();
    vi.spyOn(cloudApi, 'googleStart').mockResolvedValue({
      url: 'https://api.aasc.work/v1/auth/google/start',
    });
    vi.spyOn(window, 'open').mockReturnValue(null);
    show();
    await waitFor(() => expect(screen.getByLabelText("This Mac's name")).toHaveValue('kason-mac'));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    await screen.findByText(/Finish signing in in your browser/);
    vi.mocked(cloudApi.status).mockResolvedValue({
      ...disconnected,
      lastError: 'Invalid pairing code',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    const card = screen.getByRole('heading', { name: 'Device connection' }).closest('section')!;
    expect(await within(card).findByRole('alert')).toHaveTextContent('Invalid pairing code');
    expect(within(card).getByRole('button', { name: 'Sign in with Google' })).toBeEnabled();
  } finally {
    vi.useRealTimers();
  }
});
it('offline paired restart: Refresh connection rechecks with this Mac\'s identity and never activates notes', async () => {
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
  expect(
    (await screen.findByText('Cloud is unreachable')).closest('[role="alert"]'),
  ).not.toBeNull();
  expect(screen.getByText(/Cloud · disconnected/)).toBeInTheDocument();
});
it('has no Reconnect of its own: the pairing form is right below the status line', async () => {
  vi.mocked(cloudApi.status).mockResolvedValue({ connection: binding, state: 'revoked', lastError: 'revoked' });
  show();
  await screen.findByText(/Cloud · revoked/);
  expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
});
