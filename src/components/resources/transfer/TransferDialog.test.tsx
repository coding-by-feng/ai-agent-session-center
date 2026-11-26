// TransferDialog — Copy / Move a project to a paired computer (Nov 27 2026): pick a computer
// (Tailscale or HTTPS only), measure the folder, send it through Electron main, show progress,
// and offer Resume, Discard or Project Sync when it stops.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteComputer } from '@/types/electron';
import type {
  TransferPlanInfo,
  TransferProgress,
  TransferStartResult,
} from '@/types/projectTransfer';
import { useUiStore } from '@/stores/uiStore';
import TransferDialog from './TransferDialog';

const api = vi.hoisted(() => ({
  plan: vi.fn(),
  discardPlan: vi.fn(),
  requests: vi.fn(),
  allow: vi.fn(),
  decline: vi.fn(),
  moved: vi.fn(),
}));
vi.mock('@/lib/projectTransferApi', () => ({ projectTransferApi: api }));

const MB = 1024 * 1024;
const computer = (fields: Partial<RemoteComputer>): RemoteComputer => ({
  id: 'c1',
  name: 'studio',
  lan: '192.0.2.10',
  tailnet: '100.64.0.2',
  port: 3333,
  status: 'active',
  confirmCode: null,
  addedAt: 1,
  lastSeenAt: null,
  ...fields,
});
const planInfo = (
  planId: string,
  fields: Partial<TransferPlanInfo['summary']> = {},
): TransferPlanInfo => ({
  planId,
  root: '/Users/me/Documents/app',
  name: 'app',
  homeRelative: 'Documents/app',
  summary: {
    files: 1842,
    bytes: 334 * MB,
    byGroup: {
      project: { files: 1800, bytes: 330 * MB },
      claude: { files: 30, bytes: 3 * MB },
      codex: { files: 12, bytes: 1 * MB },
      aasc: { files: 0, bytes: 0 },
    },
    skipped: [],
    skippedCount: 0,
    workingAgents: 0,
    aasc: { sessions: 4, prompts: 20, notes: 1, media: 0, queues: 1 },
    ...fields,
  },
});

let listener: ((p: TransferProgress) => void) | null = null;
let finish: ((r: TransferStartResult) => void) | null = null;
const remotes = {
  list: vi.fn(),
  projectTransferStart: vi.fn(
    () =>
      new Promise<TransferStartResult>((resolve) => {
        finish = resolve;
      }),
  ),
  projectTransferCancel: vi.fn(async () => ({ ok: true as const, data: null })),
  onProjectTransferProgress: vi.fn((l: (p: TransferProgress) => void) => {
    listener = l;
    return () => {
      listener = null;
    };
  }),
};

function progress(fields: Partial<TransferProgress>): TransferProgress {
  return {
    transferId: 't1',
    stage: 'sending',
    sentFiles: 412,
    totalFiles: 1842,
    sentBytes: 120 * MB,
    totalBytes: 334 * MB,
    message: null,
    ...fields,
  };
}

function open(props: Partial<Parameters<typeof TransferDialog>[0]> = {}) {
  const onClose = vi.fn();
  render(
    <TransferDialog root="/Users/me/Documents/app" mode="copy" open onClose={onClose} {...props} />,
  );
  return { onClose };
}

