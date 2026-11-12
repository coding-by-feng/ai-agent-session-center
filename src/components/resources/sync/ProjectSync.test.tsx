import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CATALOG } from '@/__tests__/fixtures/resourceCatalog';
import {
  DEFAULT_SYNC_EXCLUDES,
  type SyncEntry,
  type SyncLink,
  type SyncOverview,
  type SyncRun,
} from '@/types/projectSync';
import { useSyncCards } from './useSyncCards';

const DEVICE = {
  id: '99999999-9999-4999-8999-999999999999',
  name: 'mini',
  host: 'mini.local',
  username: 'me',
  port: 22,
  fingerprint: 'SHA256:x',
  home: '/home/me',
  platform: 'linux',
  checkedAt: 0,
};
const LINK: SyncLink = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'app ⇄ mini',
  projectId: 'p-app',
  localPath: '~/code/app',
  deviceId: DEVICE.id,
  remoteRoot: '/home/me/code/app',
  direction: 'two-way',
  excludes: ['node_modules/'],
  hasBase: true,
  lastRunId: '22222222-2222-4222-8222-222222222222',
  state: 'pending',
  createdAt: 1,
  updatedAt: 1,
};
const RUN: SyncRun = {
  id: LINK.lastRunId!,
  linkId: LINK.id,
  createdAt: 1,
  updatedAt: 1,
  state: 'review',
  planned: true,
  counts: { add: 1, conflict: 1, different: 1, same: 3 },
  done: 0,
  failed: 0,
  total: 1,
  bytes: { toSend: 2048, sent: 0, toGet: 1024, got: 0 },
  groups: [
    {
      id: '.git',
      isRepo: true,
      counts: { change: 2 },
      bytes: 10,
      decision: 'review',
      state: 'both-changed',
      local: { head: 'main', commit: 'abcdef1234567' },
      device: { head: 'main', commit: '0123456789ab' },
    },
  ],
  warnings: [],
  pendingDecisions: 3,
};
const file = (size: number) => ({ kind: 'file' as const, size, mtimeMs: 1, mode: 420 });
const entry = (o: Partial<SyncEntry>): SyncEntry => ({
  id: '33333333-3333-4333-8333-333333333333',
  path: 'a.txt',
  groupId: '',
  change: 'add',
  action: 'push',
  flags: [],
  state: 'pending',
  local: file(2),
  ...o,
});
const ENTRIES = [
  entry({}),
  entry({
    id: '44444444-4444-4444-8444-444444444444',
    path: 'notes.md',
    change: 'conflict',
    action: 'review',
    device: file(3),
    base: file(1),
  }),
];
const overviewOf = (o: Partial<SyncOverview> = {}): SyncOverview => ({
  links: [],
  runs: [],
  devices: [DEVICE],
  supported: true,
  ...o,
});

type Handler = (body: unknown) => { status?: number; json: unknown };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Answers the sync API from `overview`; `routes` (regex → reply) win, in order. */
function stub(
  overview: SyncOverview,
  routes: [RegExp, Handler][] = [],
  entries: SyncEntry[] = ENTRIES,
) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      for (const [re, fn] of routes)
        if (re.test(url)) {
          const out = fn(body);
          return new Response(JSON.stringify(out.json), { status: out.status ?? 200 });
        }
      const data = url.endsWith('/api/resources/sync')
        ? overview
        : url.includes('/entries?')
          ? { entries, total: entries.length, offset: 0 }
          : (overview.runs[0] ?? null);
      return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    }),
  );
  return calls;
}
const ok = (data: unknown) => ({ json: { success: true, data } });

