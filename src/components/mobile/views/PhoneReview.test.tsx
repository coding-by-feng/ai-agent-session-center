// PhoneReview.test.tsx — REVIEW on a phone (AASC-20, feature 7): one column,
// filters in a sheet, an entry opens full screen (alias, source, notes,
// archive, delete), the star is a toggle of its own on the row, and Delete
// asks first in a sheet (never window.confirm).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { DbTranslationLog } from '@/lib/db';

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 20_000 });

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/translationLog', () => ({
  listLogs: vi.fn(),
  setArchived: vi.fn(async () => {}),
  setNotes: vi.fn(async () => {}),
  setFavorite: vi.fn(async () => {}),
  setAlias: vi.fn(async () => {}),
  deleteLog: vi.fn(async () => {}),
}));

import { deleteLog, listLogs, setArchived, setFavorite } from '@/lib/translationLog';
import PhoneReview from './PhoneReview';

function entry(over: Partial<DbTranslationLog> = {}): DbTranslationLog {
  const at = Date.now() - 60_000;
  return {
    id: 1, uuid: 'u1', mode: 'explain-native', nativeLanguage: 'Chinese', learningLanguage: 'English',
    selection: 'pullback', contextLine: '', filePath: '', fileContent: '', prompt: '', response: '## Meaning',
    originSessionId: 's1', originProjectName: 'agent-manager', originSessionTitle: 'AASC', floatTerminalId: '',
    notes: '', archived: 0, favorite: 0, alias: '', sourceFilePath: '', createdAt: at, updatedAt: at, ...over,
  };
}

beforeEach(() => {
  vi.mocked(listLogs).mockResolvedValue([entry(), entry({ id: 2, uuid: 'u2', selection: 'baton', alias: 'Baton', favorite: 1 })]);
  vi.spyOn(window, 'confirm').mockImplementation(() => { throw new Error('window.confirm on a phone'); });
});

const renderView = () => render(<MemoryRouter initialEntries={['/review']}><PhoneReview /></MemoryRouter>);

describe('PhoneReview', () => {
  it('with nothing saved, says how a phone saves one: Ask AI in a chat (AASC-48)', async () => {
    vi.mocked(listLogs).mockResolvedValue([]);
    renderView();
    expect(await screen.findByText('No saved entries yet')).toBeTruthy();
    expect(screen.getByText(/Select text in a session’s Chat, Terminal or a project file and tap Ask AI/)).toBeTruthy();
    expect(screen.queryByText(/click/)).toBeNull();
  });

  it('lists the entries saved on this device, with a 44px star toggle per row', async () => {
    renderView();
    expect(await screen.findByText('pullback')).toBeTruthy();
    expect(screen.getByText('2 entries saved on this device')).toBeTruthy();
    const stars = screen.getAllByRole('button', { name: 'Favorite' });
    expect(stars.map((s) => s.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    await userEvent.setup().click(stars[0]);
    expect(setFavorite).toHaveBeenCalledWith('u1', true);
  });

  it('opens an entry full screen, and archiving it closes the sheet', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: /Baton/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Baton' });
    expect(within(sheet).getByText('baton')).toBeTruthy();
    expect(within(sheet).getByRole('textbox', { name: /Alias/ })).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: 'Archive' }));
    expect(setArchived).toHaveBeenCalledWith('u2', true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('deletes only after a confirm sheet', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: /pullback/ }));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: 'Delete' }));
    expect(deleteLog).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('dialog', { name: 'Delete this saved entry?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(deleteLog).toHaveBeenCalledWith('u1');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('filters from a sheet: favourites only', async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText('pullback');
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    await user.click(within(sheet).getByRole('button', { name: 'Favorites only' }));
    await waitFor(() => expect(vi.mocked(listLogs)).toHaveBeenLastCalledWith(expect.objectContaining({ favorite: true })));
    expect(screen.getByRole('button', { name: 'Filters, 1 set' })).toBeTruthy();
  });
});
