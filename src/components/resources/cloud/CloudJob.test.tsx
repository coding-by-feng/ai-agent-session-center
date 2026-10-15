import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import CloudJob from './CloudJob';
import ResourceSelection from '../ResourceSelection';
import { CloudContext } from './cloudSession';
import { cloudApi } from '@/lib/cloudApi';
import { res } from '@/__tests__/fixtures/resourceCatalog';
import { cloudPublicationBlocker } from '@/types/resourceSelection';
it('selected_global_with_one_exclusion keeps ordered leaf exception', () => {
  const change = vi.fn();
  render(
    <ResourceSelection
      resources={[res({ id: 'a', name: 'Alpha' }), res({ id: 'b', name: 'Bravo' })]}
      projects={[]}
      selection={[
        { scope: 'global', include: true },
        { resourceId: 'b', include: false },
      ]}
      onChange={change}
      blocker={cloudPublicationBlocker}
    />,
  );
  expect(screen.getByRole('checkbox', { name: 'Alpha · Claude' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Bravo · Claude' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Select global resources/ })).toHaveAttribute(
    'aria-checked',
    'mixed',
  );
});
it('complete install with alias attention remains retryable', async () => {
  const id = '00000000-0000-4000-8000-000000000001',
    job = {
      id,
      kind: 'install' as const,
      state: 'complete' as const,
      steps: [
        {
          id: 'step',
          label: 'Example',
          state: 'complete' as const,
          attention: 'Alias needs retry',
        },
      ],
    };
  const retry = vi.spyOn(cloudApi, 'retry').mockResolvedValue({ ...job, steps: [] });
  render(
    <CloudContext.Provider
      value={{
        status: {
          connection: {
            backendOrigin: 'https://fixture.invalid',
            accountId: id,
            deviceId: id,
            deviceName: 'fixture',
            generation: 1,
          },
          state: 'connected',
          lastError: null,
        },
        epoch: 1,
        current: () => 1,
        changed: false,
        refresh: vi.fn(),
      }}
    >
      <CloudJob job={job} onChange={vi.fn()} />
    </CloudContext.Provider>,
  );
  expect(screen.getByText(/Package completed; follow-up needs attention/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry job' }));
  await waitFor(() => expect(retry).toHaveBeenCalled());
  retry.mockRestore();
});
const connection = {
  backendOrigin: 'https://fixture.invalid',
  accountId: '00000000-0000-4000-8000-000000000001',
  deviceId: '00000000-0000-4000-8000-000000000002',
  deviceName: 'fixture',
  generation: 3,
};
const reviewed = {
  backendOrigin: connection.backendOrigin,
  accountId: connection.accountId,
  generation: connection.generation,
};
function showRunning(
  status: { connection: typeof connection | null; state: 'connected' | 'offline' | 'disconnected' },
  changed = false,
) {
  const id = '00000000-0000-4000-8000-000000000004';
  const job = { id, kind: 'install' as const, state: 'running' as const, steps: [] };
  const onChange = vi.fn();
  render(
    <CloudContext.Provider
      value={{
        status: { ...status, lastError: null },
        epoch: 1,
        current: () => 1,
        changed,
        refresh: vi.fn(),
      }}
    >
      <CloudJob job={job} onChange={onChange} />
    </CloudContext.Provider>,
  );
  return { id, job, onChange };
}
it('a failed job poll exposes a local status refresh instead of silently staying current', async () => {
  const poll = vi.spyOn(cloudApi, 'job').mockRejectedValue(new Error('Local server unavailable'));
  showRunning({ connection, state: 'connected' });
  expect(
    await screen.findByText(/status may be out of date/, {}, { timeout: 2500 }),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  poll.mockRestore();
});
it('polls a job with the reviewed binding, also while offline', async () => {
  const poll = vi.spyOn(cloudApi, 'job').mockImplementation(async (jobId) => ({
    id: jobId,
    kind: 'install',
    state: 'complete',
    steps: [],
  }));
  const { id, onChange } = showRunning({ connection, state: 'offline' });
  await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2500 });
  expect(poll).toHaveBeenCalledWith(id, reviewed, expect.any(AbortSignal));
  poll.mockRestore();
});
it('never polls or cancels a job without a binding', async () => {
  const poll = vi.spyOn(cloudApi, 'job');
  const cancel = vi.spyOn(cloudApi, 'cancel');
  showRunning({ connection: null, state: 'disconnected' });
  expect(
    await screen.findByText(/status may be out of date/, {}, { timeout: 2500 }),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancel job' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(
    await screen.findByText(/Refresh the connection before checking or cancelling/),
  ).toBeInTheDocument();
  expect(poll).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  poll.mockRestore();
  cancel.mockRestore();
});
it('cancel carries the reviewed binding', async () => {
  const poll = vi.spyOn(cloudApi, 'job').mockReturnValue(new Promise(() => {}));
  const cancel = vi.spyOn(cloudApi, 'cancel').mockImplementation(async (jobId) => ({
    id: jobId,
    kind: 'install',
    state: 'cancelled',
    steps: [],
  }));
  const { id, onChange } = showRunning({ connection, state: 'connected' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel job' }));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ state: 'cancelled' })),
  );
  expect(cancel).toHaveBeenCalledWith(id, expect.objectContaining(reviewed), expect.anything());
  poll.mockRestore();
  cancel.mockRestore();
});
it('a prepared ZIP is saved once: the button goes and the hint says to start a new download', async () => {
  const id = '00000000-0000-4000-8000-000000000005';
  const file = vi.spyOn(cloudApi, 'downloadFile').mockResolvedValue(new Blob(['zip']));
  // jsdom has no object URLs; give the test its own and put the originals back afterwards.
  const objectUrls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = vi.fn(() => 'blob:fixture');
  URL.revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(
    <CloudContext.Provider
      value={{
        status: { connection, state: 'connected', lastError: null },
        epoch: 1,
        current: () => 1,
        changed: false,
        refresh: vi.fn(),
      }}
    >
      <CloudJob job={{ id, kind: 'download', state: 'complete', steps: [] }} onChange={vi.fn()} />
    </CloudContext.Provider>,
  );
  expect(screen.getByText(/can be saved once, within an hour/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save ZIP' }));
  await screen.findByText(/start a new download to save it again/);
  expect(screen.queryByRole('button', { name: 'Save ZIP' })).not.toBeInTheDocument();
  expect(file).toHaveBeenCalledTimes(1);
  expect(click).toHaveBeenCalledTimes(1);
  click.mockRestore();
  file.mockRestore();
  URL.createObjectURL = objectUrls.create;
  URL.revokeObjectURL = objectUrls.revoke;
});
