// CloudAccountActions.test.tsx — "Your account" in the cloud account dialog (plan 18): export what
// AASC Cloud holds to a file on this computer, and delete the account through the browser.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudHarness } from '@/__tests__/cloudHarness';
import { cloudApi } from '@/lib/cloudApi';
import CloudAccountPanel from './CloudAccountPanel';

const binding = {
  backendOrigin: 'https://fixture.invalid',
  accountId: '00000000-0000-4000-8000-000000000001',
  deviceId: '00000000-0000-4000-8000-000000000002',
  deviceName: 'Fixture',
  generation: 1,
};
const signedIn = { ...binding, accountEmail: 'owner@example.com' };
const connected = (connection: typeof binding | typeof signedIn) =>
  ({ connection, state: 'connected', lastError: null }) as const;
const signedOut = { connection: null, state: 'disconnected', lastError: null } as const;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.spyOn(cloudApi, 'status').mockResolvedValue(connected(signedIn));
  vi.spyOn(cloudApi, 'defaults').mockResolvedValue({ backendUrl: 'https://api.aasc.work', deviceName: 'kason-mac' });
});
afterEach(() => vi.restoreAllMocks());
const show = () =>
  render(
    <CloudHarness>
      <CloudAccountPanel />
    </CloudHarness>,
  );
const account = async () => within(await screen.findByRole('group', { name: 'Your account' }));

it('a Mac paired by code has no account actions: they are for an account signed in with Google', async () => {
  vi.mocked(cloudApi.status).mockResolvedValue(connected(binding));
  show();
  await screen.findByRole('button', { name: 'Disconnect' });
  expect(screen.queryByRole('group', { name: 'Your account' })).not.toBeInTheDocument();
});

it('offers Export and Delete, with Delete set apart, and no confirm text until it is asked for', async () => {
  show();
  const block = await account();
  expect(block.getByRole('button', { name: 'Export my data' })).toBeEnabled();
  expect(block.getByRole('button', { name: 'Delete account…' })).toBeEnabled();
  expect(block.queryByText(/Delete your AASC Cloud account\?/)).not.toBeInTheDocument();
});

it('export saves on this computer and says where, with the size', async () => {
  const save = vi
    .spyOn(cloudApi, 'accountExport')
    .mockResolvedValue({ path: '/Users/me/Downloads/aasc-cloud-export-20261120-010203.json', bytes: 12_800 });
  show();
  const block = await account();
  fireEvent.click(block.getByRole('button', { name: 'Export my data' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ ...signedIn }, expect.any(AbortSignal)));
  const done = await block.findByRole('status');
  expect(done).toHaveTextContent('Saved to /Users/me/Downloads/aasc-cloud-export-20261120-010203.json (13 KB)');
});

it('a failed export says why and saves nothing', async () => {
  vi.spyOn(cloudApi, 'accountExport').mockRejectedValue(
    new Error('This computer signed in before exports were allowed. Sign out, sign in again, then export.'),
  );
  show();
  const block = await account();
  fireEvent.click(block.getByRole('button', { name: 'Export my data' }));
  expect(await block.findByRole('alert')).toHaveTextContent('Sign out, sign in again, then export.');
  expect(block.queryByText(/Saved to/)).not.toBeInTheDocument();
});

it('Delete asks first, says what goes, and Cancel changes nothing', async () => {
  const start = vi.spyOn(cloudApi, 'googleStart');
  show();
  const block = await account();
  fireEvent.click(block.getByRole('button', { name: 'Delete account…' }));
  expect(block.getByText('Delete your AASC Cloud account?')).toBeInTheDocument();
  expect(block.getByText(/Sessions and files on your computers are not touched/)).toBeInTheDocument();
  expect(block.getByText(/You confirm in your browser/)).toBeInTheDocument();
  fireEvent.click(block.getByRole('button', { name: 'Cancel' }));
  expect(block.queryByText('Delete your AASC Cloud account?')).not.toBeInTheDocument();
  expect(start).not.toHaveBeenCalled();
});

