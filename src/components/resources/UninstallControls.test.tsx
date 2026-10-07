/**
 * The RESOURCES tab's one destructive control. What it must get right:
 * offer it only where the shared rule allows, say why not elsewhere, demand the
 * exact name, name the copies it leaves alone and how long Restore lasts, and
 * keep the dialog open — with the server's reason, translated — when the server
 * refuses. The dialog's lifetime across scans is ResourcesView.uninstall.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/resourcesApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/resourcesApi')>()),
  uninstallResource: vi.fn(),
}));

import { UNINSTALL_MODAL_ID, UninstallAction, UninstallDialog } from './UninstallControls';
import { ResourcesUnavailableError, uninstallResource } from '@/lib/resourcesApi';
import { useUiStore } from '@/stores/uiStore';
import { res } from '@/__tests__/fixtures/resourceCatalog';
import type { ResourceSummary } from '@/types/resources';

const uninstall = vi.mocked(uninstallResource);
const tdd = res({ id: 'sk-claude-tdd', name: 'tdd', fileCount: 3, bytes: 2048 });

beforeEach(() => {
  uninstall.mockReset();
  useUiStore.setState({ activeModal: null });
});
afterEach(() => cleanup());

function openDialog(summary: ResourceSummary = tdd, otherCopies: string[] = ['Codex · Global'], trashPath?: string) {
  const onUninstalled = vi.fn();
  useUiStore.setState({ activeModal: UNINSTALL_MODAL_ID });
  render(<UninstallDialog summary={summary} otherCopies={otherCopies} trashPath={trashPath} onUninstalled={onUninstalled} />);
  return { onUninstalled, dialog: screen.getByRole('dialog') };
}

describe('UninstallAction', () => {
  it('a user-owned skill: a button that asks for the dialog', async () => {
    const onRequest = vi.fn();
    render(<UninstallAction summary={tdd} onRequest={onRequest} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Uninstall' }));
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it('something it may not remove: no button, and the reason in its place', () => {
    render(<UninstallAction summary={res({ id: 'sk-github', name: 'github-review', origin: 'plugin', pluginName: 'github@claude-plugins-official' })} onRequest={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Uninstall' })).not.toBeInTheDocument();
    expect(screen.getByText(/github@claude-plugins-official/)).toBeInTheDocument();
  });

  it('a type it never handles: renders nothing at all', () => {
    const { container } = render(
      <UninstallAction summary={res({ id: 'set-claude', type: 'settings', name: 'settings.json', format: 'config' })} onRequest={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('UninstallDialog', () => {
  it('asks for the exact name, says what moves, what stays and how long Restore lasts, then uninstalls', async () => {
    const result = { trashId: '1791329416741-0a1b2c3d', name: 'tdd', type: 'skill' as const, path: '~/.claude/skills/tdd' };
    uninstall.mockResolvedValue(result);
    const { onUninstalled, dialog } = openDialog(tdd, ['Codex · Global'], '~/Library/Application Support/aasc/data/resource-trash');
    const user = userEvent.setup();

    expect(dialog).toHaveAccessibleName('Uninstall skill “tdd”?');
    expect(dialog).toHaveTextContent('~/.claude/skills/tdd');
    expect(dialog).toHaveTextContent(/AASC trash/i);
    expect(dialog).toHaveTextContent(/Restore button shows for 10 seconds/);
    expect(dialog).toHaveTextContent('~/Library/Application Support/aasc/data/resource-trash');
    expect(dialog).toHaveTextContent(/Not touched: Codex · Global/);
    expect(dialog).toHaveTextContent(/keep it until they restart/i);

    const confirm = within(dialog).getByRole('button', { name: 'Uninstall' });
    const input = within(dialog).getByRole('textbox', { name: /type tdd to confirm/i });
    expect(input).toHaveFocus();
    expect(confirm).toBeDisabled();
    await user.type(input, 'TDD');
    expect(confirm).toBeDisabled(); // case-sensitive, like the server
    await user.clear(input);
    await user.type(input, 'tdd');
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(uninstall).toHaveBeenCalledWith('sk-claude-tdd', 'tdd');
    expect(onUninstalled).toHaveBeenCalledWith(result);
    expect(useUiStore.getState().activeModal).toBeNull();
  });

  it('keeps the dialog open with the server’s reason when it refuses', async () => {
    uninstall.mockRejectedValue(new Error('A scan is running — try again when it finishes'));
    const { onUninstalled, dialog } = openDialog();
    const user = userEvent.setup();
    await user.type(within(dialog).getByRole('textbox'), 'tdd');
    await user.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A scan is running — try again when it finishes');
    expect(within(dialog).getByRole('button', { name: 'Uninstall' })).toBeEnabled();
    expect(onUninstalled).not.toHaveBeenCalled();
  });

  it('a 404 reads as "gone since the scan", not as "only on this machine"', async () => {
    uninstall.mockRejectedValue(new ResourcesUnavailableError());
    const { dialog } = openDialog();
    const user = userEvent.setup();
    await user.type(within(dialog).getByRole('textbox'), 'tdd');
    await user.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('It is no longer there — rescan to refresh.');
  });

  it('Escape closes it without uninstalling anything', async () => {
    openDialog();
    await userEvent.setup().keyboard('{Escape}');
    expect(useUiStore.getState().activeModal).toBeNull();
    expect(uninstall).not.toHaveBeenCalled();
  });

  it('memory: says its MEMORY.md line goes too (and comes back on restore)', () => {
    const { dialog } = openDialog(res({ id: 'mem-x', type: 'memory', name: 'project_x.md', path: '~/.claude/projects/-p/memory/project_x.md' }), []);
    expect(dialog).toHaveTextContent(/MEMORY\.md/);
    expect(dialog).not.toHaveTextContent(/Not touched/);
  });
});
