// ReviewView.test.tsx — the REVIEW tab: summary line, toolbar, the two empty
// states, per-row actions, date format and the ?uuid= deep link.
//
// `@/lib/translationLog` is mocked, so no IndexedDB is involved; the rows the
// view lists are whatever `listLogs` resolves with.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import type { DbTranslationLog } from '@/lib/db';
import {
  listLogs,
  setArchived,
  setNotes,
  setFavorite,
  setAlias,
  deleteLog,
} from '@/lib/translationLog';
import { showToast } from '@/components/ui/ToastContainer';
import ReviewView from './ReviewView';

vi.mock('@/components/ui/ToastContainer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/ToastContainer')>()),
  showToast: vi.fn(),
}));

vi.mock('@/lib/translationLog', () => ({
  listLogs: vi.fn(),
  setArchived: vi.fn(),
  setNotes: vi.fn(),
  setFavorite: vi.fn(),
  setAlias: vi.fn(),
  deleteLog: vi.fn(),
}));

const SUMMARY = 'Saved explanations & translations';
const NO_ENTRIES = 'No saved entries yet';
const NO_MATCH = 'No entries match these filters';

function entry(overrides: Partial<DbTranslationLog> = {}): DbTranslationLog {
  const at = Date.now() - 5 * 60_000 - 1_000;
  return {
    id: 1,
    uuid: 'uuid-1',
    mode: 'explain-learning',
    nativeLanguage: 'Chinese',
    learningLanguage: 'English',
    selection: 'pullback',
    contextLine: '',
    filePath: '',
    fileContent: '',
    prompt: '',
    response: '',
    originSessionId: 'session-1',
    originProjectName: 'agent-manager',
    originSessionTitle: '',
    floatTerminalId: 'term-1',
    notes: '',
    archived: 0,
    favorite: 0,
    alias: '',
    sourceFilePath: '',
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function mockRows(rows: DbTranslationLog[]) {
  vi.mocked(listLogs).mockResolvedValue(rows);
}

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{pathname + search}</output>;
}

function renderView(path = '/review') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ReviewView />
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** The header button that expands a row (its accessible name starts with the row's title). */
async function rowHeader(name: RegExp | string) {
  return screen.findByRole('button', { name });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listLogs).mockResolvedValue([]);
  vi.mocked(setArchived).mockResolvedValue(undefined);
  vi.mocked(setNotes).mockResolvedValue(undefined);
  vi.mocked(setFavorite).mockResolvedValue(undefined);
  vi.mocked(setAlias).mockResolvedValue(undefined);
  vi.mocked(deleteLog).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------

describe('ReviewView — summary line', () => {
  it('names the tab and counts the entries', async () => {
    mockRows([entry({ uuid: 'a' }), entry({ uuid: 'b' })]);
    renderView();
    expect(await screen.findByText(`${SUMMARY} · 2 entries`)).toBeInTheDocument();
  });

  it('says "1 entry", never "1 entries"', async () => {
    mockRows([entry()]);
    renderView();
    expect(await screen.findByText(`${SUMMARY} · 1 entry`)).toBeInTheDocument();
  });

  it('shows the name alone, with no "0 entries", when nothing is listed', async () => {
    renderView();
    expect(await screen.findByText(NO_ENTRIES)).toBeInTheDocument();
    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
    expect(screen.queryByText(/0 entries/)).not.toBeInTheDocument();
  });

  it('the empty hint names only controls that still exist', async () => {
    renderView();
    const box = (await screen.findByText(NO_ENTRIES)).closest('[role="status"]') as HTMLElement;
    expect(box.textContent).toContain('click 🔎 / 🌐');
    expect(box.textContent).not.toMatch(/Translate previous answer|toolbar buttons/);
  });
});

// A failed IndexedDB read used to look exactly like "nothing saved yet".
describe('ReviewView — load failure', () => {
  it('says the read failed and retries on demand', async () => {
    vi.mocked(listLogs).mockRejectedValueOnce(new Error('IndexedDB is unavailable'));
    renderView();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not read your saved entries');
    expect(alert.textContent).toContain('IndexedDB is unavailable');

    mockRows([entry()]);
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(`${SUMMARY} · 1 entry`)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ReviewView — loading and a failed refresh', () => {
  it('says it is loading until the first read settles, never "nothing saved" first', async () => {
    let settle!: (rows: DbTranslationLog[]) => void;
    vi.mocked(listLogs).mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    renderView();
    const loading = screen.getByText('Loading saved entries…').closest('[role="status"]');
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(NO_ENTRIES)).not.toBeInTheDocument();

    await act(async () => settle([]));
    expect(await screen.findByText(NO_ENTRIES)).toBeInTheDocument();
  });

  it('keeps the rows when a later read fails, says they are stale, and Retry recovers', async () => {
    mockRows([entry()]);
    renderView();
    await rowHeader(/Explain \(learning\)/);

    vi.mocked(listLogs).mockRejectedValue(new Error('IndexedDB is unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    const note = await screen.findByRole('alert');
    expect(note).toHaveTextContent("Couldn't refresh. Showing the last results.");
    expect(screen.getByRole('button', { name: /Explain \(learning\)/ })).toBeInTheDocument();
    expect(screen.queryByText('Could not read your saved entries')).not.toBeInTheDocument();

    mockRows([entry()]);
    fireEvent.click(within(note).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

describe('ReviewView — toolbar', () => {
  it('names the mode and show selects through their Field captions', async () => {
    renderView();
    const mode = await screen.findByRole('combobox', { name: 'Mode' });
    const show = screen.getByRole('combobox', { name: 'Show' });
    expect(mode).toHaveValue('all');
    expect(show).toHaveValue('active');
    // Every mode, including the two live translate-selection ones the old list
    // left out (so the commonest entries could not be filtered to).
    expect(within(mode).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All modes',
      'Explain (learning)',
      'Explain (native)',
      'Vocabulary (native)',
      'Translate → learning',
      'Translate → native',
      'Translate answer',
      'Translate file',
      'Custom prompt',
    ]);
    expect(within(show).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Active only',
      'Archived only',
      'All',
    ]);
  });

  it('hands the chosen mode and archive filter to listLogs', async () => {
    renderView();
    await screen.findByText(NO_ENTRIES);

    fireEvent.change(screen.getByRole('combobox', { name: 'Mode' }), { target: { value: 'custom' } });
    await waitFor(() =>
      expect(listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'custom', archived: 'active' })),
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: 'archived' } });
    await waitFor(() =>
      expect(listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'custom', archived: 'archived' })),
    );
  });

  it('Favorites is a toggle: aria-pressed flips and listLogs asks for favourites only', async () => {
    renderView();
    const favorites = await screen.findByRole('button', { name: 'Favorites' });
    expect(favorites).toHaveAttribute('aria-pressed', 'false');
    expect(favorites).toHaveAttribute('title', 'Show only favorited entries');

    fireEvent.click(favorites);
    expect(favorites).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() =>
      expect(listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ favorite: true })),
    );

    fireEvent.click(favorites);
    expect(favorites).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() =>
      expect(listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ favorite: undefined })),
    );
  });

  it('search is labelled, debounced by 200ms, and reaches listLogs', async () => {
    renderView();
    const search = await screen.findByRole('textbox', { name: 'Search saved entries' });

    fireEvent.change(search, { target: { value: 'pull' } });
    expect(listLogs).not.toHaveBeenCalledWith(expect.objectContaining({ search: 'pull' }));
    await waitFor(() =>
      expect(listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'pull' })),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() =>
      expect(listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ search: '' })),
    );
  });
});

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