/** A Projects list with only what Project Sync adds to each card. */
function Cards({ paths }: { paths: string[] }) {
  const { cardFor, dialog } = useSyncCards({ catalog: CATALOG, home: '/Users/me', visible: true });
  return (
    <>
      <ul>
        {paths.map((p) => {
          const card = cardFor(p, p.split('/').pop() ?? p);
          return (
            <li key={p} data-testid={p}>
              {card ? (
                <>
                  {card.line ? <span>{card.line}</span> : null}
                  {card.button}
                  {card.menuItems.map((m) => (
                    <button key={m.id} type="button" onClick={m.onSelect}>
                      {m.label}
                    </button>
                  ))}
                </>
              ) : (
                'no sync'
              )}
            </li>
          );
        })}
      </ul>
      {dialog}
    </>
  );
}
const APP = '/Users/me/code/app';

describe('Project Sync on the Projects cards', () => {
  it('offers sync only on a project Sources knows: never home, a worktree or an unknown folder', async () => {
    stub(overviewOf());
    render(
      <Cards
        paths={[APP, `${APP}/.claude/worktrees/feature-x`, '/Users/me', '/Users/me/elsewhere']}
      />,
    );
    const app = await screen.findByTestId(APP);
    await waitFor(() =>
      expect(within(app).getByRole('button', { name: 'Sync with a server…' })).toBeTruthy(),
    );
    expect(within(app).queryByRole('button', { name: /^Sync/ })?.textContent).toBe(
      'Sync with a server…',
    );
    for (const other of [`${APP}/.claude/worktrees/feature-x`, '/Users/me', '/Users/me/elsewhere'])
      expect(screen.getByTestId(other).textContent).toBe('no sync');
  });

  it('shows nothing where sync is unsupported (Windows)', async () => {
    const calls = stub(overviewOf({ supported: false }));
    render(<Cards paths={[APP]} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.getByTestId(APP).textContent).toBe('no sync');
  });

  it('gives a linked project a Sync button and a line saying where and how it stands', async () => {
    stub(
      overviewOf({ links: [{ ...LINK, state: 'in-sync' }], runs: [{ ...RUN, state: 'complete' }] }),
    );
    render(<Cards paths={[APP]} />);
    expect(await screen.findByText('Syncs with mini · In sync')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync app' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sync with a server…' })).toBeNull();
  });

  it('links with the suggested server folder, both ways by default, then compares', async () => {
    const calls = stub(overviewOf(), [
      [/\/links$/, () => ok({ ...LINK, lastRunId: undefined, state: 'never' })],
      [/\/compare$/, () => ok({ ...RUN, state: 'comparing' })],
    ]);
    render(<Cards paths={[APP]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sync with a server…' }));
    const dialog = await screen.findByRole('dialog');
    const folder = within(dialog).getByLabelText('Folder on the server') as HTMLInputElement;
    expect(folder.value).toBe('/home/me/code/app');
    const leaveOut = within(dialog).getByLabelText(/Leave out/) as HTMLTextAreaElement;
    expect(leaveOut.value).toBe(DEFAULT_SYNC_EXCLUDES.join('\n'));
    const link = within(dialog).getByRole('button', {
      name: 'Link and compare',
    }) as HTMLButtonElement;
    expect(link.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(link);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/compare'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/links'))?.body).toEqual({
      name: 'app ⇄ mini',
      projectId: 'p-app',
      deviceId: DEVICE.id,
      remoteRoot: '/home/me/code/app',
      excludes: [...DEFAULT_SYNC_EXCLUDES],
      credentialsAck: true,
      direction: 'two-way',
    });
  });

  it('adds a server when none is saved, and says why one is refused', async () => {
    const calls = stub(overviewOf({ devices: [] }), [
      [
        /\/devices$/,
        () => ({
          status: 409,
          json: { success: false, error: 'Could not reach the server: Host key not trusted.' },
        }),
      ],
    ]);
    render(<Cards paths={[APP]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sync with a server…' }));
    const form = await screen.findByRole('group', { name: 'Add a server' });
    const add = within(form).getByRole('button', { name: 'Add server' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'mini' } });
    fireEvent.change(within(form).getByLabelText('Host'), { target: { value: 'mini.local' } });
    fireEvent.change(within(form).getByLabelText('User'), { target: { value: 'me' } });
    fireEvent.click(add);
    expect(await within(form).findByRole('alert')).toBeTruthy();
    expect(within(form).getByRole('alert').textContent).toMatch(/Host key not trusted/);
    expect(calls.find((c) => c.url.endsWith('/devices'))?.body).toEqual({
      name: 'mini',
      host: 'mini.local',
      username: 'me',
      port: 22,
    });
  });
});

