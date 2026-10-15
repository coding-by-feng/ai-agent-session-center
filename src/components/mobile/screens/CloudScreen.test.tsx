// CloudScreen.test.tsx — the phone's read-only AASC Cloud (AASC-51): More → Cloud (status, resources,
// projects, refresh), a resource's versions, the Cloud row in This phone and the More list's way in. No screen
// offers an upload, install, restore, publish, clone, pull, account or alias action.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/deviceIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/deviceIdentity')>()),
  getClientId: () => 'phone',
}));

import CloudScreen from './CloudScreen';
import CloudResourceScreen from './CloudResourceScreen';
import ThisPhoneScreen from './ThisPhoneScreen';
import MoreScreen from './MoreScreen';
import { usePhoneNavStore, defaultStacks } from '@/stores/phoneNavStore';
import { CLOUD_FETCH_WORDS } from '@/lib/chat/cloudBrowseApi';

const RES_A = '0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c';
const RES_B = '1c7f8b4d-2a3e-4f6b-8c9d-8e7f6a5b4c3d';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const STATUS = { connected: true, state: 'connected', lastSyncAt: ago(120_000), problem: null };
const RESOURCES = [
  { id: RES_A, name: 'retouch', kind: 'skill', agent: 'claude', scope: 'global', version: 3, updatedAt: ago(2 * 86_400_000), bytes: 2500, files: 2 },
  { id: RES_B, name: 'house rules', kind: 'rule', agent: 'shared', scope: 'global', version: 12, updatedAt: ago(3_600_000), bytes: 900, files: 1 },
];
const PROJECTS = [{ id: 'p1', name: 'Website', host: 'github.com', owner: 'kason', repo: 'website', branch: 'main', resources: 4 }];
const BROWSE = { ...STATUS, resources: RESOURCES, projects: PROJECTS, truncated: false };

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let routes: Record<string, () => Response | Promise<Response>>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  routes = {
    '/api/phone-cloud/status': () => reply(STATUS),
    '/api/phone-cloud/browse': () => reply(BROWSE),
    '/api/phone-cloud/browse?refresh=1': () => reply(BROWSE),
  };
  fetchMock = vi.fn(async (url: string) => (routes[url] ? routes[url]() : reply({ error: 'Not found' }, 404)));
  vi.stubGlobal('fetch', fetchMock);
  usePhoneNavStore.setState({ tab: 'more', stacks: defaultStacks() });
});

afterEach(() => vi.unstubAllGlobals());

const urls = () => fetchMock.mock.calls.map((c) => c[0] as string);
/** Nothing on these screens may change the cloud. */
function expectReadOnly() {
  for (const word of [/install/i, /publish/i, /restore/i, /upload/i, /delete/i, /clone/i, /pull project/i, /disconnect/i, /revoke/i, /alias/i]) {
    expect(screen.queryByRole('button', { name: word }), String(word)).toBeNull();
  }
}