beforeEach(() => {
  listener = null;
  finish = null;
  vi.clearAllMocks();
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('t1' as ReturnType<typeof crypto.randomUUID>);
  useUiStore.setState({ activeModal: null });
  remotes.list.mockResolvedValue([
    computer({}),
    computer({ id: 'c2', name: 'garage', tailnet: null }),
    computer({ id: 'c3', name: 'pending-one', status: 'pending' }),
  ]);
  api.plan.mockResolvedValue(planInfo('p1'));
  api.discardPlan.mockResolvedValue(null);
  (window as unknown as { electronAPI: unknown }).electronAPI = { remotes };
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('TransferDialog', () => {
  it('lists active computers and disables one without Tailscale', async () => {
    open();
    expect(screen.getByRole('dialog', { name: 'Copy app to another computer' })).toBeTruthy();
    const studio = await screen.findByRole('option', { name: 'studio' });
    const garage = screen.getByRole('option', { name: 'garage (needs Tailscale)' });
    expect((studio as HTMLOptionElement).disabled).toBe(false);
    expect((garage as HTMLOptionElement).disabled).toBe(true);
    expect(screen.queryByRole('option', { name: /pending-one/ })).toBeNull();
  });

  it('says there are no paired computers and offers nothing else', async () => {
    remotes.list.mockResolvedValue([]);
    open();
    expect(
      await screen.findByText('No paired computers. Connect one from the devices menu (⇧⌘S).'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Copy/ })).toBeNull();
    expect(api.plan).not.toHaveBeenCalled();
  });

  it('measures, shows one line per group and the folder default', async () => {
    open();
    expect(await screen.findByText('Measuring…')).toBeTruthy();
    expect(await screen.findByText('Project: 1,800 files · 330 MB')).toBeTruthy();
    expect(screen.getByText('Agent memory: 42 files · 4 MB')).toBeTruthy();
    expect(screen.getByText('AASC history: 4 sessions, 20 prompts, 1 note, 1 queue')).toBeTruthy();
    expect((screen.getByLabelText('Folder') as HTMLInputElement).value).toBe('~/Documents/app');
    expect(api.plan).toHaveBeenCalledWith('/Users/me/Documents/app', {
      memory: true,
      aasc: true,
      includeNodeModules: false,
    });
  });

  it('re-plans when an option changes and deletes the old plan', async () => {
    open();
    await screen.findByText('Project: 1,800 files · 330 MB');
    api.plan.mockResolvedValue(planInfo('p2', { bytes: 500 * MB }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Include node_modules/ }));
    await screen.findByRole('button', { name: 'Copy 500 MB' });
    expect(api.plan).toHaveBeenLastCalledWith('/Users/me/Documents/app', {
      memory: true,
      aasc: true,
      includeNodeModules: true,
    });
    expect(api.discardPlan).toHaveBeenCalledWith('p1');
  });

  it('drops a stale plan answer and deletes it', async () => {
    let first: ((p: TransferPlanInfo) => void) | null = null;
    api.plan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve;
        }),
    );
    open();
    await waitFor(() => expect(api.plan).toHaveBeenCalledTimes(1));
    api.plan.mockResolvedValue(planInfo('p2', { bytes: 10 * MB }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Agent memory' }));
    await screen.findByRole('button', { name: 'Copy 10 MB' });
    await act(async () => first?.(planInfo('stale')));
    expect(api.discardPlan).toHaveBeenCalledWith('stale');
    expect(screen.getByRole('button', { name: 'Copy 10 MB' })).toBeTruthy();
  });

  it('starts with the chosen computer, plan, folder and mode, then shows progress', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy 334 MB' }));
    expect(remotes.projectTransferStart).toHaveBeenCalledWith({
      remoteId: 'c1',
      planId: 'p1',
      destination: '~/Documents/app',
      mode: 'copy',
      transferId: 't1',
    });
    // The id is chosen before the call, so Cancel works from the first moment.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(remotes.projectTransferCancel).toHaveBeenCalledWith('t1', false);
    act(() => listener?.(progress({ stage: 'waiting-allow' })));
    expect(screen.getByText('Waiting for Allow on studio…')).toBeTruthy();
    act(() => listener?.(progress({})));
    expect(screen.getByText('Sending 412 of 1,842 files · 120 MB of 334 MB')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveProperty('disabled', true);
  });

  it('ignores progress of a transfer it does not follow', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy 334 MB' }));
    act(() => listener?.(progress({ transferId: 'other', stage: 'moving' })));
    act(() => listener?.(progress({ transferId: 't1', stage: 'committing' })));
    expect(screen.getByText('Putting it in place…')).toBeTruthy();
    expect(screen.queryByText('Moving this folder to the Trash…')).toBeNull();
    await act(async () =>
      finish?.({
        ok: false,
        error: 'stopped',
        failure: { transferId: 't1', error: 'Stopped.', resumable: false },
      }),
    );
  });

  it('offers Resume with the same transfer id, and Discard', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy 334 MB' }));
    await act(async () =>
      finish?.({
        ok: false,
        error: 'x',
        failure: { transferId: 't9', error: 'studio stopped answering.', resumable: true },
      }),
    );
    expect(screen.getByRole('alert').textContent).toBe('studio stopped answering.');
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(remotes.projectTransferStart).toHaveBeenLastCalledWith({
      remoteId: 'c1',
      planId: 'p1',
      destination: '~/Documents/app',
      mode: 'copy',
      transferId: 't9',
    });
    await act(async () =>
      finish?.({
        ok: false,
        error: 'x',
        failure: { transferId: 't9', error: 'Again.', resumable: true },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(remotes.projectTransferCancel).toHaveBeenCalledWith('t9', true));
    expect(await screen.findByRole('button', { name: 'Copy 334 MB' })).toBeTruthy();
  });

  it('sends a folder that exists there to Project Sync', async () => {
    const onOpenProjectSync = vi.fn();
    const { onClose } = open({ onOpenProjectSync });
    fireEvent.click(await screen.findByRole('button', { name: 'Copy 334 MB' }));
    await act(async () =>
      finish?.({
        ok: false,
        error: 'x',
        failure: {
          transferId: 't2',
          error: '~/Documents/app already exists on studio.',
          code: 'destination_exists',
          resumable: false,
        },
      }),
    );
    expect(screen.getByText('~/Documents/app already exists on studio.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use Project Sync' }));
    expect(onOpenProjectSync).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('hides Use Project Sync when the row cannot open it', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy 334 MB' }));
    await act(async () =>
      finish?.({
        ok: false,
        error: 'x',
        failure: {
          transferId: 't2',
          error: 'Exists.',
          code: 'destination_exists',
          resumable: false,
        },
      }),
    );
    expect(screen.queryByRole('button', { name: 'Use Project Sync' })).toBeNull();
  });

  it('warns a Copy about working agents', async () => {
    api.plan.mockResolvedValue(planInfo('p1', { workingAgents: 2 }));
    open();
    expect(
      await screen.findByText(
        '2 agents are working in this folder. Their latest changes may not be included.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy 334 MB' })).toHaveProperty('disabled', false);
  });

  it('refuses a Move while agents work in the folder', async () => {
    api.plan.mockResolvedValue(planInfo('p1', { workingAgents: 1 }));
    open({ mode: 'move' });
    expect(
      await screen.findByText('An agent is working in this folder. Move it once it finishes.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move 334 MB' })).toHaveProperty('disabled', true);
  });

  it('refuses a folder outside home', async () => {
    open();
    await screen.findByRole('button', { name: 'Copy 334 MB' });
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/tmp/app' } });
    expect(screen.getByText('Start the folder with ~/')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy 334 MB' })).toHaveProperty('disabled', true);
  });

  it('reports a finished Move', async () => {
    const onDone = vi.fn();
    open({ mode: 'move', onDone });
    fireEvent.click(await screen.findByRole('button', { name: 'Move 334 MB' }));
    await act(async () =>
      finish?.({
        ok: true,
        data: {
          transferId: 't1',
          moved: true,
          moveMessage: null,
          commit: {
            destination: '~/Documents/app',
            files: 1842,
            bytes: 334 * MB,
            claudeFiles: 30,
            codexFiles: 12,
            skippedExisting: 0,
            aasc: null,
            warnings: ['The AASC history did not come across.'],
          },
        },
      }),
    );
    expect(
      screen.getByText(
        'Moved to studio at ~/Documents/app · 1,842 files · memory and history. This folder is in the Trash.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('The AASC history did not come across.')).toBeTruthy();
    expect(onDone).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });
});
