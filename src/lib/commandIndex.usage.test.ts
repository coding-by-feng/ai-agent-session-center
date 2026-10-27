/**
 * How often each command or skill is used (Oct 21 2026): the Mac sends counts by
 * token beside the entries, and the client puts each on its entry by the one sigil
 * rule (`entryToken`) — a Codex skill is counted as `$name`, everything else `/name`.
 * Oct 24 2026: the lists rank by them (after favourites and prefix matches, before A–Z),
 * and `mostUsed` picks the top of the phone's `/` sheet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { entryToken, fetchCommandIndex, filterAndGroup, mostUsed, type CommandEntry } from './commandIndex';
import { withFav } from './skillNotes';

const entry = (name: string, over: Partial<CommandEntry> = {}): CommandEntry => ({
  name, description: '', cli: 'claude', kind: 'skill', source: 'global', ...over,
});

// Each test reads its own project path, so the 30 s cache never serves one test's list to another.
afterEach(() => {
  vi.unstubAllGlobals();
});

function serve(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
}

describe('fetchCommandIndex — usage counts', () => {
  it('puts each count on its entry by the token the user types', async () => {
    serve({
      entries: [entry('raab'), entry('compact', { kind: 'command', source: 'builtin' }), entry('commit', { source: 'plugin', pluginName: 'commit-commands' })],
      usage: { '/raab': 105, '/commit-commands:commit': 7, '/compact': 0 },
    });
    const got = await fetchCommandIndex('claude', '/p/usage-1');
    expect(got.map((e) => [e.name, e.uses])).toEqual([['raab', 105], ['compact', undefined], ['commit', 7]]);
  });

  it('counts a Codex skill by its $ token, a Codex command by its / token', async () => {
    serve({
      entries: [entry('krt-work', { cli: 'codex' }), entry('review', { cli: 'codex', kind: 'command', source: 'builtin' })],
      usage: { '$krt-work': 12, '/krt-work': 99, '/review': 4 },
    });
    const got = await fetchCommandIndex('codex', '/p/usage-2');
    expect(got.map((e) => [e.name, e.uses])).toEqual([['krt-work', 12], ['review', 4]]);
  });

  it('is the plain list when the Mac sends no counts (an older Mac)', async () => {
    serve({ entries: [entry('raab')] });
    const got = await fetchCommandIndex('claude', '/p/usage-3');
    expect(got).toEqual([entry('raab')]);
  });
});

const names = (groups: ReturnType<typeof filterAndGroup>) => groups.flatMap((g) => g.entries.map((e) => e.name));

describe('filterAndGroup — most used first (Oct 24 2026)', () => {
  const skills = [entry('alpha'), entry('beta', { uses: 3 }), entry('gamma', { uses: 40 }), entry('delta')];

  it('orders each group by uses, then A–Z', () => {
    expect(names(filterAndGroup(skills, '', 'skill'))).toEqual(['gamma', 'beta', 'alpha', 'delta']);
  });

  it('keeps a name that starts with the query ahead of a more used one that only contains it', () => {
    const list = [entry('update-docs', { uses: 2 }), entry('auto-update', { uses: 90 })];
    expect(names(filterAndGroup(list, 'up', 'skill'))).toEqual(['update-docs', 'auto-update']);
  });

  it('keeps a favourite ahead of a more used skill', () => {
    const notes = withFav({}, 'claude:alpha', true);
    expect(names(filterAndGroup(skills, '', 'skill', notes))[0]).toBe('alpha');
  });
});

describe('filterAndGroup — groups follow their best match (Oct 26 2026)', () => {
  const titles = (groups: ReturnType<typeof filterAndGroup>) => groups.map((g) => g.title);
  // The user's screenshot: "/rar" put a built-in that only contains "rar" above their daily /rar.
  const list = [
    entry('ultrareview', { kind: 'skill', source: 'builtin' }),
    entry('rar', { uses: 104 }),
    entry('generate-library', { source: 'plugin', pluginName: 'figma' }),
  ];

  it('puts the group of the best-ranked match first, not the built-ins', () => {
    expect(titles(filterAndGroup(list, 'rar', 'skill'))).toEqual(['Global', 'Built-in', 'Plugin: figma']);
  });

  it('ranks a used plugin skill above an unused built-in', () => {
    const used = list.map((e) => (e.name === 'generate-library' ? { ...e, uses: 5 } : e));
    expect(titles(filterAndGroup(used, 'rar', 'skill'))).toEqual(['Global', 'Plugin: figma', 'Built-in']);
  });

  it('keeps the source order between groups that rank the same', () => {
    const plain = [entry('zeta', { source: 'plugin', pluginName: 'p' }), entry('alpha'), entry('mid', { source: 'builtin' })];
    expect(titles(filterAndGroup(plain, '', 'skill'))).toEqual(['Built-in', 'Global', 'Plugin: p']);
  });
});

describe('mostUsed', () => {
  const list = [
    entry('raab', { uses: 105 }),
    entry('clear', { kind: 'command', source: 'builtin', uses: 31 }),
    entry('rar', { uses: 48 }),
    entry('never'),
    entry('tie-b', { uses: 5 }),
    entry('tie-a', { uses: 5 }),
  ];
  const tokens = (got: CommandEntry[]) => got.map(entryToken);

  it('lists commands and skills together, most used first, ties A–Z, nothing unused', () => {
    expect(tokens(mostUsed(list, ['command', 'skill']))).toEqual(['/raab', '/rar', '/clear', '/tie-a', '/tie-b']);
  });

  it('keeps to the kinds asked for and the limit', () => {
    expect(tokens(mostUsed(list, ['skill'], 2))).toEqual(['/raab', '/rar']);
  });

  it('lists a token once when a skill and a command share it', () => {
    const shared = [entry('extract-features', { uses: 9 }), entry('extract-features', { kind: 'command', uses: 9 })];
    expect(tokens(mostUsed(shared, ['command', 'skill']))).toEqual(['/extract-features']);
  });

  it('is empty when the Mac sent no counts', () => {
    expect(mostUsed([entry('raab'), entry('rar')], ['skill'])).toEqual([]);
  });
});
