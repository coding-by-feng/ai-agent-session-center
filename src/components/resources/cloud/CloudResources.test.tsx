// CloudResources.test.tsx — RESOURCES → Cloud sync (AASC-62, regrouped Oct 23 2026): every saved
// resource filed by what it needs (Needs you · Waiting · Synced · Stopped · Removed), states in
// words, Sync now sending exactly the choices and OKs given, and each row's menu (Open in Library,
// Stop syncing, Sync again, Remove from cloud with the name typed first).
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CloudHarness } from '@/__tests__/cloudHarness';
import { cloudApi } from '@/lib/cloudApi';
import type { SyncItem } from '@/types/cloudResources';
import { resetSyncStatus } from './syncStatusStore';
import { closeCloudDialog, useCloudDialog } from './cloudActions';

const binding = {
  backendOrigin: 'https://fixture.invalid',
  accountId: '00000000-0000-4000-8000-000000000001',
  deviceId: '00000000-0000-4000-8000-000000000002',
  deviceName: 'Fixture',
  generation: 1,
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, name: string, fields: Partial<SyncItem>): SyncItem => ({
  resourceId: id(n),
  catalogId: null,
  name,
  agent: 'claude',
  kind: 'skill',
  scope: 'global',
  state: 'synced',
  cloudVersion: 1,
  syncedVersion: 1,
  memory: false,
  ...fields,
});
const ITEMS: SyncItem[] = [
  item(10, 'aligned', { catalogId: 'sk-claude-tdd' }),
  item(11, 'edited-here', { state: 'local-changed' }),
  item(12, 'edited-there', { state: 'cloud-newer', cloudVersion: 3, syncedVersion: 2 }),
  item(13, 'from-other-mac', { state: 'cloud-only', syncedVersion: null }),
  item(14, 'both', { state: 'conflict', cloudVersion: 4, syncedVersion: 3 }),
  item(15, 'notes', { state: 'local-changed', agent: 'codex', kind: 'memory', memory: true }),
  item(16, 'odd', { state: 'blocked', reason: 'Something else is already at this location.' }),
];
beforeEach(() => {
  localStorage.clear();
  resetSyncStatus();
  closeCloudDialog();
  vi.spyOn(cloudApi, 'status').mockResolvedValue({
    connection: binding,
    state: 'connected',
    lastError: null,
  });
  vi.spyOn(cloudApi, 'syncStatus').mockResolvedValue({ items: ITEMS, waiting: 5 });
});
afterEach(() => vi.restoreAllMocks());
function show(onShowResource = vi.fn()) {
  render(<CloudHarness section="sync" onShowResource={onShowResource} />);
  return onShowResource;
}
const row = (name: string) => screen.getByText(name).closest('li')!;
// A folded group's list is hidden, and a hidden element has no accessible name: find the group by
// its section (a named region), then its rows.
const group = (name: string) => screen.getByRole('region', { name });
const namesIn = (name: string) =>
  within(group(name))
    .getAllByRole('listitem', { hidden: true })
    .map((li) => li.querySelector('span')!.textContent);

it('files each resource by what it needs, reads each state in words, and counts only what can move', async () => {
  show();
  await screen.findByText('aligned');
  expect(namesIn('Needs you')).toEqual(['both', 'notes', 'odd']);
  expect(namesIn('Waiting')).toEqual(['edited-here', 'edited-there', 'from-other-mac']);
  expect(namesIn('Synced')).toEqual(['aligned']);
  // What needs you and what is waiting are open; the synced ones are there when you look.
  expect(within(group('Needs you')).getByRole('list')).toBeVisible();
  expect(within(group('Synced')).getByRole('list', { hidden: true })).not.toBeVisible();
  expect(within(row('aligned')).getByText('Synced')).toBeInTheDocument();
  expect(within(row('edited-here')).getByText('Changed on this Mac')).toBeInTheDocument();
  expect(within(row('edited-there')).getByText('Newer in cloud')).toBeInTheDocument();
  expect(within(row('edited-there')).getByText(/v2 here · v3 in cloud/)).toBeInTheDocument();
  expect(within(row('from-other-mac')).getByText('Only in cloud')).toBeInTheDocument();
  expect(within(row('from-other-mac')).getByText(/Sync now installs it here/)).toBeInTheDocument();
  expect(within(row('both')).getByText('Changed in both places')).toBeInTheDocument();
  expect(within(row('odd')).getByText("Can't sync")).toBeInTheDocument();
  expect(within(row('odd')).getByText(/Something else is already/)).toBeInTheDocument();
  expect(within(row('notes')).getByText(/Codex memory/)).toBeInTheDocument();
  // The conflict and the memory file wait: three move now.
  expect(screen.getByRole('button', { name: 'Sync now (3)' })).toBeEnabled();
  expect(
    screen.getByText('3 waiting · 1 needs your choice · 1 memory file needs your OK'),
  ).toBeInTheDocument();
});

