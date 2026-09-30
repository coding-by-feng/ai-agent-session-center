// ResourcesView.states.test.tsx — the RESOURCES tab's loading, unavailable,
// error, empty and scanning states, and the polling behind them.
//
// What this pins:
//  - a 404 is "only on this machine", not a retryable error;
//  - polling runs only while a scan does, one request at a time, and stops on
//    unmount (fake timers below — RTL's async queries are not used with them);
//  - folders added in Sources are scanned again after a relaunch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ResourceCatalog, ResourceProject } from '@/types/resources';
import {
  CATALOG,
  PROJECTS,
  RESOURCES,
  res,
  stubApi,
  catalogGets,
  renderView,
  ready,
  railButton,
  row,
} from '@/__tests__/fixtures/resourceCatalog';

beforeEach(() => {
  stubApi();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

describe('ResourcesView — states', () => {
  it('loading', () => {
    stubApi({ catalogs: ['hang'] });
    renderView();
    expect(screen.getByRole('status')).toHaveTextContent('Loading resources…');
  });

  it('unavailable on a 404 — no Retry, because retrying cannot help', async () => {
    stubApi({ catalogs: [{ status: 404, error: 'Not found' }] });
    renderView();
    expect(await screen.findByText(
      'Resources are available only on this machine — open AASC on the Mac that runs it.',
    )).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('error with Retry', async () => {
    stubApi({ catalogs: [{ status: 500, error: 'Scan exploded' }, CATALOG] });
    renderView();
    expect(await screen.findByRole('alert')).toHaveTextContent('Scan exploded');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await ready();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('empty catalog', async () => {
    stubApi({ catalogs: [{ ...CATALOG, resources: [], findings: [] }] });
    renderView();
    expect(await screen.findByText('No agent resources were found on this machine.')).toBeInTheDocument();
  });

  it('a failed scan that found nothing says the scan failed — not "nothing found"', async () => {
    stubApi({ catalogs: [{ ...CATALOG, state: 'error', error: 'EACCES: permission denied', resources: [], findings: [] }] });
    renderView();
    expect(await screen.findByRole('alert')).toHaveTextContent('Last scan failed: EACCES: permission denied');
    expect(screen.getByText(/the last scan failed before it found anything/i)).toBeInTheDocument();
    expect(screen.queryByText('No agent resources were found on this machine.')).not.toBeInTheDocument();
  });

  it('a failed scan keeps the previous results and says why', async () => {
    stubApi({ catalogs: [{ ...CATALOG, state: 'error', error: 'EACCES: permission denied' }] });
    renderView();
    await ready();
    expect(screen.getByRole('alert')).toHaveTextContent('Last scan failed: EACCES: permission denied');
    expect(railButton('Skills')).toHaveTextContent(/7$/);
  });
});

describe('ResourcesView — saved folders after a relaunch', () => {
  const scanBodies = (mock: ReturnType<typeof stubApi>) => mock.mock.calls
    .filter(([u, init]) => u === '/api/resources/scan' && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)));

  it('re-scans once with saved folders the loaded catalog does not reflect', async () => {
    localStorage.setItem('aasc.resources.extraRoots', '["/Users/me/extra"]');
    const fetchMock = stubApi();
    renderView();
    await ready();
    await waitFor(() => expect(scanBodies(fetchMock)).toEqual([{ extraRoots: ['/Users/me/extra'] }]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rescan' })).toBeEnabled());
    expect(scanBodies(fetchMock)).toHaveLength(1);
  });

  it('leaves the catalog alone when it already includes the added folders', async () => {
    localStorage.setItem('aasc.resources.extraRoots', '["/Users/me/extra"]');
    const added: ResourceProject = {
      id: 'p-extra', name: 'extra', path: '/Users/me/extra', exists: true, evidence: ['added'], counts: {},
    };
    const fetchMock = stubApi({ catalogs: [{ ...CATALOG, projects: [...PROJECTS, added] }] });
    renderView();
    await screen.findByText(/ 4 projects · scanned /); // 3 live fixture projects + the added one
    expect(scanBodies(fetchMock)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scanning and polling (fake timers; RTL's async queries are not used here)
// ---------------------------------------------------------------------------

const SCANNING_EMPTY: ResourceCatalog = {
  ...CATALOG,
  state: 'scanning',
  scannedAt: undefined,
  progress: { phase: 'resources', done: 10, total: 100 },
  resources: [],
  findings: [],
};

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  // Drain fetch → text() → setState chains. Several rounds, because a commit
  // can start an effect whose fetch needs its own round (Rescan → reload).
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
  }
}

describe('ResourcesView — scanning', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  });

  it('shows progress and polls every 750 ms until the scan is ready', async () => {
    const fetchMock = stubApi({
      catalogs: [
        SCANNING_EMPTY,
        { ...SCANNING_EMPTY, progress: { phase: 'hashing', done: 50, total: 100 } },
        { ...CATALOG, scannedAt: Date.now() },
      ],
    });
    renderView();
    await settle();
    expect(screen.getByText(/Scanning… resources 10\/100/)).toBeInTheDocument();
    expect(catalogGets(fetchMock)).toBe(1);

    await settle(749);
    expect(catalogGets(fetchMock)).toBe(1);
    await settle(1);
    expect(catalogGets(fetchMock)).toBe(2);
    expect(screen.getByText(/hashing 50\/100/)).toBeInTheDocument();

    await settle(750);
    expect(catalogGets(fetchMock)).toBe(3);
    expect(railButton('Skills')).toHaveTextContent(/7$/);
    expect(screen.getByText(/scanned just now/)).toBeInTheDocument();

    await settle(5000);
    expect(catalogGets(fetchMock)).toBe(3);
  });

  it('stops polling on unmount', async () => {
    const fetchMock = stubApi({ catalogs: [SCANNING_EMPTY] });
    const { unmount } = renderView();
    await settle();
    await settle(750);
    expect(catalogGets(fetchMock)).toBe(2);
    unmount();
    await settle(5000);
    expect(catalogGets(fetchMock)).toBe(2);
  });

  it('Rescan POSTs /scan, disables itself, and polls to the new results', async () => {
    const withNewSkill: ResourceCatalog = {
      ...CATALOG,
      scannedAt: Date.now(),
      resources: [...RESOURCES, res({ id: 'sk-new', name: 'fresh-skill' })],
    };
    const fetchMock = stubApi({
      catalogs: [CATALOG, { ...CATALOG, state: 'scanning', progress: { phase: 'hashing', done: 1, total: 9 } }, withNewSkill],
    });
    renderView();
    await settle();
    const rescan = screen.getByRole('button', { name: 'Rescan' });
    expect(rescan).toBeEnabled();

    fireEvent.click(rescan);
    await settle();
    expect(fetchMock.mock.calls.some(([u, init]) => u === '/api/resources/scan' && init?.method === 'POST')).toBe(true);
    expect(screen.getByRole('button', { name: 'Rescan' })).toBeDisabled();
    expect(screen.getByText(/hashing 1\/9/)).toBeInTheDocument();

    await settle(750);
    expect(screen.getByRole('button', { name: 'Rescan' })).toBeEnabled();
    expect(row(/^fresh-skill/)).toBeInTheDocument();
  });

  it('never overlaps a slow reload with a poll — one request at a time', async () => {
    const fetchMock = stubApi({
      catalogs: [
        CATALOG,
        { delayMs: 2000, catalog: { ...CATALOG, state: 'scanning', progress: { phase: 'hashing', done: 1, total: 9 } } },
        { ...CATALOG, scannedAt: Date.now() + 1 },
      ],
    });
    renderView();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    await settle();
    expect(catalogGets(fetchMock)).toBe(2); // the reload, in flight for 2s
    await settle(1500);
    expect(catalogGets(fetchMock)).toBe(2); // no poll stacked on top of it
    await settle(500);
    expect(catalogGets(fetchMock)).toBe(2); // it landed: the next poll is 750ms out
    await settle(750);
    expect(catalogGets(fetchMock)).toBe(3);
    expect(screen.getByRole('button', { name: 'Rescan' })).toBeEnabled();
  });

  it('refreshes an open resource once, when the rescan completes', async () => {
    const fetchMock = stubApi({
      catalogs: [
        CATALOG,
        { ...CATALOG, state: 'scanning', progress: { phase: 'hashing', done: 1, total: 9 } },
        { ...CATALOG, scannedAt: Date.now() + 1 },
      ],
    });
    const detailGets = () => fetchMock.mock.calls.filter(([u]) => u === '/api/resources/item/sk-claude-tdd').length;
    renderView('/resources?id=sk-claude-tdd');
    await settle();
    expect(detailGets()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    await settle();
    expect(detailGets()).toBe(1); // still scanning: the open detail is left alone
    await settle(750);
    expect(detailGets()).toBe(2); // a new scannedAt: re-read what is on disk now
    await settle(5000);
    expect(detailGets()).toBe(2);
  });
});