describe('More → Cloud', () => {
  it('shows the connection, then the resources newest-first, each opening its versions', async () => {
    const user = userEvent.setup();
    render(<CloudScreen />);
    expect(screen.getByText('Loading AASC Cloud…')).toBeTruthy();
    const status = await screen.findByTestId('cloud-status');
    expect(status.textContent).toContain('Connected');
    expect(status.textContent).toContain('Last synced 2 min ago');
    const rows = screen.getAllByTestId('cloud-resource-row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('retouch'), expect.stringContaining('house rules'),
    ]);
    expect(rows[0].textContent).toContain('Skill · Claude Code · v3');
    expect(rows[0].textContent).toContain('Updated 2 days ago');
    expect(screen.getByRole('tab', { name: /Resources/ }).textContent).toContain('2');
    await user.click(within(rows[1]).getByRole('button'));
    expect(usePhoneNavStore.getState().stacks.more.at(-1)).toBe(`/more/cloud/${RES_B}`);
    expect(screen.getByText(/Read-only on this phone/)).toBeTruthy();
    expectReadOnly();
  });

  it('lists the projects with their GitHub repository and default branch', async () => {
    const user = userEvent.setup();
    render(<CloudScreen />);
    await user.click(await screen.findByRole('tab', { name: /Projects/ }));
    const row = screen.getByTestId('cloud-project-row');
    expect(row.textContent).toContain('Website');
    expect(row.textContent).toContain('github.com/kason/website');
    expect(row.textContent).toContain('Branch main · 4 resources');
    // A project row only informs: no button to clone or pull.
    expect(within(row).queryByRole('button')).toBeNull();
    expectReadOnly();
  });

  it('Refresh reads again through the Mac; a failed refresh keeps the list and says so', async () => {
    const user = userEvent.setup();
    render(<CloudScreen />);
    await screen.findByTestId('cloud-status');
    routes['/api/phone-cloud/browse?refresh=1'] = () => { throw new TypeError('Failed to fetch'); };
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(urls()).toContain('/api/phone-cloud/browse?refresh=1'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Couldn’t refresh');
    expect(alert.textContent).toContain(CLOUD_FETCH_WORDS.unreachable);
    expect(screen.getAllByTestId('cloud-resource-row')).toHaveLength(2);
  });

  it('with no cloud connection, says how to connect on the desktop and offers to check again', async () => {
    const user = userEvent.setup();
    const none = { connected: false, state: 'not-connected', lastSyncAt: null, problem: null, resources: [], projects: [], truncated: false };
    routes['/api/phone-cloud/browse'] = () => reply(none);
    routes['/api/phone-cloud/browse?refresh=1'] = () => reply(none);
    render(<CloudScreen />);
    expect(await screen.findByText('This Mac isn’t connected to AASC Cloud', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('Connect this Mac to AASC Cloud on the desktop: RESOURCES → Cloud → Connection.')).toBeTruthy();
    expect(screen.getByTestId('cloud-status').textContent).toContain('Not connected');
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(urls()).toContain('/api/phone-cloud/browse?refresh=1'));
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('a revoked Mac, a cloud problem and an unreachable Mac each say what to do', async () => {
    routes['/api/phone-cloud/browse'] = () => reply({ connected: false, state: 'revoked', lastSyncAt: null, problem: 'This Mac’s cloud device was revoked. Connect it again on your Mac: RESOURCES → Cloud → Connection.', resources: [], projects: [], truncated: false });
    const { unmount } = render(<CloudScreen />);
    expect(await screen.findByText('This Mac’s cloud device was revoked')).toBeTruthy();
    expect(screen.getByText('Connect it again on the desktop: RESOURCES → Cloud → Connection.')).toBeTruthy();
    unmount();

    routes['/api/phone-cloud/browse'] = () => reply({ ...BROWSE, problem: 'Your Mac can’t reach AASC Cloud right now. Check its internet connection, then try again.' });
    const second = render(<CloudScreen />);
    // The list stays, under a warning that says what the Mac met.
    expect(await screen.findByText(/can’t reach AASC Cloud right now/)).toBeTruthy();
    expect(screen.getAllByTestId('cloud-resource-row')).toHaveLength(2);
    second.unmount();

    routes['/api/phone-cloud/browse'] = () => { throw new TypeError('Failed to fetch'); };
    render(<CloudScreen />);
    expect(await screen.findByText('Couldn’t load AASC Cloud')).toBeTruthy();
    expect(screen.getByText(CLOUD_FETCH_WORDS.unreachable)).toBeTruthy();
    routes['/api/phone-cloud/browse?refresh=1'] = () => reply(BROWSE);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findAllByTestId('cloud-resource-row')).toHaveLength(2);
  });

  it('an empty cloud says how to fill it, from the Mac', async () => {
    routes['/api/phone-cloud/browse'] = () => reply({ ...BROWSE, resources: [], projects: [] });
    const user = userEvent.setup();
    render(<CloudScreen />);
    expect(await screen.findByText('No resources in AASC Cloud yet')).toBeTruthy();
    expect(screen.getByText(/Publish skills, commands and rules from your Mac/)).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: /Projects/ }));
    expect(screen.getByText('No projects in AASC Cloud yet')).toBeTruthy();
  });
});