describe('ReviewView — empty states', () => {
  it('tells a user with nothing saved how entries get here', async () => {
    renderView();
    expect(await screen.findByText(NO_ENTRIES)).toBeInTheDocument();
    expect(screen.getByText(/Select text in the terminal or in a markdown file/)).toBeInTheDocument();
    expect(screen.queryByText(NO_MATCH)).not.toBeInTheDocument();
  });

  it('says no entries match once Favorites hides everything', async () => {
    renderView();
    await screen.findByText(NO_ENTRIES);
    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));
    expect(await screen.findByText(NO_MATCH)).toBeInTheDocument();
    expect(screen.queryByText(NO_ENTRIES)).not.toBeInTheDocument();
  });

  it('says no entries match once a mode filter hides everything', async () => {
    renderView();
    await screen.findByText(NO_ENTRIES);
    fireEvent.change(screen.getByRole('combobox', { name: 'Mode' }), { target: { value: 'vocab-native' } });
    expect(await screen.findByText(NO_MATCH)).toBeInTheDocument();
  });

  it('says no entries match for "Archived only"', async () => {
    renderView();
    await screen.findByText(NO_ENTRIES);
    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: 'archived' } });
    expect(await screen.findByText(NO_MATCH)).toBeInTheDocument();
  });

  it('says no entries match once a search hides everything', async () => {
    renderView();
    await screen.findByText(NO_ENTRIES);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search saved entries' }), { target: { value: 'zzz' } });
    expect(await screen.findByText(NO_MATCH)).toBeInTheDocument();
  });

  it('a blank search is not a filter', async () => {
    renderView();
    await screen.findByText(NO_ENTRIES);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search saved entries' }), { target: { value: '   ' } });
    await waitFor(() =>
      expect(listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ search: '   ' })),
    );
    expect(screen.getByText(NO_ENTRIES)).toBeInTheDocument();
  });

  it('"All" archive state widens the list, so an empty result is still "nothing saved"', async () => {
    renderView();
    await screen.findByText(NO_ENTRIES);
    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: 'all' } });
    await waitFor(() =>
      expect(listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ archived: 'all' })),
    );
    expect(screen.getByText(NO_ENTRIES)).toBeInTheDocument();
    expect(screen.queryByText(NO_MATCH)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

describe('ReviewView — rows', () => {
  it('lists the entries as a named list', async () => {
    mockRows([entry({ uuid: 'a' }), entry({ uuid: 'b' })]);
    renderView();
    const list = await screen.findByRole('list', { name: 'Saved entries' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows mode, language, origin, age and a snippet in the header', async () => {
    mockRows([entry({ originSessionTitle: 'Fix the bug', selection: 'pullback' })]);
    renderView();
    const header = await rowHeader(/Explain \(learning\)/);
    expect(within(header).getByText('Explain (learning)')).toBeInTheDocument();
    expect(within(header).getByText('→ Chinese')).toBeInTheDocument();
    expect(within(header).getByText('agent-manager · Fix the bug · 5m ago')).toBeInTheDocument();
    expect(within(header).getByText('pullback')).toBeInTheDocument();
  });

  it('falls back to "unknown project" and "(no source captured)"', async () => {
    mockRows([entry({ originProjectName: '', selection: '' })]);
    renderView();
    const header = await rowHeader(/Explain \(learning\)/);
    expect(within(header).getByText('unknown project · 5m ago')).toBeInTheDocument();
    expect(within(header).getByText('(no source captured)')).toBeInTheDocument();
  });

  it('shows an alias in place of the mode label, and an archived chip', async () => {
    mockRows([entry({ alias: 'Pullbacks', archived: 1 })]);
    renderView();
    const header = await rowHeader(/^Pullbacks/);
    expect(within(header).getByText('Pullbacks')).toBeInTheDocument();
    expect(within(header).queryByText('Explain (learning)')).not.toBeInTheDocument();
    expect(within(header).getByText('archived')).toBeInTheDocument();
  });

  it.each([
    ['explain-learning', '🔎', 'Explain (learning)'],
    ['explain-native', '🌐', 'Explain (native)'],
    ['vocab-native', '📖', 'Vocabulary (native)'],
    ['translate-selection-learning', '🔤', 'Translate → learning'],
    ['translate-selection-native', '🔤', 'Translate → native'],
    ['translate-answer', '⤴', 'Translate answer'],
    ['translate-file', '📝', 'Translate file'],
    ['custom', '✦', 'Custom prompt'],
  ] as const)('keeps the %s glyph and label', async (mode, glyph, label) => {
    mockRows([entry({ mode })]);
    renderView();
    const header = await rowHeader(new RegExp(label.replace(/[()→]/g, '.')));
    expect(within(header).getByText(glyph)).toBeInTheDocument();
    expect(within(header).getByText(label)).toBeInTheDocument();
  });

  it('expands from the header button and collapses again', async () => {
    mockRows([entry({ response: 'Hello **world**' })]);
    renderView();
    const header = await rowHeader(/Explain \(learning\)/);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('textbox', { name: 'Alias' })).not.toBeInTheDocument();

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('textbox', { name: 'Alias' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeInTheDocument();
    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByText('Conversation')).toBeInTheDocument();

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('textbox', { name: 'Alias' })).not.toBeInTheDocument();
  });

  it('only one row is open at a time', async () => {
    mockRows([entry({ uuid: 'a', selection: 'first' }), entry({ uuid: 'b', selection: 'second' })]);
    renderView();
    const first = await rowHeader(/first/);
    const second = await rowHeader(/second/);
    fireEvent.click(first);
    fireEvent.click(second);
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(second).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('textbox', { name: 'Alias' })).toHaveLength(1);
  });

  it('shows the surrounding line only when it adds something', async () => {
    mockRows([entry({ selection: 'pullback', contextLine: '回撤 (pullback) is a dip' })]);
    renderView();
    fireEvent.click(await rowHeader(/Explain \(learning\)/));
    expect(screen.getByText('Surrounding line')).toBeInTheDocument();
    expect(screen.getByText(/回撤 \(pullback\) is a dip/)).toBeInTheDocument();
  });

  it('omits the surrounding line when it repeats the selection', async () => {
    mockRows([entry({ selection: 'pullback', contextLine: 'pullback' })]);
    renderView();
    fireEvent.click(await rowHeader(/Explain \(learning\)/));
    expect(screen.queryByText('Surrounding line')).not.toBeInTheDocument();
  });

  it('shows the file path above the source for a translate-file entry', async () => {
    mockRows([entry({ mode: 'translate-file', filePath: '/docs/a.md', fileContent: 'file body', selection: '' })]);
    renderView();
    fireEvent.click(await rowHeader(/Translate file/));
    expect(screen.getByText('/docs/a.md')).toBeInTheDocument();
    expect(screen.getAllByText('file body').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Row actions
// ---------------------------------------------------------------------------

describe('ReviewView — row actions', () => {
  it('the star is a toggle named "Favorite" and saves the favourite', async () => {
    mockRows([entry({ favorite: 0 })]);
    renderView();
    const star = await screen.findByRole('button', { name: 'Favorite' });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(star);
    await waitFor(() => expect(setFavorite).toHaveBeenCalledWith('uuid-1', true));
  });

  // One constant name: aria-pressed carries the state. A toggle whose name
  // flips ("Favorite" ↔ "Unfavorite") reads to a screen reader as two buttons.
  it('a favourited row keeps the name "Favorite", pressed', async () => {
    mockRows([entry({ favorite: 1 })]);
    renderView();
    const star = await screen.findByRole('button', { name: 'Favorite' });
    expect(star).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(star);
    await waitFor(() => expect(setFavorite).toHaveBeenCalledWith('uuid-1', false));
  });

  it('the star\'s tooltip says what favouriting does', async () => {
    mockRows([entry({ favorite: 0 })]);
    renderView();
    const off = await screen.findByRole('button', { name: 'Favorite' });
    act(() => off.focus());
    const tip = await screen.findByRole('tooltip', {}, { timeout: 3000 });
    expect(tip).toHaveTextContent('Highlights it in the source file.');
  });

  it('the star does not expand the row', async () => {
    mockRows([entry()]);
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Favorite' }));
    expect(await rowHeader(/Explain \(learning\)/)).toHaveAttribute('aria-expanded', 'false');
  });

  it('reloads the list after a mutation', async () => {
    mockRows([entry()]);
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Favorite' }));
    const callsBefore = vi.mocked(listLogs).mock.calls.length;
    await waitFor(() => expect(vi.mocked(listLogs).mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('archives an active entry and unarchives an archived one', async () => {
    mockRows([entry({ archived: 0 })]);
    const { unmount } = renderView();
    fireEvent.click(await rowHeader(/Explain \(learning\)/));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(setArchived).toHaveBeenCalledWith('uuid-1', true));
    unmount();

    mockRows([entry({ archived: 1 })]);
    renderView();
    fireEvent.click(await rowHeader(/Explain \(learning\)/));
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    await waitFor(() => expect(setArchived).toHaveBeenCalledWith('uuid-1', false));
  });

  it('deletes only after the confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockRows([entry()]);
    renderView();
    fireEvent.click(await rowHeader(/Explain \(learning\)/));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledWith('Delete this saved entry? This cannot be undone.');
    expect(deleteLog).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteLog).toHaveBeenCalledWith('uuid-1'));
    // The deleted row's detail closes with it.
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Alias' })).not.toBeInTheDocument());
  });

  it('hands focus to the next entry after a delete, or to the search box after the last', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const first = entry({ uuid: 'a', alias: 'first' });
    const second = entry({ uuid: 'b', alias: 'second' });
    mockRows([first, second]);
    vi.mocked(deleteLog).mockImplementation(async (uuid) => {
      mockRows([first, second].filter((e) => e.uuid !== uuid));
    });
    renderView();

    fireEvent.click(await rowHeader(/^first/));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^second/ })).toHaveFocus());
    await waitFor(() => expect(screen.queryByRole('button', { name: /^first/ })).not.toBeInTheDocument());

    vi.mocked(deleteLog).mockImplementation(async () => mockRows([]));
    fireEvent.click(screen.getByRole('button', { name: /^second/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search saved entries' })).toHaveFocus());
  });

  it('says so when a delete fails, and keeps the entry open', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(deleteLog).mockRejectedValue(new Error('the database is blocked'));
    mockRows([entry()]);
    renderView();
    fireEvent.click(await rowHeader(/Explain \(learning\)/));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Could not delete the entry: the database is blocked', 'error'),
    );
    expect(screen.getByRole('textbox', { name: 'Alias' })).toBeInTheDocument();
  });

  it('says so when notes fail to save on blur, instead of losing them silently', async () => {
    vi.mocked(setNotes).mockRejectedValue(new Error('QuotaExceededError'));
    mockRows([entry()]);
    renderView();
    fireEvent.click(await rowHeader(/Explain \(learning\)/));
    const notes = screen.getByRole('textbox', { name: 'Notes' });
    fireEvent.change(notes, { target: { value: 'remember this' } });
    fireEvent.blur(notes);
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Could not save your notes: QuotaExceededError', 'error'),
    );
  });

  it('describes each star by its row, so a list of stars is not N identical buttons', async () => {
    mockRows([entry({ uuid: 'a', alias: 'first' }), entry({ uuid: 'b', alias: 'second' })]);
    renderView();
    const stars = await screen.findAllByRole('button', { name: 'Favorite' });
    expect(stars[0]).toHaveAccessibleDescription(/^first/);
    expect(stars[1]).toHaveAccessibleDescription(/^second/);
  });

  it('saves a changed, trimmed alias on blur and ignores an unchanged one', async () => {
    mockRows([entry({ alias: 'old' })]);
    renderView();
    fireEvent.click(await rowHeader(/^old/));
    const alias = screen.getByRole('textbox', { name: 'Alias' });

    fireEvent.blur(alias);
    expect(setAlias).not.toHaveBeenCalled();

    fireEvent.change(alias, { target: { value: '  new label  ' } });
    fireEvent.blur(alias);
    await waitFor(() => expect(setAlias).toHaveBeenCalledWith('uuid-1', 'new label'));
  });

  it('saves changed notes on blur and ignores unchanged ones', async () => {
    mockRows([entry({ notes: 'kept' })]);
    renderView();
    fireEvent.click(await rowHeader(/Explain \(learning\)/));
    const notes = screen.getByRole('textbox', { name: 'Notes' });

    fireEvent.blur(notes);
    expect(setNotes).not.toHaveBeenCalled();

    fireEvent.change(notes, { target: { value: 'kept, plus more' } });
    fireEvent.blur(notes);
    await waitFor(() => expect(setNotes).toHaveBeenCalledWith('uuid-1', 'kept, plus more'));
  });
});

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

describe('ReviewView — dates', () => {
  it('drops the seconds and this year, and keeps the year for older entries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0));

    mockRows([
      entry({
        uuid: 'recent',
        selection: 'recent',
        createdAt: new Date(2026, 8, 20, 21, 8, 45).getTime(),
        updatedAt: new Date(2026, 8, 20, 21, 8, 45).getTime(),
      }),
      entry({
        uuid: 'old',
        selection: 'old',
        createdAt: new Date(2025, 2, 3, 8, 5, 30).getTime(),
        updatedAt: new Date(2025, 2, 3, 8, 5, 30).getTime(),
      }),
    ]);
    renderView();

    const recent = await rowHeader(/recent/);
    const old = await rowHeader(/old/);
    // Older than a week, so the age line falls back to the date: 24-hour, like
    // every other tab (historyFormat.formatDate).
    expect(recent.textContent).toMatch(/Sep 20, 21:08/);
    expect(recent.textContent).not.toMatch(/2026/);
    expect(recent.textContent).not.toMatch(/21:08:45/);
    expect(old.textContent).toMatch(/Mar 3, 2025, 08:05/);
    expect(old.textContent).not.toMatch(/08:05:30/);
  });

  it('shows Saved alone when it was never updated in a later minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0));
    const created = new Date(2026, 9, 7, 9, 8, 5).getTime();
    mockRows([entry({ createdAt: created, updatedAt: created + 20_000 })]);
    renderView();
    fireEvent.click(await rowHeader(/Explain \(learning\)/));
    const stamp = within(screen.getByRole('listitem')).getByText(/^Saved /);
    expect(stamp.textContent).toMatch(/^Saved Oct 7, 09:08$/);
  });

  it('adds Updated when the entry changed in a later minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0));
    const created = new Date(2026, 9, 7, 9, 8, 5).getTime();
    mockRows([entry({ createdAt: created, updatedAt: created + 10 * 60_000 })]);
    renderView();
    fireEvent.click(await rowHeader(/Explain \(learning\)/));
    const stamp = within(screen.getByRole('listitem')).getByText(/^Saved /);
    expect(stamp.textContent).toMatch(/^Saved Oct 7, 09:08 · Updated Oct 7, 09:18$/);
  });
});

// ---------------------------------------------------------------------------
// Deep link (?uuid=…) — the saved-selection <mark> in a markdown file lands here
// ---------------------------------------------------------------------------

describe('ReviewView — deep link', () => {
  const original = Element.prototype.scrollIntoView;
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it('opens the linked entry, widens the archive filter, scrolls to it and clears the param', async () => {
    mockRows([
      entry({ uuid: 'other', selection: 'other one' }),
      entry({ uuid: 'target', selection: 'linked one', archived: 1 }),
    ]);
    renderView('/review?uuid=target');

    const target = await rowHeader(/linked one/);
    expect(target).toHaveAttribute('aria-expanded', 'true');
    expect(await rowHeader(/other one/)).toHaveAttribute('aria-expanded', 'false');

    expect(listLogs).toHaveBeenCalledWith(expect.objectContaining({ archived: 'all' }));
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveValue('all');

    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/review$/));
  });

  it('keeps the default filters when there is no link', async () => {
    mockRows([entry()]);
    renderView();
    await rowHeader(/Explain \(learning\)/);
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveValue('active');
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});
