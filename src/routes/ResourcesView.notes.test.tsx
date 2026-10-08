// ResourcesView.notes.test.tsx — favourites, tags and abbreviations in the Library:
// the filter bar, search, the detail card, and "select visible" for a transfer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { stubApi, renderView, urlParams, ready, rail, railButton, listRows, row, detail, LAZY } from '@/__tests__/fixtures/resourceCatalog';
import { useSkillNotesStore } from '@/stores/skillNotesStore';

const names = () => listRows().map((b) => b.textContent ?? '');

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
  useSkillNotesStore.setState({
    notes: {
      'claude:tdd': { fav: true, tags: ['review', 'workflow'], abbr: 'td' },
      'codex:tdd': { fav: false, tags: ['ops'] },
      'claude:research': { fav: true, tags: [] },
      'claude:old-skill': { fav: false, tags: ['workflow'] },
    },
  });
  stubApi();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  useSkillNotesStore.setState({ notes: {} });
});

describe('ResourcesView — favourites and tags', () => {
  it('filters to favourites, keeps it in the URL, and the rail counts follow', async () => {
    renderView();
    await ready();
    const fav = screen.getByRole('button', { name: /Favourites/ });
    expect(fav).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(fav);
    expect(fav).toHaveAttribute('aria-pressed', 'true');
    expect(urlParams().get('fav')).toBe('1');
    expect(names().map((n) => n.split(' ')[0]).sort()).toEqual(['research', 'tdd']);
    expect(railButton('Skills')).toHaveTextContent(/2$/);
    expect(railButton('Rules')).toHaveTextContent(/0$/);
  });

  it('offers every tag in use and filters by several at once (any of them)', async () => {
    renderView();
    await ready();
    const bar = screen.getByRole('group', { name: 'Filter by tag' });
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(
      expect.arrayContaining(['workflow 2', 'review 1', 'ops 1']),
    );
    fireEvent.click(within(bar).getByRole('button', { name: /^ops/ }));
    expect(names().map((n) => n.split(' ')[0])).toEqual(['tdd']);
    fireEvent.click(within(bar).getByRole('button', { name: /^review/ }));
    expect(urlParams().get('tags')).toBe('ops,review');
    expect(names()).toHaveLength(2);
    fireEvent.click(within(bar).getByRole('button', { name: /^ops/ }));
    expect(urlParams().get('tags')).toBe('review');
    expect(names()).toHaveLength(1);
  });

  it('reads fav and tags from the link', async () => {
    renderView('/resources?fav=1&tags=workflow');
    await ready();
    expect(screen.getByRole('button', { name: /Favourites/ })).toHaveAttribute('aria-pressed', 'true');
    expect(names().map((n) => n.split(' ')[0])).toEqual(['tdd']);
  });

  it('searching finds a skill by its tag or abbreviation', async () => {
    renderView();
    await ready();
    fireEvent.change(screen.getByLabelText('Search resources'), { target: { value: 'workflow' } });
    expect(names().map((n) => n.split(' ')[0]).sort()).toEqual(['old-skill', 'tdd']);
    fireEvent.change(screen.getByLabelText('Search resources'), { target: { value: 'td' } });
    expect(names().some((n) => n.startsWith('tdd Claude'))).toBe(true);
  });

  it('says why the list is empty under a note filter', async () => {
    renderView('/resources?tags=nonexistent&type=skill');
    await ready();
    expect(screen.getByText(/tagged nonexistent/)).toBeInTheDocument();
  });

  it('shows the notes card in a skill\'s detail and nowhere else', async () => {
    renderView();
    await ready();
    fireEvent.click(row(/^tdd Claude/));
    const pane = await within(detail()).findByRole('region', { name: /My notes/ }, LAZY);
    expect(within(pane).getByRole('button', { name: 'Favourite tdd' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(pane).getByText('review')).toBeInTheDocument();
    expect((within(pane).getByLabelText('Abbreviation') as HTMLInputElement).value).toBe('td');
    fireEvent.click(railButton('Rules'));
    fireEvent.click(row(/^coding-style\.md/));
    expect(within(detail()).queryByRole('region', { name: /My notes/ })).toBeNull();
  });

  it('"Select visible" under a favourites filter selects only those, for a transfer', async () => {
    renderView();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /Favourites/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Select for transfer' }));
    expect(screen.getByRole('button', { name: 'Select visible (2)' })).toBeInTheDocument();
  });
});
void rail;
