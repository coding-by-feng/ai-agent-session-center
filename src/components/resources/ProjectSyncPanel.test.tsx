import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ProjectSyncPanel from './ProjectSyncPanel';
import { suggestRemoteRoot } from '@/lib/projectSyncFormat';
import { CATALOG } from '@/__tests__/fixtures/resourceCatalog';
import type { SyncEntry, SyncLink, SyncRun } from '@/types/projectSync';

const DEVICE = {
  id: 'd1',
  name: 'mini',
  host: 'mini.local',
  username: 'me',
  port: 22,
  fingerprint: 'f',
  home: '/Users/me',
  platform: 'darwin',
  checkedAt: 0,
};
const LINK: SyncLink = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'app → mini',
  projectId: 'p-app',
  localPath: '~/code/app',
  deviceId: 'd1',
  remoteRoot: '/Users/me/code/app',
  direction: 'push',
  excludes: [],
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
  counts: { add: 1, drift: 1, same: 3 },
  done: 0,
  failed: 0,
  total: 1,
  bytes: { toSend: 2048, sent: 0 },
  groups: [
    {
      id: '.git',
      isRepo: true,
      counts: { change: 2 },
      bytes: 10,
      decision: 'review',
      state: 'device-changed',
      local: { head: 'main', commit: 'abcdef1234567' },
      device: { head: 'main', commit: '0123456789ab' },
    },
  ],
  warnings: [
    '2 credential files (such as .env) will be copied as-is. Their contents are never shown here.',
  ],
  pendingDecisions: 2,
};
const entry = (o: Partial<SyncEntry>): SyncEntry => ({
  id: '33333333-3333-4333-8333-333333333333',
  path: 'a.txt',
  groupId: '',
  change: 'add',
  action: 'push',
  flags: [],
  state: 'pending',
  local: { kind: 'file', size: 2, mtimeMs: 1, mode: 420 },
  ...o,
});
const ENTRIES = [
  entry({}),
  entry({
    id: '44444444-4444-4444-8444-444444444444',
    path: '.env',
    change: 'drift',
    action: 'review',
    flags: ['credential'],
    device: { kind: 'file', size: 3, mtimeMs: 1, mode: 420 },
  }),
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stub(run: SyncRun, routes: Record<string, (body: unknown) => unknown> = {}) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      for (const [k, fn] of Object.entries(routes))
        if (url.includes(k)) {
          const out = fn(body) as { status?: number; json: unknown };
          return new Response(JSON.stringify(out.json), { status: out.status ?? 200 });
        }
      const data = url.endsWith('/api/resources/transfers')
        ? { devices: [DEVICE], tasks: [] }
        : url.endsWith('/api/resources/sync')
          ? { links: [LINK], runs: [run] }
          : url.includes('/entries?')
            ? { entries: ENTRIES, total: ENTRIES.length, offset: 0 }
            : run;
      return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    }),
  );
  return calls;
}

describe('ProjectSyncPanel', () => {
  it('suggests the same home-relative folder on the device', () => {
    expect(suggestRemoteRoot('~/code/app', '/home/me')).toBe('/home/me/code/app');
    expect(suggestRemoteRoot('/srv/app', '/home/me')).toBe('');
  });

  it('lists links and opens a run whose Run stays disabled until every decision is made', async () => {
    stub(RUN);
    render(<ProjectSyncPanel catalog={CATALOG} onDevices={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /app → mini/ }));
    expect(await screen.findByText(/changed on the device/)).toBeTruthy();
    expect(screen.getByText(/main abcdef1234/)).toBeTruthy();
    expect(screen.getByText(/credential files \(such as \.env\)/)).toBeTruthy();
    const run = screen.getByRole('button', { name: /Run 1 change/ }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(screen.getByText('2 decisions left')).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Planned changes' });
    expect(within(list).getByText(/🔒 \.env/)).toBeTruthy();
    // A credential file never offers a diff.
    const envRow = within(list)
      .getByText(/🔒 \.env/)
      .closest('li')!;
    expect(within(envRow).queryByRole('button', { name: 'Diff' })).toBeNull();
    // The sync choice is offered but disabled for a repository changed on the device.
    const repoSelect = screen.getByRole('combobox', { name: /Repository/ }) as HTMLSelectElement;
    expect([...repoSelect.options].find((o) => o.value === 'sync')?.disabled).toBe(true);
  });

  it('asks before running while sessions are working, then runs with confirmation', async () => {
    const ready = { ...RUN, pendingDecisions: 0, groups: [] };
    let confirmed: unknown = null;
    const calls = stub(ready, {
      '/run': (body) => {
        confirmed = body;
        return (body as { confirmLiveSessions: boolean }).confirmLiveSessions
          ? { json: { success: true, data: { ...ready, state: 'running' } } }
          : {
              status: 409,
              json: {
                success: false,
                error: '1 AASC session is working in this project.',
                code: 'live-sessions',
              },
            };
      },
    });
    render(<ProjectSyncPanel catalog={CATALOG} onDevices={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /app → mini/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Run 1 change/ }));
    expect(await screen.findByText(/1 AASC session is working/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run anyway' }));
    await waitFor(() => expect(confirmed).toEqual({ confirmLiveSessions: true }));
    expect(calls.filter((c) => c.url.endsWith('/run')).length).toBe(2);
  });

  it('sends a per-entry decision', async () => {
    const calls = stub(RUN);
    render(<ProjectSyncPanel catalog={CATALOG} onDevices={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /app → mini/ }));
    const select = (await screen.findByRole('combobox', {
      name: 'Action for .env',
    })) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'keep' } });
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/decisions'))?.body).toEqual({
        entries: { '44444444-4444-4444-8444-444444444444': 'keep' },
      }),
    );
  });

  it('reloads the plan after a decision, so the select shows what the server will do', async () => {
    let updatedAt = 1;
    const calls = stub(RUN, {
      '/decisions': () => {
        updatedAt += 1;
        return { json: { success: true, data: { ...RUN, updatedAt } } };
      },
    });
    render(<ProjectSyncPanel catalog={CATALOG} onDevices={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /app → mini/ }));
    const select = (await screen.findByRole('combobox', {
      name: 'Action for .env',
    })) as HTMLSelectElement;
    const before = calls.filter((c) => c.url.includes('/entries?')).length;
    fireEvent.change(select, { target: { value: 'keep' } });
    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes('/entries?')).length).toBeGreaterThan(before),
    );
  });

  it('a stale plan offers no Run and says why', async () => {
    stub({
      ...RUN,
      state: 'failed',
      pendingDecisions: 0,
      stale: 'What is left out changed after this compare. Compare again.',
    });
    render(<ProjectSyncPanel catalog={CATALOG} onDevices={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /app → mini/ }));
    expect(await screen.findByText(/left out changed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Run|Retry/ })).toBeNull();
  });

  it('points to Devices when there are none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify({
              success: true,
              data: url.endsWith('/transfers')
                ? { devices: [], tasks: [] }
                : { links: [], runs: [] },
            }),
          ),
      ),
    );
    const onDevices = vi.fn();
    render(<ProjectSyncPanel catalog={CATALOG} onDevices={onDevices} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Devices' }));
    expect(onDevices).toHaveBeenCalled();
  });
});
