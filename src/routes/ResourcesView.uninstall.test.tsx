// ResourcesView.uninstall.test.tsx — the uninstall → Restore round trip as the
// view drives it: the dialog lives in the view (a scan landing must not take it
// away), the detail closes, the catalog rescans with the folders added in
// Sources, and a Restore toast brings the resource back — and offers Restore
// again when that fails. The server half is test/resourceUninstall.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import ToastContainer from '@/components/ui/ToastContainer';
import { EXTRA_ROOTS_STORAGE_KEY } from '@/lib/resourcesApi';
import { useUiStore } from '@/stores/uiStore';
import { CATALOG, LAZY, stubApi, ready, detail, renderView, urlParams } from '@/__tests__/fixtures/resourceCatalog';

const TRASH_ID = '1791329416741-0a1b2c3d';

function json(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) } as Response;
}

let api: ReturnType<typeof vi.fn>;
/** What the restore route answers, in order (the last one repeats). */
let restoreReplies: Array<{ status: number; body: unknown }>;

function install(base: ReturnType<typeof stubApi>) {
  api = vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input, 'http://localhost').pathname;
    if (path === '/api/resources/item/sk-claude-tdd/uninstall' && init?.method === 'POST') {
      return json(200, { success: true, data: { trashId: TRASH_ID, name: 'tdd', type: 'skill', path: '~/.claude/skills/tdd' } });
    }
    if (path === `/api/resources/trash/${TRASH_ID}/restore` && init?.method === 'POST') {
      const reply = restoreReplies.length > 1 ? restoreReplies.shift()! : restoreReplies[0];
      return json(reply.status, reply.body);
    }
    return base(input, init);
  });
  vi.stubGlobal('fetch', api);
}

beforeEach(() => {
  useUiStore.setState({ activeModal: null });
  restoreReplies = [{ status: 200, body: { success: true, data: { name: 'tdd', type: 'skill', path: '~/.claude/skills/tdd' } } }];
});

afterEach(() => {
  localStorage.removeItem(EXTRA_ROOTS_STORAGE_KEY);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const posts = (suffix: string) =>
  api.mock.calls.filter(([input, init]) => String(input).endsWith(suffix) && init?.method === 'POST');
const itemGets = () =>
  api.mock.calls.filter(([input, init]) => String(input) === '/api/resources/item/sk-claude-tdd' && (init?.method ?? 'GET') === 'GET');

async function uninstallTdd(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(detail()).getByRole('button', { name: 'Uninstall' }));
  const dialog = screen.getByRole('dialog', { name: 'Uninstall skill “tdd”?' });
  await user.type(within(dialog).getByRole('textbox'), 'tdd');
  await user.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
}

describe('ResourcesView — uninstall', () => {
  it('uninstalls from the detail pane, closes it, rescans, and Restore brings it back', async () => {
    localStorage.setItem(EXTRA_ROOTS_STORAGE_KEY, JSON.stringify(['/Users/me/extra']));
    install(stubApi());
    renderView('/resources?id=sk-claude-tdd');
    render(createElement(ToastContainer));
    await ready();
    const user = userEvent.setup();
    // With a Sources folder saved, the view already rescans once on mount (so the
    // first scan includes it); count from here.
    await waitFor(() => expect(posts('/api/resources/scan').length).toBeGreaterThan(0), LAZY);
    const scansBefore = posts('/api/resources/scan').length;

    await uninstallTdd(user);
    expect(JSON.parse(String(posts('/item/sk-claude-tdd/uninstall')[0][1]?.body))).toEqual({ confirmName: 'tdd' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Resource detail' })).not.toBeInTheDocument(), LAZY);
    expect(urlParams().get('id')).toBeNull();
    // The rescan carries the folders added in Sources, like the Rescan button.
    await waitFor(() => expect(posts('/api/resources/scan')).toHaveLength(scansBefore + 1), LAZY);
    expect(JSON.parse(String(posts('/api/resources/scan')[scansBefore][1]?.body))).toEqual({ extraRoots: ['/Users/me/extra'] });

    expect(await screen.findByText('Uninstalled tdd', {}, LAZY)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(posts(`/trash/${TRASH_ID}/restore`)).toHaveLength(1), LAZY);
    expect(await screen.findByText('Restored tdd', {}, LAZY)).toBeInTheDocument();
    await waitFor(() => expect(posts('/api/resources/scan')).toHaveLength(scansBefore + 2), LAZY);
  });

  it('a scan landing while the dialog is open keeps it — and what was typed in it', async () => {
    // The second GET reports a new scan: the detail pane (keyed by scannedAt) remounts.
    install(stubApi({ catalogs: [CATALOG, { ...CATALOG, scannedAt: (CATALOG.scannedAt ?? 0) + 60_000 }] }));
    renderView('/resources?id=sk-claude-tdd');
    await ready();
    const user = userEvent.setup();
    await user.click(within(detail()).getByRole('button', { name: 'Uninstall' }));
    await user.type(within(screen.getByRole('dialog')).getByRole('textbox'), 'td');
    const gets = itemGets().length;

    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    await waitFor(() => expect(itemGets().length).toBeGreaterThan(gets), LAZY); // the pane remounted

    const dialog = screen.getByRole('dialog', { name: 'Uninstall skill “tdd”?' });
    expect(within(dialog).getByRole('textbox')).toHaveValue('td');
  });

  it('a Restore that fails offers Restore again — the first toast and its button are gone', async () => {
    restoreReplies = [
      { status: 409, body: { success: false, error: 'Something is already at ~/.claude/skills/tdd — move it away first' } },
      { status: 200, body: { success: true, data: { name: 'tdd', type: 'skill', path: '~/.claude/skills/tdd' } } },
    ];
    install(stubApi());
    renderView('/resources?id=sk-claude-tdd');
    render(createElement(ToastContainer));
    await ready();
    const user = userEvent.setup();
    await uninstallTdd(user);

    await user.click(await screen.findByRole('button', { name: 'Restore' }, LAZY));
    expect(await screen.findByText('Something is already at ~/.claude/skills/tdd — move it away first', {}, LAZY)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Restored tdd', {}, LAZY)).toBeInTheDocument();
    expect(posts(`/trash/${TRASH_ID}/restore`)).toHaveLength(2);
  });

  it('a Restore that finds no trash entry says so, and offers nothing more to click', async () => {
    restoreReplies = [{ status: 404, body: { success: false, error: 'Nothing in the trash under that id' } }];
    install(stubApi());
    renderView('/resources?id=sk-claude-tdd');
    render(createElement(ToastContainer));
    await ready();
    const user = userEvent.setup();
    await uninstallTdd(user);
    await user.click(await screen.findByRole('button', { name: 'Restore' }, LAZY));
    expect(await screen.findByText('Nothing to restore — that trash entry is gone.', {}, LAZY)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });

  it('leaving the tab with the dialog open closes it, rather than stranding the modal', async () => {
    install(stubApi());
    const view = renderView('/resources?id=sk-claude-tdd');
    await ready();
    await userEvent.setup().click(within(detail()).getByRole('button', { name: 'Uninstall' }));
    expect(useUiStore.getState().activeModal).toBe('resource-uninstall');
    act(() => view.unmount());
    expect(useUiStore.getState().activeModal).toBeNull();
  });
});