describe('a resource’s versions', () => {
  it('shows what it is and its latest versions, the current one marked', async () => {
    routes[`/api/phone-cloud/resources/${RES_B}/versions`] = () => reply({
      ...STATUS,
      resource: RESOURCES[1],
      versions: [
        { version: 12, createdAt: '2026-10-12T08:00:00.000Z', bytes: 900, files: 1 },
        { version: 11, createdAt: '2026-10-11T08:00:00.000Z', bytes: 1200, files: 2 },
      ],
      truncated: true,
    });
    render(<CloudResourceScreen resourceId={RES_B} />);
    expect(screen.getByText('Loading versions…')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'house rules' })).toBeTruthy();
    expect(screen.getByText('Claude Code and Codex')).toBeTruthy();
    const rows = screen.getAllByTestId('cloud-version-row');
    expect(rows[0].textContent).toContain('Version 12');
    expect(rows[0].textContent).toContain('Current');
    expect(rows[0].textContent).toContain('900 B · 1 file');
    expect(rows[1].textContent).not.toContain('Current');
    expect(rows[1].textContent).toContain('1.2 KB · 2 files');
    expect(screen.getByText('Showing the 2 newest. Older versions are in AASC Cloud too.')).toBeTruthy();
    expectReadOnly();
  });

  it('a resource that is gone, or a Mac without a connection, says so', async () => {
    routes[`/api/phone-cloud/resources/${RES_A}/versions`] = () => reply({ ...STATUS, resource: null, versions: [], truncated: false });
    const { unmount } = render(<CloudResourceScreen resourceId={RES_A} />);
    expect(await screen.findByText('This resource isn’t in AASC Cloud any more')).toBeTruthy();
    unmount();
    routes[`/api/phone-cloud/resources/${RES_A}/versions`] = () => reply({ connected: false, state: 'not-connected', lastSyncAt: null, problem: null, resource: null, versions: [], truncated: false });
    render(<CloudResourceScreen resourceId={RES_A} />);
    expect(await screen.findByText(/RESOURCES → Cloud → Connection/)).toBeTruthy();
  });
});

describe('This phone → AASC Cloud', () => {
  it('shows connected or not and the last sync, and opens More → Cloud', async () => {
    const user = userEvent.setup();
    render(<ThisPhoneScreen />);
    const row = screen.getByTestId('this-phone-cloud');
    expect(row.textContent).toContain('Checking…');
    await waitFor(() => expect(row.textContent).toContain('Connected'));
    expect(row.textContent).toContain('Last synced 2 min ago');
    await user.click(within(row).getByRole('button'));
    expect(usePhoneNavStore.getState().stacks.more.at(-1)).toBe('/more/cloud');
  });

  it('says a sync problem in plain words, and an older Mac plainly too', async () => {
    routes['/api/phone-cloud/status'] = () => reply({ connected: true, state: 'offline', lastSyncAt: null, problem: 'Your Mac can’t reach AASC Cloud right now. Check its internet connection, then try again.' });
    const { unmount } = render(<ThisPhoneScreen />);
    const row = screen.getByTestId('this-phone-cloud');
    await waitFor(() => expect(row.textContent).toContain('Offline'));
    expect(row.textContent).toContain('Your Mac can’t reach AASC Cloud right now.');
    expect(row.textContent).not.toContain('Check its internet connection');
    unmount();
    delete routes['/api/phone-cloud/status'];
    render(<ThisPhoneScreen />);
    const older = screen.getByTestId('this-phone-cloud');
    await waitFor(() => expect(older.textContent).toContain('Update AASC on your Mac to see it'));
  });
});

describe('More', () => {
  it('lists AASC Cloud as its own section, which opens More → Cloud', async () => {
    const user = userEvent.setup();
    render(<MoreScreen />);
    const section = screen.getByRole('region', { name: 'AASC Cloud' });
    await user.click(within(section).getByRole('button', { name: /Cloud/ }));
    expect(usePhoneNavStore.getState().stacks.more.at(-1)).toBe('/more/cloud');
  });
});