it('Continue opens the browser step for this account, waits, and signs this Mac out when the account is gone', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const start = vi
      .spyOn(cloudApi, 'googleStart')
      .mockResolvedValue({ url: 'https://fixture.invalid/v1/auth/google/start?intent=delete' });
    const state = vi.spyOn(cloudApi, 'googleState').mockResolvedValue({ pending: true, last: null });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    show();
    const block = await account();
    fireEvent.click(block.getByRole('button', { name: 'Delete account…' }));
    fireEvent.click(block.getByRole('button', { name: 'Continue in browser…' }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({ intent: 'delete' }, expect.any(AbortSignal), { ...signedIn }),
    );
    expect(open).toHaveBeenCalledWith(
      'https://fixture.invalid/v1/auth/google/start?intent=delete',
      '_blank',
      'noopener',
    );
    expect(await block.findByText(/Finish deleting in your browser/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(block.getByText(/Finish deleting in your browser/)).toBeInTheDocument();
    state.mockResolvedValue({ pending: false, last: { intent: 'delete', result: 'deleted' } });
    // Like the real fetch: a status read whose signal was aborted fails instead of answering.
    // Like the real fetch, the status read answers a moment later, after React has re-rendered
    // (and run the wait's cleanup), and fails instead of answering when its signal was aborted.
    let thrownAway = 0;
    const answers: (() => void)[] = [];
    vi.mocked(cloudApi.status).mockImplementation(
      (signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          answers.push(() => {
            if (!signal?.aborted) return resolve(signedOut);
            thrownAway++;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await act(async () => {
      for (const answer of answers.splice(0)) answer();
    });
    expect(await screen.findByText('Your AASC Cloud account was deleted.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Your account' })).not.toBeInTheDocument();
    // The card's own read of the new status must not be cut off by the wait ending.
    expect(thrownAway).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ['deleted-other', 'A different Google account was deleted. This computer is still signed in as owner@example.com.'],
  ['deleted-unchecked', 'The account you chose was deleted. This computer could not check its own connection: refresh the connection.'],
  ['failed', 'This computer did not see the delete finish. If you pressed Delete in the browser, the account is gone: refresh the connection to check.'],
  ['expired', 'This computer did not see the delete finish. If you pressed Delete in the browser, the account is gone: refresh the connection to check.'],
] as const)('a browser step that ends as %s says so and keeps this Mac signed in', async (result, text) => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.spyOn(cloudApi, 'googleStart').mockResolvedValue({ url: 'https://fixture.invalid/v1/auth/google/start' });
    vi.spyOn(cloudApi, 'googleState').mockResolvedValue({ pending: false, last: { intent: 'delete', result } });
    vi.spyOn(window, 'open').mockReturnValue(null);
    show();
    const block = await account();
    fireEvent.click(block.getByRole('button', { name: 'Delete account…' }));
    fireEvent.click(block.getByRole('button', { name: 'Continue in browser…' }));
    await block.findByText(/Finish deleting in your browser/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(await block.findByText(text)).toBeInTheDocument();
    expect(block.queryByText(/Finish deleting in your browser/)).not.toBeInTheDocument();
    expect(block.getByRole('button', { name: 'Delete account…' })).toBeEnabled();
  } finally {
    vi.useRealTimers();
  }
});

it('Cancel while waiting tells the Mac to drop the browser step', async () => {
  vi.spyOn(cloudApi, 'googleStart').mockResolvedValue({ url: 'https://fixture.invalid/v1/auth/google/start' });
  vi.spyOn(cloudApi, 'googleState').mockResolvedValue({ pending: true, last: null });
  const cancel = vi.spyOn(cloudApi, 'googleCancel').mockResolvedValue(undefined);
  vi.spyOn(window, 'open').mockReturnValue(null);
  show();
  const block = await account();
  fireEvent.click(block.getByRole('button', { name: 'Delete account…' }));
  fireEvent.click(block.getByRole('button', { name: 'Continue in browser…' }));
  await block.findByText(/Finish deleting in your browser/);
  fireEvent.click(block.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(cancel).toHaveBeenCalled());
  expect(block.queryByText(/Finish deleting in your browser/)).not.toBeInTheDocument();
  expect(block.getByRole('button', { name: 'Delete account…' })).toBeEnabled();
  // The browser tab may still be open, and its button would still delete.
  expect(block.getByText('Stopped waiting. Close the browser tab too: its Delete button still works.')).toBeInTheDocument();
});

it('a browser step that could not start says why', async () => {
  vi.spyOn(cloudApi, 'googleStart').mockRejectedValue(new Error('The cloud connection changed. Refresh and review this action again.'));
  show();
  const block = await account();
  fireEvent.click(block.getByRole('button', { name: 'Delete account…' }));
  fireEvent.click(block.getByRole('button', { name: 'Continue in browser…' }));
  expect(await block.findByRole('alert')).toHaveTextContent('The cloud connection changed.');
});

it('asks the Mac again only after the last answer came back, however slow it is', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.spyOn(cloudApi, 'googleStart').mockResolvedValue({ url: 'https://fixture.invalid/v1/auth/google/start' });
    let open = 0;
    let most = 0;
    vi.spyOn(cloudApi, 'googleState').mockImplementation(async () => {
      most = Math.max(most, ++open);
      await new Promise((r) => setTimeout(r, 5_000));
      open--;
      return { pending: true, last: null };
    });
    vi.spyOn(window, 'open').mockReturnValue(null);
    show();
    const block = await account();
    fireEvent.click(block.getByRole('button', { name: 'Delete account…' }));
    fireEvent.click(block.getByRole('button', { name: 'Continue in browser…' }));
    await block.findByText(/Finish deleting in your browser/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(13_000);
    });
    expect(most).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