describe('a two-way review', () => {
  const openReview = async (overview: SyncOverview, routes: [RegExp, Handler][] = []) => {
    const calls = stub(overview, routes);
    render(<Cards paths={[APP]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sync app' }));
    return { calls, dialog: await screen.findByRole('dialog') };
  };

  it('offers each side’s version, keep both and skip; Sync waits for every decision', async () => {
    const { dialog } = await openReview(overviewOf({ links: [LINK], runs: [RUN] }));
    const list = await within(dialog).findByRole('list', { name: 'Planned changes' });
    const select = within(list).getByRole('combobox', {
      name: 'Action for notes.md',
    }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual([
      'Choose…',
      'Keep this computer’s',
      'Keep the server’s',
      'Keep both',
      'Skip',
    ]);
    expect(within(list).getByText('changed on both')).toBeTruthy();
    // Both repositories moved: "Sync changes" is not a choice, but each side's repository is.
    const repo = within(dialog).getByRole('combobox', { name: /Repository/ }) as HTMLSelectElement;
    expect([...repo.options].find((o) => o.value === 'sync')?.disabled).toBe(true);
    expect([...repo.options].map((o) => o.text)).toContain(
      'Use the server’s repository (backups kept)',
    );
    const sync = within(dialog).getByRole('button', { name: 'Sync 1 change' }) as HTMLButtonElement;
    expect(sync.disabled).toBe(true);
    expect(within(dialog).getByText('3 decisions left')).toBeTruthy();
    expect(within(dialog).getByText(/2\.0 KB to send · 1\.0 KB to get/)).toBeTruthy();
  });

  it('decides every conflict at once, for both kinds of conflict', async () => {
    const { calls, dialog } = await openReview(overviewOf({ links: [LINK], runs: [RUN] }));
    const bulk = (await within(dialog).findByRole('combobox', {
      name: 'Every conflict',
    })) as HTMLSelectElement;
    // Worded as each row's select words it.
    expect([...bulk.options].map((o) => o.text)).toEqual([
      'Choose…',
      'Keep both',
      'Keep this computer’s',
      'Keep the server’s',
    ]);
    fireEvent.change(bulk, { target: { value: 'keep-both' } });
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith('/decisions')).map((c) => c.body)).toEqual([
        { bulk: { change: 'conflict', action: 'keep-both' } },
        { bulk: { change: 'different', action: 'keep-both' } },
      ]),
    );
  });

  it('says where keep both puts the server’s version', async () => {
    stub(
      overviewOf({ links: [LINK], runs: [RUN] }),
      [],
      [
        entry({
          path: 'notes.md',
          change: 'conflict',
          action: 'keep-both',
          device: file(3),
          copyPath: 'notes.server-20261031.md',
          copyId: '55555555-5555-4555-8555-555555555555',
        }),
      ],
    );
    render(<Cards paths={[APP]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sync app' }));
    expect(await screen.findByText('notes.server-20261031.md')).toBeTruthy();
  });

  it('records matching sides as in sync when nothing needs copying', async () => {
    const same: SyncRun = {
      ...RUN,
      counts: { same: 4 },
      total: 0,
      pendingDecisions: 0,
      groups: [],
    };
    const { calls, dialog } = await openReview(overviewOf({ links: [LINK], runs: [same] }), [
      [/\/run$/, () => ok({ ...same, state: 'running' })],
    ]);
    expect(within(dialog).getByText('Nothing to copy: both sides match.')).toBeTruthy();
    const mark = within(dialog).getByRole('button', {
      name: 'Mark as in sync',
    }) as HTMLButtonElement;
    expect(mark.disabled).toBe(false);
    fireEvent.click(mark);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/run'))).toBe(true));
  });

  it('asks before a run that deletes most of what was synced, then sends both answers', async () => {
    const ready: SyncRun = { ...RUN, pendingDecisions: 0, groups: [] };
    let asked = 0;
    const { calls, dialog } = await openReview(overviewOf({ links: [LINK], runs: [ready] }), [
      [
        /\/run$/,
        (body) => {
          const b = body as { confirmLiveSessions: boolean; confirmDeletes: boolean };
          asked++;
          if (!b.confirmLiveSessions)
            return {
              status: 409,
              json: { success: false, error: '1 AASC session is working.', code: 'live-sessions' },
            };
          if (!b.confirmDeletes)
            return {
              status: 409,
              json: {
                success: false,
                error: 'This run deletes 6 of 8 synced files on this computer (undo keeps them).',
                code: 'mass-delete',
              },
            };
          return ok({ ...ready, state: 'running' });
        },
      ],
    ]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync 1 change' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Sync anyway' }));
    expect(await within(dialog).findByText(/deletes 6 of 8 synced files/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete them' }));
    await waitFor(() => expect(asked).toBe(3));
    expect(calls.filter((c) => c.url.endsWith('/run')).map((c) => c.body)).toEqual([
      { confirmLiveSessions: false, confirmDeletes: false },
      { confirmLiveSessions: true, confirmDeletes: false },
      { confirmLiveSessions: true, confirmDeletes: true },
    ]);
  });

  it('undoes a finished run on both sides after asking once', async () => {
    const done: SyncRun = {
      ...RUN,
      state: 'complete',
      startedAt: 1,
      done: 2,
      total: 2,
      pendingDecisions: 0,
      groups: [],
    };
    const { calls, dialog } = await openReview(
      overviewOf({ links: [{ ...LINK, state: 'in-sync' }], runs: [done] }),
      [[/\/undo$/, () => ok({ run: { ...done, state: 'undone' }, restored: 2, skipped: 0 })]],
    );
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Undo this run' }));
    expect(within(dialog).getByText(/on this computer and on the server/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo run' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/undo'))).toBe(true));
  });

  it('a compare that failed offers neither Retry nor Undo; a run that stopped partway offers both', async () => {
    const failedCompare: SyncRun = {
      ...RUN,
      planned: undefined,
      state: 'failed',
      error: 'Could not reach the server.',
      counts: {},
      total: 0,
      pendingDecisions: 0,
      groups: [],
    };
    const { dialog } = await openReview(
      overviewOf({ links: [{ ...LINK, state: 'attention' }], runs: [failedCompare] }),
    );
    expect(await within(dialog).findByText('Could not reach the server.')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Retry|^Sync \d/ })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Undo this run' })).toBeNull();
  });

  it('a run that failed before finishing a file can still be undone, and retried', async () => {
    // It started, so it can have written part of an entry: the server would accept the undo.
    const stopped: SyncRun = {
      ...RUN,
      state: 'failed',
      startedAt: 1,
      done: 0,
      total: 2,
      error: 'The sync stopped responding. Try again.',
      pendingDecisions: 0,
      groups: [],
    };
    const { dialog } = await openReview(
      overviewOf({ links: [{ ...LINK, state: 'attention' }], runs: [stopped] }),
    );
    expect(await within(dialog).findByRole('button', { name: 'Undo this run' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Retry 2 remaining' })).toBeTruthy();
  });

  it('a yes covers one press of Sync: after a plain failure the next press asks again', async () => {
    const ready: SyncRun = { ...RUN, pendingDecisions: 0, groups: [] };
    const { calls, dialog } = await openReview(overviewOf({ links: [LINK], runs: [ready] }), [
      [
        /\/run$/,
        (body) =>
          (body as { confirmLiveSessions: boolean }).confirmLiveSessions
            ? {
                status: 409,
                json: { success: false, error: 'Another compare or sync is running.' },
              }
            : {
                status: 409,
                json: {
                  success: false,
                  error: '1 AASC session is working.',
                  code: 'live-sessions',
                },
              },
      ],
    ]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync 1 change' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Sync anyway' }));
    expect(await within(dialog).findByText('Another compare or sync is running.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync 1 change' }));
    // Asked again, and this answer goes with this press.
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Sync anyway' }));
    await within(dialog).findByText('Another compare or sync is running.');
    expect(calls.filter((c) => c.url.endsWith('/run')).map((c) => c.body)).toEqual([
      { confirmLiveSessions: false, confirmDeletes: false },
      { confirmLiveSessions: true, confirmDeletes: false },
      { confirmLiveSessions: false, confirmDeletes: false },
      { confirmLiveSessions: true, confirmDeletes: false },
    ]);
  });

  it('after Undo the card reads the link again, and unsaved settings survive it', async () => {
    const done: SyncRun = {
      ...RUN,
      state: 'complete',
      startedAt: 1,
      done: 2,
      total: 2,
      pendingDecisions: 0,
      groups: [],
    };
    let overview = overviewOf({ links: [{ ...LINK, state: 'in-sync' }], runs: [done] });
    const { dialog } = await openReview(overview, [
      [/\/api\/resources\/sync$/, () => ok(overview)],
      [
        /\/undo$/,
        () => {
          // The run's end touches the link (state, updatedAt) but not its settings.
          overview = overviewOf({
            links: [{ ...LINK, state: 'never', hasBase: false, updatedAt: 2 }],
            runs: [{ ...done, state: 'undone' }],
          });
          return ok({ run: { ...done, state: 'undone' }, restored: 2, skipped: 0 });
        },
      ],
    ]);
    expect(screen.getByText('Syncs with mini · In sync')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Settings' }));
    const direction = () =>
      within(within(dialog).getByRole('group', { name: 'Sync settings' })).getByRole('combobox', {
        name: 'Direction',
      }) as HTMLSelectElement;
    fireEvent.change(direction(), { target: { value: 'push' } });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Undo this run' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo run' }));
    expect(await screen.findByText('Syncs with mini · Not compared yet')).toBeTruthy();
    expect(direction().value).toBe('push');
  });

  it('a push link can decide every file the server changed at once', async () => {
    const push: SyncRun = {
      ...RUN,
      counts: { drift: 2, same: 3 },
      total: 2,
      pendingDecisions: 2,
      groups: [],
    };
    const { calls, dialog } = await openReview(
      overviewOf({ links: [{ ...LINK, direction: 'push' }], runs: [push] }),
    );
    const bulk = (await within(dialog).findByRole('combobox', {
      name: 'Every file changed on the server',
    })) as HTMLSelectElement;
    expect([...bulk.options].map((o) => o.text)).toEqual([
      'Choose…',
      'Copy to the server (backups kept)',
      'Keep the server’s',
    ]);
    fireEvent.change(bulk, { target: { value: 'push' } });
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/decisions'))?.body).toEqual({
        bulk: { change: 'drift', action: 'push' },
      }),
    );
  });

  it('changes the direction in Settings, and removes the link after asking', async () => {
    const { calls, dialog } = await openReview(overviewOf({ links: [LINK], runs: [RUN] }), [
      [/\/update$/, () => ok({ ...LINK, direction: 'push' })],
      [/\/remove$/, () => ok(null)],
    ]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Settings' }));
    const settings = within(dialog).getByRole('group', { name: 'Sync settings' });
    const save = within(settings).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(settings).getByRole('combobox', { name: 'Direction' }), {
      target: { value: 'push' },
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/update'))?.body).toEqual({
        direction: 'push',
        excludes: ['node_modules/'],
      }),
    );
    fireEvent.click(within(settings).getByRole('button', { name: 'Remove link…' }));
    fireEvent.click(within(settings).getByRole('button', { name: 'Remove link' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/remove'))).toBe(true));
  });
});
