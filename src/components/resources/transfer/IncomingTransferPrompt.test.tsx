// IncomingTransferPrompt — another computer asks to send a project here (Nov 27 2026): the oldest
// request first, Decline or Allow, waiting for any other dialog to close.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingTransferRequest } from '@/types/projectTransfer';
import { useProjectTransferStore } from '@/stores/projectTransferStore';
import { useUiStore } from '@/stores/uiStore';
import IncomingTransferPrompt from './IncomingTransferPrompt';

const api = vi.hoisted(() => ({ requests: vi.fn(), allow: vi.fn(), decline: vi.fn() }));
vi.mock('@/lib/projectTransferApi', () => ({ projectTransferApi: api }));

const MB = 1024 * 1024;
const req = (
  id: string,
  fields: Partial<IncomingTransferRequest> = {},
): IncomingTransferRequest => ({
  id,
  computerId: 'c1',
  computerLabel: 'laptop',
  projectName: 'app',
  destination: '~/Documents/app',
  files: 1842,
  bytes: 334 * MB,
  requestedAt: 100,
  ...fields,
});

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ activeModal: null });
  const list = [req('r2', { requestedAt: 200, projectName: 'newer' }), req('r1')];
  useProjectTransferStore.getState().setRequests(list);
  api.requests.mockResolvedValue(list);
  api.allow.mockResolvedValue(null);
  api.decline.mockResolvedValue(null);
});

describe('IncomingTransferPrompt', () => {
  it('asks about the oldest request', async () => {
    render(<IncomingTransferPrompt />);
    expect(
      await screen.findByRole('dialog', { name: 'Allow laptop to send a project here?' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'app → ~/Documents/app · 1,842 files · 334 MB. Allowing lets laptop send projects here from now on.',
      ),
    ).toBeTruthy();
    expect(api.requests).toHaveBeenCalledTimes(1);
  });

  it('allows it, then shows the next one', async () => {
    render(<IncomingTransferPrompt />);
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(api.allow).toHaveBeenCalledWith('r1'));
    expect(await screen.findByText(/^newer →/)).toBeTruthy();
  });

  it('declines it', async () => {
    render(<IncomingTransferPrompt />);
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(api.decline).toHaveBeenCalledWith('r1'));
    expect(useProjectTransferStore.getState().requests.map((r) => r.id)).toEqual(['r2']);
  });

  it('shows a refused answer and keeps the request', async () => {
    api.allow.mockRejectedValue(new Error('This computer is busy.'));
    render(<IncomingTransferPrompt />);
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This computer is busy.');
    expect(useProjectTransferStore.getState().requests).toHaveLength(2);
  });

  it('waits for another open dialog to close', async () => {
    useUiStore.setState({ activeModal: 'settings' });
    render(<IncomingTransferPrompt />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => useUiStore.setState({ activeModal: null }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('closes when the server list empties', async () => {
    render(<IncomingTransferPrompt />);
    await screen.findByRole('dialog');
    act(() => useProjectTransferStore.getState().setRequests([]));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useUiStore.getState().activeModal).toBeNull();
  });
});
