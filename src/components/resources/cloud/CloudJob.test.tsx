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
it('a failed job poll exposes a local status refresh instead of silently staying current', async () => {
  const id = '00000000-0000-4000-8000-000000000004';
  const job = { id, kind: 'install' as const, state: 'running' as const, steps: [] };
  const poll = vi.spyOn(cloudApi, 'job').mockRejectedValue(new Error('Local server unavailable'));
  render(
    <CloudContext.Provider
      value={{
        status: { connection: null, state: 'disconnected', lastError: null },
        epoch: 1,
        current: () => 1,
        changed: false,
        refresh: vi.fn(),
      }}
    >
      <CloudJob job={job} onChange={vi.fn()} />
    </CloudContext.Provider>,
  );
  expect(
    await screen.findByRole('button', { name: 'Refresh job status' }, { timeout: 2500 }),
  ).toBeInTheDocument();
  poll.mockRestore();
});
