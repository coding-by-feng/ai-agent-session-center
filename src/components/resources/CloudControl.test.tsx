// CloudControl.test.tsx — a Library resource's cloud state and next step in the detail title row
// (Oct 23 2026): Save to cloud in place, one-resource sync, memory asking for its OK, a conflict
// resolved by choosing a copy, stop / Sync again, and nothing for what the cloud cannot carry.
import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryCloudHarness } from '@/__tests__/cloudHarness';
import { CATALOG } from '@/__tests__/fixtures/resourceCatalog';
import { cloudApi } from '@/lib/cloudApi';
import type { PublicationPlan, SyncItem, SyncStatus } from '@/types/cloudResources';
import type { ResourceSummary } from '@/types/resources';
import CloudControl from './CloudControl';
import { resetSyncStatus } from './cloud/syncStatusStore';
import { closeCloudDialog } from './cloud/cloudActions';

const binding = {
  backendOrigin: 'https://fixture.invalid',
  accountId: '00000000-0000-4000-8000-000000000001',
  deviceId: '00000000-0000-4000-8000-000000000002',
  deviceName: 'Fixture',
  generation: 1,
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const byId = (catalogId: string) => CATALOG.resources.find((r) => r.id === catalogId)!;
const TDD = byId('sk-claude-tdd');
const MEMORY = byId('mem-codex');
const PLUGIN = byId('sk-github');
const synced = (fields: Partial<SyncItem>, n = 10): SyncItem => ({
  resourceId: id(n),
  catalogId: TDD.id,
  name: TDD.name,
  agent: 'claude',
  kind: 'skill',
  scope: 'global',
  state: 'synced',
  cloudVersion: 3,
  syncedVersion: 3,
  memory: false,
  ...fields,
});
const job = { id: id(90), kind: 'publish' as const, state: 'queued' as const, steps: [] };
const PLAN: PublicationPlan = {
  id: id(70),
  items: [
    {
      catalogId: TDD.id,
      manifest: {
        resourceId: id(10),
        agent: 'claude',
        kind: 'skill',
        name: 'tdd',
        scope: 'global',
        projectId: null,
        files: [{ path: 'tdd/SKILL.md', sha256: 'a'.repeat(64), bytes: 10, mode: 420 }],
        dependencies: [],
      },
      sourceDigest: 'b'.repeat(64),
      baseVersion: null,
    },
  ],
  blocked: [],
};

function connected(items: SyncItem[] = []) {
  vi.spyOn(cloudApi, 'status').mockResolvedValue({
    connection: binding,
    state: 'connected',
    lastError: null,
  });
  vi.spyOn(cloudApi, 'syncStatus').mockResolvedValue({ items, waiting: 0 } satisfies SyncStatus);
  vi.spyOn(cloudApi, 'job').mockResolvedValue({ ...job, state: 'complete' });
}
function show(summary: ResourceSummary, onConnect = vi.fn()) {
  render(
    <LibraryCloudHarness>
      <CloudControl summary={summary} onConnect={onConnect} />
    </LibraryCloudHarness>,
  );
  return onConnect;
}

beforeEach(() => {
  localStorage.clear();
  resetSyncStatus();
  closeCloudDialog();
});
afterEach(() => vi.restoreAllMocks());

describe('before the cloud', () => {
  it('without a connection offers Connect to sync', async () => {
    vi.spyOn(cloudApi, 'status').mockResolvedValue({
      connection: null,
      state: 'disconnected',
      lastError: null,
    });
    const onConnect = show(TDD);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect to sync' }));
    expect(onConnect).toHaveBeenCalled();
  });

  it('shows nothing for what the cloud cannot carry (a plugin skill)', async () => {
    connected();
    show(PLUGIN);
    await waitFor(() => expect(cloudApi.syncStatus).toHaveBeenCalled());
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Save to cloud, in place', () => {
  it('reviews what will be saved, saves it, and follows the job', async () => {
    connected();
    const plan = vi.spyOn(cloudApi, 'buildPublicationPlan').mockResolvedValue(PLAN);
    const publish = vi.spyOn(cloudApi, 'publishPlan').mockResolvedValue(job);
    show(TDD);
    fireEvent.click(await screen.findByRole('button', { name: 'Save to cloud' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save to cloud' });
    expect(plan).toHaveBeenCalledWith(
      [{ resourceId: TDD.id, include: true }],
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(await within(dialog).findByText(/1 resource ready to save/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save 1 resource to cloud' }));
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith(id(70), expect.anything(), expect.any(AbortSignal), {
        skipBlocked: false,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // While the job runs the control says so; when it ends the list is read again.
    expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeDisabled();
    await waitFor(() => expect(cloudApi.syncStatus).toHaveBeenCalledTimes(2), { timeout: 3000 });
  });

  it('under StrictMode (npm run dev) the review still arrives', async () => {
    // StrictMode mounts, unmounts and mounts again: the first plan request is aborted with the
    // first mount, so the dialog must ask again rather than wait for it forever.
    connected();
    vi.spyOn(cloudApi, 'buildPublicationPlan').mockResolvedValue(PLAN);
    render(
      <StrictMode>
        <LibraryCloudHarness>
          <CloudControl summary={TDD} onConnect={vi.fn()} />
        </LibraryCloudHarness>
      </StrictMode>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Save to cloud' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save to cloud' });
    expect(await within(dialog).findByText(/1 resource ready to save/)).toBeInTheDocument();
  });
});

describe('a resource that syncs', () => {
  it('synced: says so with the version, and the menu stops it here', async () => {
    connected([synced({})]);
    const control = vi
      .spyOn(cloudApi, 'syncControl')
      .mockResolvedValue({ resourceId: id(10), action: 'stop' });
    show(TDD);
    expect(await screen.findByText(/Synced · v3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More cloud actions for tdd' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Stop syncing on this Mac' }));
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith(
        { resourceId: id(10), action: 'stop' },
        expect.anything(),
        expect.any(AbortSignal),
      ),
    );
  });

  it('changed here: Upload changes syncs this one resource only', async () => {
    connected([synced({ state: 'local-changed' })]);
    const sync = vi.spyOn(cloudApi, 'syncNow').mockResolvedValue({ jobs: [job], skipped: [] });
    show(TDD);
    fireEvent.click(await screen.findByRole('button', { name: /Upload changes/ }));
    await waitFor(() =>
      expect(sync).toHaveBeenCalledWith(
        { only: [id(10)] },
        expect.anything(),
        expect.any(AbortSignal),
      ),
    );
  });

  it('newer in cloud: names the version it gets', async () => {
    connected([synced({ state: 'cloud-newer', cloudVersion: 4 })]);
    show(TDD);
    expect(await screen.findByRole('button', { name: /Get v4 from cloud/ })).toBeEnabled();
  });

  it('memory: asks for the OK before anything moves', async () => {
    connected([
      synced(
        {
          catalogId: MEMORY.id,
          name: 'notes.md',
          agent: 'codex',
          kind: 'memory',
          memory: true,
          state: 'local-changed',
        },
        11,
      ),
    ]);
    const sync = vi.spyOn(cloudApi, 'syncNow').mockResolvedValue({ jobs: [], skipped: [] });
    show(MEMORY);
    fireEvent.click(await screen.findByRole('button', { name: /Upload changes/ }));
    const dialog = await screen.findByRole('dialog', { name: /Sync “notes.md”\?/ });
    const go = within(dialog).getByRole('button', { name: 'Sync now' });
    expect(go).toBeDisabled();
    expect(sync).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByLabelText('OK to sync this memory file'));
    fireEvent.click(go);
    await waitFor(() =>
      expect(sync).toHaveBeenCalledWith(
        { only: [id(11)], memory: [id(11)] },
        expect.anything(),
        expect.any(AbortSignal),
      ),
    );
  });

  it('changed in both places: Resolve asks which copy, then syncs with that choice', async () => {
    connected([synced({ state: 'conflict', cloudVersion: 4 })]);
    const sync = vi.spyOn(cloudApi, 'syncNow').mockResolvedValue({ jobs: [], skipped: [] });
    show(TDD);
    fireEvent.click(await screen.findByRole('button', { name: /Resolve…/ }));
    const dialog = await screen.findByRole('dialog', { name: /changed in both places/ });
    expect(within(dialog).getByRole('button', { name: 'Sync now' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use cloud’s' }));
    expect(within(dialog).getByText(/keeps a backup you can restore/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync now' }));
    await waitFor(() =>
      expect(sync).toHaveBeenCalledWith(
        { only: [id(10)], choices: { [id(10)]: 'cloud' } },
        expect.anything(),
        expect.any(AbortSignal),
      ),
    );
  });

  it('stopped: Sync again resumes it', async () => {
    connected([synced({ state: 'stopped' })]);
    const control = vi
      .spyOn(cloudApi, 'syncControl')
      .mockResolvedValue({ resourceId: id(10), action: 'resume' });
    show(TDD);
    fireEvent.click(await screen.findByRole('button', { name: /Sync again/ }));
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith(
        { resourceId: id(10), action: 'resume' },
        expect.anything(),
        expect.any(AbortSignal),
      ),
    );
  });

  it("can't sync: gives the reason instead of a button", async () => {
    connected([synced({ state: 'blocked', reason: 'Possible secret detected in SKILL.md.' })]);
    show(TDD);
    expect(await screen.findByText(/Can't sync: Possible secret detected/)).toBeInTheDocument();
  });
});
