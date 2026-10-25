// CloudPanel.test.tsx — the cloud tabs of RESOURCES (Cloud sync · Projects · Connection, one tab row
// since Oct 23 2026; Remote access is part of Connection), composed as ResourcesView composes them
// (src/__tests__/cloudHarness.tsx).
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CloudHarness } from '@/__tests__/cloudHarness';
import { resetSyncStatus } from './syncStatusStore';
import { closeCloudDialog } from './cloudActions';
import { cloudApi } from '@/lib/cloudApi';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import type { RemoteAccessView } from '@/types/remoteAccess';
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
const synced = {
  resourceId: version.manifest.resourceId,
  catalogId: null,
  name: 'Fixture skill',
  agent: 'claude' as const,
  kind: 'skill' as const,
  scope: 'global' as const,
  state: 'synced' as const,
  cloudVersion: 1,
  syncedVersion: 1,
  memory: false,
};
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetSyncStatus();
  closeCloudDialog();
  vi.spyOn(cloudApi, 'status').mockResolvedValue({
    connection: binding,
    state: 'connected',
    lastError: null,
  });
  vi.spyOn(cloudApi, 'syncStatus').mockResolvedValue({ items: [synced], waiting: 0 });
  vi.spyOn(cloudApi, 'listProjects').mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(() => vi.restoreAllMocks());
function show(section: 'sync' | 'projects' | 'connection' = 'sync') {
  return render(<CloudHarness section={section} />);
}
it('download_is_not_install: a ZIP is under Activity and never installs or syncs', async () => {
  const download = vi
    .spyOn(cloudApi, 'download')
    .mockResolvedValue({ id: binding.deviceId, kind: 'download', state: 'complete', steps: [] });
  const sync = vi.spyOn(cloudApi, 'syncNow');
  show();
  await screen.findByText('Fixture skill');
  fireEvent.click(screen.getByRole('button', { name: /Activity/ }));
  fireEvent.change(screen.getByLabelText('Download as ZIP'), {
    target: { value: synced.resourceId },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Download ZIP' }));
  await waitFor(() =>
    expect(download).toHaveBeenCalledWith(
      { resourceId: synced.resourceId, version: 1 },
      expect.anything(),
      expect.any(AbortSignal),
    ),
  );
  expect(sync).not.toHaveBeenCalled();
  expect(await screen.findByRole('button', { name: 'Save ZIP' })).toBeInTheDocument();
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
  show('connection');
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
  show('connection');
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
  show('connection');
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
    show('connection');
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
  show('connection');
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
    show('connection');
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
it('ignores delayed results after account leave and return', async () => {
  let finish!: (v: { items: (typeof synced)[]; waiting: number }) => void;
  vi.mocked(cloudApi.syncStatus)
    .mockResolvedValue({ items: [], waiting: 0 })
    .mockImplementationOnce(() => new Promise((r) => (finish = r)));
  show();
  await waitFor(() => expect(cloudApi.syncStatus).toHaveBeenCalled());
  await act(async () => {
    useSkillNotesStore.setState({
      connection: { ...binding, profileId: 'default', generation: 2 },
    });
    useSkillNotesStore.setState({ connection: { ...binding, profileId: 'default' } });
    finish({ items: [synced], waiting: 0 });
  });
  expect(screen.queryByText('Fixture skill')).not.toBeInTheDocument();
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
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
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

// ---- Remote access (AASC-60) ----
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
it('Connection holds Remote access under the cloud link', async () => {
  const read = vi.spyOn(cloudApi, 'remoteAccess').mockResolvedValue(remoteView());
  show('connection');
  expect(await screen.findByText('Connected · 100.101.102.103')).toBeVisible();
  expect(screen.getByRole('heading', { name: /Phones away from home/ })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Device connection' })).toBeVisible();
  expect(read).toHaveBeenCalledTimes(1);
});
it('reads Remote access only once Connection is opened, and then keeps it mounted (hidden)', async () => {
  const read = vi.spyOn(cloudApi, 'remoteAccess').mockResolvedValue(remoteView());
  show();
  await screen.findByText('Fixture skill');
  expect(read).not.toHaveBeenCalled();
  // Not even mounted yet: its "Checking Tailscale…" placeholder is not in the page.
  expect(screen.queryByText('Checking Tailscale…')).not.toBeInTheDocument();
  expect(screen.queryByText('Tailscale on this Mac')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Connection' }));
  expect(await screen.findByText('Connected · 100.101.102.103')).toBeVisible();
  expect(read).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('tab', { name: 'Cloud sync' }));
  expect(screen.getByText('Connected · 100.101.102.103')).not.toBeVisible();
  expect(read).toHaveBeenCalledTimes(1);
});
it('does not read Remote access while the cloud tabs are not the ones in front', async () => {
  const read = vi.spyOn(cloudApi, 'remoteAccess').mockResolvedValue(remoteView());
  render(<CloudHarness section="connection" open={false} />);
  await waitFor(() => expect(cloudApi.status).toHaveBeenCalled());
  await act(async () => {});
  expect(read).not.toHaveBeenCalled();
});
it('Open Connection in Remote access brings the cloud link above it into view', async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  try {
    vi.spyOn(cloudApi, 'remoteAccess').mockResolvedValue(remoteView('no-cloud'));
    show('connection');
    fireEvent.click(await screen.findByRole('button', { name: 'Open Connection' }));
    const card = screen.getByRole('heading', { name: 'Device connection' });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect((scrollIntoView.mock.contexts.at(-1) as Element).contains(card)).toBe(true);
  } finally {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});
it('Remote access does not wait for a cloud connection', async () => {
  vi.mocked(cloudApi.status).mockResolvedValue({
    connection: null,
    state: 'disconnected',
    lastError: null,
  });
  vi.spyOn(cloudApi, 'remoteAccess').mockResolvedValue(remoteView('no-cloud'));
  show('connection');
  expect(await screen.findByText('Connected · 100.101.102.103')).toBeVisible();
  expect(screen.getByText(/This Mac isn't connected to AASC Cloud/)).toBeVisible();
});