it('Sync now sends the chosen copy and the memory OK, then reads the list again when done', async () => {
  const sync = vi.spyOn(cloudApi, 'syncNow').mockResolvedValue({
    jobs: [{ id: id(90), kind: 'publish', state: 'queued', steps: [] }],
    skipped: [{ resourceId: id(16), name: 'odd', reason: 'Something else is already here.' }],
  });
  vi.spyOn(cloudApi, 'job').mockResolvedValue({
    id: id(90),
    kind: 'publish',
    state: 'complete',
    steps: [],
  });
  show();
  await screen.findByText('aligned');
  fireEvent.click(within(row('both')).getByRole('button', { name: 'Keep mine' }));
  expect(within(row('both')).getByRole('button', { name: 'Keep mine' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  fireEvent.click(within(row('notes')).getByLabelText('OK to sync this memory file'));
  fireEvent.click(screen.getByRole('button', { name: 'Sync now (5)' }));
  await waitFor(() =>
    expect(sync).toHaveBeenCalledWith(
      { choices: { [id(14)]: 'mine' }, memory: [id(15)] },
      expect.objectContaining({ accountId: binding.accountId }),
      expect.any(AbortSignal),
    ),
  );
  expect(cloudApi.syncStatus).toHaveBeenCalledTimes(1);
  // The job finishes on its next poll; the list is read again and the left-out item is named.
  await waitFor(() => expect(cloudApi.syncStatus).toHaveBeenCalledTimes(2), { timeout: 3000 });
  expect(await screen.findByText(/Something else is already here/)).toBeInTheDocument();
  // Choices and OKs are for one sync only.
  expect(within(row('notes')).getByLabelText('OK to sync this memory file')).not.toBeChecked();
});

it('names what the last sync left alone once: a row that already says why is not repeated above', async () => {
  vi.spyOn(cloudApi, 'syncNow').mockResolvedValue({
    jobs: [],
    skipped: [
      { resourceId: id(16), name: 'odd', reason: 'Something else is already at this location.' },
      { resourceId: id(11), name: 'edited-here', reason: 'The cloud copy moved on; Check again.' },
    ],
  });
  show();
  await screen.findByText('aligned');
  fireEvent.click(screen.getByRole('button', { name: 'Sync now (3)' }));
  // The list reads the left-out reasons it does not show itself…
  expect(await screen.findByText(/The cloud copy moved on/)).toBeInTheDocument();
  // …and the blocked row's own reason stays the only copy of that one.
  expect(screen.getAllByText(/Something else is already at this location/)).toHaveLength(1);
});

it('with nothing saved, points to Library', async () => {
  vi.mocked(cloudApi.syncStatus).mockResolvedValue({ items: [], waiting: 0 });
  const onLibrary = vi.fn();
  render(<CloudHarness section="sync" onLibrary={onLibrary} />);
  expect(await screen.findByText('Nothing saved to cloud yet.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Open Library' }));
  expect(onLibrary).toHaveBeenCalled();
});

it('Activity is folded away until opened', async () => {
  show();
  await screen.findByText('aligned');
  const toggle = screen.getByRole('button', { name: /Activity/ });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggle);
  expect(screen.getByRole('button', { name: 'Download ZIP' })).toBeDisabled();
  expect(screen.getByText('No past syncs in this browser yet.')).toBeInTheDocument();
});

it("reads the list again when a sync's two jobs finish in the same moment", async () => {
  let release!: () => void;
  const both = new Promise<void>((r) => (release = r));
  vi.spyOn(cloudApi, 'syncNow').mockResolvedValue({
    jobs: [
      { id: id(91), kind: 'publish', state: 'queued', steps: [] },
      { id: id(92), kind: 'install', state: 'queued', steps: [] },
    ],
    skipped: [],
  });
  vi.spyOn(cloudApi, 'job').mockImplementation(async (jobId) => {
    await both;
    return {
      id: jobId,
      kind: jobId === id(91) ? 'publish' : 'install',
      state: 'complete',
      steps: [],
    };
  });
  show();
  await screen.findByText('aligned');
  fireEvent.click(screen.getByRole('button', { name: 'Sync now (3)' }));
  await screen.findByRole('button', { name: 'Syncing…' });
  await waitFor(() => expect(cloudApi.job).toHaveBeenCalledTimes(2), { timeout: 3000 });
  await act(async () => release());
  await waitFor(() => expect(cloudApi.syncStatus).toHaveBeenCalledTimes(2), { timeout: 3000 });
  expect(screen.queryByRole('button', { name: 'Syncing…' })).not.toBeInTheDocument();
});

// ---- Oct 23 2026: each row's menu ----

it('a row on this Mac opens in Library; one only in the cloud has no such item', async () => {
  const onShow = show();
  await screen.findByText('aligned');
  fireEvent.click(screen.getByRole('button', { name: /Synced/ })); // open the group
  fireEvent.click(within(row('aligned')).getByRole('button', { name: 'More actions for aligned' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in Library' }));
  expect(onShow).toHaveBeenCalledWith('sk-claude-tdd');
  fireEvent.click(
    within(row('from-other-mac')).getByRole('button', { name: 'More actions for from-other-mac' }),
  );
  expect(screen.queryByRole('menuitem', { name: 'Open in Library' })).toBeNull();
  expect(screen.getByRole('menuitem', { name: 'Stop syncing on this Mac' })).toBeInTheDocument();
});

it('Stop syncing on this Mac asks the Mac, then reads the list again; a stopped row offers Sync again', async () => {
  const control = vi
    .spyOn(cloudApi, 'syncControl')
    .mockResolvedValue({ resourceId: id(11), action: 'stop' });
  show();
  await screen.findByText('aligned');
  vi.mocked(cloudApi.syncStatus).mockResolvedValue({
    items: ITEMS.map((i) => (i.resourceId === id(11) ? { ...i, state: 'stopped' as const } : i)),
    waiting: 4,
  });
  fireEvent.click(
    within(row('edited-here')).getByRole('button', { name: 'More actions for edited-here' }),
  );
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Stop syncing on this Mac' }));
  await waitFor(() =>
    expect(control).toHaveBeenCalledWith(
      { resourceId: id(11), action: 'stop' },
      expect.anything(),
      expect.any(AbortSignal),
    ),
  );
  await waitFor(() => expect(namesIn('Stopped on this Mac')).toEqual(['edited-here']));
  fireEvent.click(screen.getByRole('button', { name: /Stopped on this Mac/ }));
  fireEvent.click(
    within(row('edited-here')).getByRole('button', { name: 'More actions for edited-here' }),
  );
  expect(await screen.findByRole('menuitem', { name: 'Sync again' })).toBeInTheDocument();
});

it('Remove from cloud asks for the exact name first, then removes every version', async () => {
  const control = vi
    .spyOn(cloudApi, 'syncControl')
    .mockResolvedValue({ resourceId: id(12), action: 'remove', removedVersions: 3 });
  show();
  await screen.findByText('aligned');
  fireEvent.click(
    within(row('edited-there')).getByRole('button', { name: 'More actions for edited-there' }),
  );
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from cloud…' }));
  const dialog = await screen.findByRole('dialog', {
    name: /Remove “edited-there” from the cloud\?/,
  });
  expect(within(dialog).getByText(/Deletes all 3 versions from AASC Cloud/)).toBeInTheDocument();
  const remove = within(dialog).getByRole('button', { name: 'Remove from cloud' });
  expect(remove).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText(/to confirm/), {
    target: { value: 'Edited-there' },
  });
  expect(remove).toBeDisabled(); // the case must match
  fireEvent.change(within(dialog).getByLabelText(/to confirm/), {
    target: { value: 'edited-there' },
  });
  fireEvent.click(remove);
  await waitFor(() =>
    expect(control).toHaveBeenCalledWith(
      { resourceId: id(12), action: 'remove' },
      expect.anything(),
      expect.any(AbortSignal),
    ),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('a removal the cloud refuses keeps the dialog open with the reason', async () => {
  const { CloudApiError } = await import('@/lib/cloudApi');
  vi.spyOn(cloudApi, 'syncControl').mockRejectedValue(
    new CloudApiError(
      'version_in_use',
      'Version 2 is still used by another cloud resource or a project, so it and newer versions stay in the cloud.',
    ),
  );
  show();
  await screen.findByText('aligned');
  fireEvent.click(
    within(row('edited-there')).getByRole('button', { name: 'More actions for edited-there' }),
  );
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from cloud…' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText(/to confirm/), {
    target: { value: 'edited-there' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from cloud' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Version 2 is still used/);
});

it('while it removes, Cancel waits and Escape only hides the dialog: the outcome still lands', async () => {
  // Removing waits whenever the cloud asks it to slow down, and the Mac keeps deleting whatever
  // this window does: closing must not drop the answer, or nothing reads the list again.
  let finish!: (value: { resourceId: string; action: 'remove'; removedVersions: number }) => void;
  vi.spyOn(cloudApi, 'syncControl').mockReturnValue(new Promise((r) => (finish = r)));
  show();
  await screen.findByText('aligned');
  fireEvent.click(
    within(row('edited-there')).getByRole('button', { name: 'More actions for edited-there' }),
  );
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from cloud…' }));
  const dialog = await screen.findByRole('dialog', {
    name: /Remove “edited-there” from the cloud\?/,
  });
  fireEvent.change(within(dialog).getByLabelText(/to confirm/), {
    target: { value: 'edited-there' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from cloud' }));
  expect(await within(dialog).findByRole('button', { name: 'Removing…' })).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  finish({ resourceId: id(12), action: 'remove', removedVersions: 3 });
  await waitFor(() => expect(cloudApi.syncStatus).toHaveBeenCalledTimes(2));
  expect(useCloudDialog.getState().request).toBeNull();
});

it('a removal refused after its dialog was hidden brings the dialog back with the reason', async () => {
  const { CloudApiError } = await import('@/lib/cloudApi');
  let refuse!: (error: unknown) => void;
  vi.spyOn(cloudApi, 'syncControl').mockReturnValue(new Promise((_, reject) => (refuse = reject)));
  show();
  await screen.findByText('aligned');
  fireEvent.click(
    within(row('edited-there')).getByRole('button', { name: 'More actions for edited-there' }),
  );
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from cloud…' }));
  const dialog = await screen.findByRole('dialog', {
    name: /Remove “edited-there” from the cloud\?/,
  });
  fireEvent.change(within(dialog).getByLabelText(/to confirm/), {
    target: { value: 'edited-there' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from cloud' }));
  await within(dialog).findByRole('button', { name: 'Removing…' });
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  refuse(new CloudApiError('version_in_use', 'Version 2 is still used by a project.'));
  const again = await screen.findByRole('dialog', {
    name: /Remove “edited-there” from the cloud\?/,
  });
  expect(within(again).getByRole('alert')).toHaveTextContent(
    'Version 2 is still used by a project.',
  );
});

it('when the browser cannot store jobs, a sync still shows its jobs and reads the list when they end', async () => {
  // Private windows and full storage refuse writes: the running jobs used to come only from the
  // stored history, so none showed, none was polled, and "Syncing…" never cleared.
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError');
  });
  vi.spyOn(cloudApi, 'syncNow').mockResolvedValue({
    jobs: [{ id: id(91), kind: 'publish', state: 'queued', steps: [] }],
    skipped: [],
  });
  vi.spyOn(cloudApi, 'job').mockResolvedValue({
    id: id(91),
    kind: 'publish',
    state: 'complete',
    steps: [],
  });
  show();
  await screen.findByText('aligned');
  const reads = vi.mocked(cloudApi.syncStatus).mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Sync now (3)' }));
  expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeDisabled();
  await waitFor(() => expect(vi.mocked(cloudApi.syncStatus).mock.calls.length).toBe(reads + 1), {
    timeout: 3000,
  });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Syncing…' })).toBeNull());
});
