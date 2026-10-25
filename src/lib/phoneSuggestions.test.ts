/**
 * The phone's suggestion bar ranking (AASC-20, feature 70; M9): the Mac's
 * favourites rank first, across sources; with no notes (no cloud connection)
 * the ranking is the plain command one; the Mac's answer is read as notes and
 * nothing else; a pick replaces the typed fragment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandEntry } from './commandIndex';
import {
  chatSuggestionKinds,
  favoriteSuggestions,
  fetchPhoneSkillNotes,
  insertSigil,
  insertSuggestion,
  mergeNotes,
  notesFromFavorites,
  rankSuggestions,
  resetPhoneSkillNotesCache,
} from './phoneSuggestions';

const entry = (name: string, kind: 'command' | 'skill', source: CommandEntry['source'], cli: 'claude' | 'codex' = 'claude'): CommandEntry => ({
  name, kind, source, cli, description: '',
});

const ENTRIES: CommandEntry[] = [
  entry('resume', 'command', 'builtin'),
  entry('review', 'command', 'builtin'),
  entry('clear', 'command', 'builtin'),
  entry('retouch-current-prompt', 'skill', 'global'),
  entry('krt-work', 'skill', 'global'),
  entry('explore-solutions', 'skill', 'global'),
];

const NOTES = notesFromFavorites({
  source: 'cloud',
  entries: [
    { key: 'claude:retouch-current-prompt', fav: true, tags: ['daily'], abbr: 'rcp' },
    { key: 'claude:krt-work', fav: true, tags: [], abbr: 'kw' },
    { key: 'claude:explore-solutions', fav: false, tags: [], abbr: 'ex' },
  ],
});

afterEach(() => {
  resetPhoneSkillNotesCache();
  vi.unstubAllGlobals();
});

describe('notesFromFavorites', () => {
  it('reads key, fav, tags and abbr, and drops anything malformed', () => {
    const notes = notesFromFavorites({
      entries: [
        { key: 'claude:a', fav: true, tags: ['x'], abbr: 'aa', path: '/Users/me/.claude/skills/a', content: 'secret' },
        { key: 'not-a-key', fav: true, tags: [] },
        { key: 'codex:b', fav: 'yes' },
        { key: 'shared:c', fav: false, tags: ['ops'], abbr: 'NOT VALID' },
        null,
      ],
    });
    expect(notes).toEqual({ 'claude:a': { fav: true, tags: ['x'], abbr: 'aa' }, 'shared:c': { fav: false, tags: ['ops'] } });
    expect(notesFromFavorites({ source: 'none', entries: [] })).toEqual({});
    expect(notesFromFavorites('nope')).toEqual({});
  });

  it("lets the phone's own note win over the Mac's for one key", () => {
    expect(mergeNotes({ 'claude:a': { fav: true, tags: [] } }, { 'claude:a': { fav: false, tags: ['mine'] } }))
      .toEqual({ 'claude:a': { fav: false, tags: ['mine'] } });
  });
});

describe('rankSuggestions', () => {
  it('ranks a favourite skill ahead of built-in commands that also match', () => {
    const tokens = rankSuggestions(ENTRIES, 're', ['command', 'skill'], NOTES).map((s) => s.token);
    expect(tokens).toEqual(['/retouch-current-prompt', '/resume', '/review', '/explore-solutions']);
  });

  it('puts the exact abbreviation first, even over another favourite', () => {
    const ranked = rankSuggestions(ENTRIES, 'kw', ['command', 'skill'], NOTES);
    expect(ranked[0]).toEqual({ token: '/krt-work', kind: 'skill', fav: true, abbr: 'kw' });
  });

  it('falls back to the plain command ranking without notes: prefix matches, then A–Z', () => {
    const tokens = rankSuggestions(ENTRIES, 're', ['command', 'skill'], {}).map((s) => s.token);
    expect(tokens).toEqual(['/resume', '/retouch-current-prompt', '/review', '/explore-solutions']);
    expect(rankSuggestions(ENTRIES, 're', ['command', 'skill'], {}).every((s) => !s.fav)).toBe(true);
  });

  it('ranks by how often each is used where it used to go A–Z (Oct 21 2026)', () => {
    const used = (name: string, uses: number) => ({ ...ENTRIES.find((e) => e.name === name)!, uses });
    const withUses = [
      ...ENTRIES.filter((e) => !['review', 'clear', 'explore-solutions'].includes(e.name)),
      used('review', 40), used('clear', 3), used('explore-solutions', 90),
    ];
    // Nothing typed: no favourites, so most-used first, then A–Z among the unused.
    expect(rankSuggestions(withUses, '', ['command', 'skill'], {}).map((s) => s.token))
      .toEqual(['/explore-solutions', '/review', '/clear', '/krt-work', '/resume', '/retouch-current-prompt']);
    // Typed "re": the names starting with it still come first, most-used first among them.
    expect(rankSuggestions(withUses, 're', ['command', 'skill'], {}).map((s) => s.token))
      .toEqual(['/review', '/resume', '/retouch-current-prompt', '/explore-solutions']);
    // A favourite still outranks a more-used name.
    expect(rankSuggestions(withUses, 're', ['command', 'skill'], NOTES)[0].token).toBe('/retouch-current-prompt');
  });

  it('keeps the Codex sigil for Codex skills', () => {
    const codex = [entry('fix', 'skill', 'global', 'codex'), entry('init', 'command', 'builtin', 'codex')];
    expect(rankSuggestions(codex, '', ['skill'], {}).map((s) => s.token)).toEqual(['$fix']);
  });
});

describe('favoriteSuggestions', () => {
  it('offers the favourites, then the abbreviated, and nothing without notes', () => {
    expect(favoriteSuggestions(ENTRIES, ['command', 'skill'], NOTES).map((s) => s.token))
      .toEqual(['/krt-work', '/retouch-current-prompt', '/explore-solutions']);
    expect(favoriteSuggestions(ENTRIES, ['command', 'skill'], {})).toEqual([]);
  });
});

describe('insertSuggestion', () => {
  it('replaces the typed fragment and leaves the caret after one space', () => {
    expect(insertSuggestion('please /re now', 10, '/review', 7)).toEqual({ text: 'please /review now', caret: 15 });
  });

  it('inserts a favourite as its own word when nothing is being typed', () => {
    expect(insertSuggestion('run', 3, '/krt-work', null)).toEqual({ text: 'run /krt-work ', caret: 14 });
    expect(insertSuggestion('', 0, '/krt-work', null)).toEqual({ text: '/krt-work ', caret: 10 });
  });
});

describe('chatSuggestionKinds', () => {
  it('lists commands and skills under / on both CLIs, Codex skills under $, and nothing for @ or a Claude $', () => {
    expect(chatSuggestionKinds('command', 'claude')).toEqual(['command', 'skill']);
    expect(chatSuggestionKinds('command', 'codex')).toEqual(['command', 'skill']);
    expect(chatSuggestionKinds('skill', 'codex')).toEqual(['skill']);
    expect(chatSuggestionKinds('skill', 'claude')).toBeNull();
    expect(chatSuggestionKinds('file', 'claude')).toBeNull();
  });
});

describe('insertSigil', () => {
  it('starts a word with the bare sigil and leaves what follows the caret alone', () => {
    expect(insertSigil('foo bar', 3, '/')).toEqual({ text: 'foo / bar', caret: 5 });
    expect(insertSigil('foo ', 4, '/')).toEqual({ text: 'foo /', caret: 5 });
    expect(insertSigil('', 0, '$')).toEqual({ text: '$', caret: 1 });
  });
});

describe('fetchPhoneSkillNotes', () => {
  it('reads the Mac once a minute, and does not keep a failure', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ source: 'cloud', entries: [{ key: 'claude:a', fav: true, tags: [], abbr: null }] })));
    vi.stubGlobal('fetch', fetchMock);
    const t = Date.now();
    expect(await fetchPhoneSkillNotes(t)).toEqual({ 'claude:a': { fav: true, tags: [] } });
    await fetchPhoneSkillNotes(t + 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/skill-notes/favorites');

    resetPhoneSkillNotesCache();
    fetchMock.mockImplementationOnce(async () => new Response('{"error":"Not found"}', { status: 404 }));
    expect(await fetchPhoneSkillNotes()).toEqual({});
    expect(await fetchPhoneSkillNotes()).toEqual({ 'claude:a': { fav: true, tags: [] } });
  });
});
