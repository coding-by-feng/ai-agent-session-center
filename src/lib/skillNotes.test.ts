import { describe, it, expect } from 'vitest';
import {
  noteKey,
  normalizeTag,
  validateAbbr,
  lookupNote,
  withFav,
  withTag,
  withoutTag,
  withAbbr,
  parseStored,
  matchesNote,
  tagsInUse,
  isNotable,
  resourceNoteName,
  resourceNoteKey,
  noteForResource,
  passesNoteFilter,
  readNoteParams,
  withCli,
  MAX_TAGS,
  MAX_TAG_CHARS,
  type SkillNotes,
} from './skillNotes';

const base: SkillNotes = {};

describe('noteKey', () => {
  it('keys by agent and name, not by type or path', () => {
    expect(noteKey('claude', 'retouch-ascii-review')).toBe('claude:retouch-ascii-review');
    expect(noteKey('shared', 'x')).toBe('shared:x');
  });
});

describe('normalizeTag', () => {
  it('trims, lowercases and joins words with hyphens', () => {
    expect(normalizeTag('  My Review Flow ')).toBe('my-review-flow');
  });
  it('keeps letters and digits from any script', () => {
    expect(normalizeTag('评审流程')).toBe('评审流程');
  });
  it('replaces other characters and control characters', () => {
    expect(normalizeTag('a/b\tc\u0000d<script>')).toBe('a-b-c-d-script');
  });
  it('rejects an empty or symbol-only tag', () => {
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('!!!')).toBeNull();
  });
  it('caps the length', () => {
    expect(normalizeTag('x'.repeat(200))!.length).toBe(MAX_TAG_CHARS);
  });
});

describe('immutable updates', () => {
  it('toggles favourite without touching the input and drops an empty note', () => {
    const a = withFav(base, 'claude:x', true);
    expect(a['claude:x']).toEqual({ fav: true, tags: [] });
    expect(base).toEqual({});
    expect(withFav(a, 'claude:x', false)).toEqual({});
  });

  it('adds several tags, ignoring duplicates after normalising', () => {
    let n = withTag(base, 'claude:x', 'Review');
    n = withTag(n, 'claude:x', 'review ');
    n = withTag(n, 'claude:x', 'workflow');
    expect(n['claude:x'].tags).toEqual(['review', 'workflow']);
  });

  it('refuses a tag past the count cap', () => {
    let n: SkillNotes = base;
    for (let i = 0; i < MAX_TAGS + 3; i++) n = withTag(n, 'claude:x', `t${i}`);
    expect(n['claude:x'].tags).toHaveLength(MAX_TAGS);
  });

  it('removes a tag and drops the note once it is empty', () => {
    let n = withTag(base, 'claude:x', 'a');
    n = withTag(n, 'claude:x', 'b');
    n = withoutTag(n, 'claude:x', 'a');
    expect(n['claude:x'].tags).toEqual(['b']);
    expect(withoutTag(n, 'claude:x', 'b')).toEqual({});
  });

  it('sets and clears an abbreviation', () => {
    const n = withAbbr(base, 'claude:retouch', 'rar');
    expect(n['claude:retouch'].abbr).toBe('rar');
    expect(withAbbr(n, 'claude:retouch', null)).toEqual({});
  });
});

describe('validateAbbr', () => {
  const real = new Set(['claude:retouch-ascii-review', 'claude:plan']);
  const notes = withAbbr(base, 'claude:retouch-ascii-review', 'rar');

  it('accepts a short lowercase name', () => {
    expect(validateAbbr('rnr', 'claude:other', notes, real)).toEqual({ ok: true, value: 'rnr' });
  });
  it('normalises case and whitespace', () => {
    expect(validateAbbr('  RNR ', 'claude:other', notes, real)).toEqual({ ok: true, value: 'rnr' });
  });
  it.each(['', 'a', 'x'.repeat(13), 'has space', 'a/b', '-lead', 'ünï'])('rejects a badly formed %j', (v) => {
    expect(validateAbbr(v, 'claude:other', notes, real).ok).toBe(false);
  });
  it('rejects one already used by another skill of the same agent', () => {
    const r = validateAbbr('rar', 'claude:other', notes, real);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.error).toContain('retouch-ascii-review');
  });
  it('allows the same skill to keep its own abbreviation', () => {
    expect(validateAbbr('rar', 'claude:retouch-ascii-review', notes, real).ok).toBe(true);
  });
  it('allows the same abbreviation under a different agent', () => {
    expect(validateAbbr('rar', 'codex:other', notes, new Set()).ok).toBe(true);
  });
  it('rejects the name of a real skill or command (it would shadow it)', () => {
    expect(validateAbbr('plan', 'claude:other', notes, real).ok).toBe(false);
  });
  it('rejects it when it clashes across a shared skill for the same agent', () => {
    const shared = withAbbr(base, 'shared:review', 'rv');
    expect(validateAbbr('rv', 'claude:other', shared, new Set()).ok).toBe(false);
  });
});

describe('lookupNote', () => {
  it('reads the agent note and merges the shared one', () => {
    let n = withFav(base, 'claude:x', true);
    n = withTag(n, 'claude:x', 'a');
    n = withTag(n, 'shared:x', 'b');
    n = withAbbr(n, 'shared:x', 'xx');
    expect(lookupNote(n, 'claude', 'x')).toEqual({ fav: true, tags: ['a', 'b'], abbr: 'xx' });
  });
  it('prefers the agent abbreviation over the shared one', () => {
    let n = withAbbr(base, 'claude:x', 'cx');
    n = withAbbr(n, 'shared:x', 'sx');
    expect(lookupNote(n, 'claude', 'x')?.abbr).toBe('cx');
  });
  it('is null when nothing is recorded', () => {
    expect(lookupNote(base, 'claude', 'x')).toBeNull();
  });
});

describe('matchesNote', () => {
  const note = { fav: true, tags: ['review', 'workflow'], abbr: 'rar' };
  it('matches a tag or the abbreviation by substring, case-insensitively', () => {
    expect(matchesNote(note, 'REV')).toBe(true);
    expect(matchesNote(note, 'ra')).toBe(true);
    expect(matchesNote(note, 'zzz')).toBe(false);
    expect(matchesNote(null, 'a')).toBe(false);
  });
});

describe('tagsInUse', () => {
  it('counts every tag across notes, most used first', () => {
    let n = withTag(base, 'claude:a', 'x');
    n = withTag(n, 'claude:b', 'x');
    n = withTag(n, 'claude:b', 'y');
    expect(tagsInUse(n)).toEqual([{ tag: 'x', count: 2 }, { tag: 'y', count: 1 }]);
  });
});

describe('parseStored', () => {
  it('reads a valid payload', () => {
    const raw = JSON.stringify({ v: 1, notes: { 'claude:x': { fav: true, tags: ['a'], abbr: 'xx' } } });
    expect(parseStored(raw)).toEqual({ 'claude:x': { fav: true, tags: ['a'], abbr: 'xx' } });
  });
  it.each([null, '', 'not json', '[]', '{"v":2,"notes":{}}', '{"v":1}'])('returns empty for %j', (raw) => {
    expect(parseStored(raw as string | null)).toEqual({});
  });
  it('drops malformed entries and cleans the rest (storage is untrusted)', () => {
    const raw = JSON.stringify({
      v: 1,
      notes: {
        'claude:ok': { fav: false, tags: ['A B', 'a b', 5, '<x>'], abbr: 'Bad Abbr!' },
        'claude:bad1': 'string',
        'claude:bad2': { fav: 'yes' },
        'nowhere:x': { fav: true, tags: [] },
        'claude:empty': { fav: false, tags: [] },
      },
    });
    const out = parseStored(raw);
    expect(out['claude:ok']).toEqual({ fav: false, tags: ['a-b', 'x'] });
    expect(Object.keys(out)).toEqual(['claude:ok']);
  });
});

describe('resources', () => {
  const skill = { agent: 'claude' as const, type: 'skill', name: 'retouch', origin: 'user' };
  const plugin = { agent: 'claude' as const, type: 'skill', name: 'brainstorming', origin: 'plugin', pluginName: 'superpowers' };

  it('only skills and commands carry notes', () => {
    expect(isNotable(skill)).toBe(true);
    expect(isNotable({ ...skill, type: 'command' })).toBe(true);
    expect(isNotable({ ...skill, type: 'rule' })).toBe(false);
    expect(isNotable({ ...skill, type: 'memory' })).toBe(false);
  });

  it('names a plugin skill the way the prompt autocomplete does', () => {
    expect(resourceNoteName(skill)).toBe('retouch');
    expect(resourceNoteName(plugin)).toBe('superpowers:brainstorming');
    expect(resourceNoteKey(plugin)).toBe('claude:superpowers:brainstorming');
    expect(resourceNoteKey({ ...skill, agent: 'shared' })).toBe('shared:retouch');
  });

  it('reads a shared skill\'s own note only, and an agent skill\'s merged with the shared one', () => {
    let n = withFav(base, 'shared:retouch', true);
    n = withTag(n, 'claude:retouch', 'a');
    expect(noteForResource(n, { ...skill, agent: 'shared' })).toEqual({ fav: true, tags: [] });
    expect(noteForResource(n, skill)).toEqual({ fav: true, tags: ['a'] });
    expect(noteForResource(n, { ...skill, type: 'rule' })).toBeNull();
  });
});

describe('passesNoteFilter', () => {
  const note = { fav: true, tags: ['review', 'workflow'] };
  it('passes everything when no filter is active', () => {
    expect(passesNoteFilter(null, {})).toBe(true);
    expect(passesNoteFilter(null, { favOnly: false, tags: [] })).toBe(true);
  });
  it('favourites only', () => {
    expect(passesNoteFilter(note, { favOnly: true })).toBe(true);
    expect(passesNoteFilter({ fav: false, tags: ['a'] }, { favOnly: true })).toBe(false);
    expect(passesNoteFilter(null, { favOnly: true })).toBe(false);
  });
  it('several tags match when ANY of them is present', () => {
    expect(passesNoteFilter(note, { tags: ['review'] })).toBe(true);
    expect(passesNoteFilter(note, { tags: ['nope', 'workflow'] })).toBe(true);
    expect(passesNoteFilter(note, { tags: ['nope'] })).toBe(false);
    expect(passesNoteFilter(null, { tags: ['review'] })).toBe(false);
  });
  it('favourites AND a tag must both hold', () => {
    expect(passesNoteFilter({ fav: false, tags: ['review'] }, { favOnly: true, tags: ['review'] })).toBe(false);
    expect(passesNoteFilter(note, { favOnly: true, tags: ['review'] })).toBe(true);
  });
});

describe('readNoteParams', () => {
  it('reads fav and a comma-separated tag list, cleaned and capped', () => {
    const p = readNoteParams(new URLSearchParams('fav=1&tags=Review,,work flow,review'));
    expect(p).toEqual({ favOnly: true, tags: ['review', 'work-flow'] });
  });
  it('defaults to no filter and ignores other values', () => {
    expect(readNoteParams(new URLSearchParams(''))).toEqual({ favOnly: false, tags: [] });
    expect(readNoteParams(new URLSearchParams('fav=yes'))).toEqual({ favOnly: false, tags: [] });
  });
});

describe('cli flag (the abbreviation also exists as a real command)', () => {
  it('can be set only on a note that has an abbreviation', () => {
    expect(withCli(base, 'claude:x', true)).toEqual({});
    const n = withCli(withAbbr(base, 'claude:x', 'xx'), 'claude:x', true);
    expect(n['claude:x']).toEqual({ fav: false, tags: [], abbr: 'xx', cli: true });
    expect(withCli(n, 'claude:x', false)['claude:x']).toEqual({ fav: false, tags: [], abbr: 'xx' });
  });
  it('goes away with the abbreviation', () => {
    const n = withCli(withAbbr(base, 'claude:x', 'xx'), 'claude:x', true);
    expect(withAbbr(n, 'claude:x', null)).toEqual({});
  });
  it('survives a change of abbreviation (the caller re-creates the files)', () => {
    const n = withCli(withAbbr(base, 'claude:x', 'xx'), 'claude:x', true);
    expect(withAbbr(n, 'claude:x', 'yy')['claude:x'].cli).toBe(true);
  });
  it('is read back from storage, but not without an abbreviation', () => {
    const raw = JSON.stringify({ v: 1, notes: {
      'claude:a': { fav: false, tags: [], abbr: 'aa', cli: true },
      'claude:b': { fav: true, tags: [], cli: true },
      'claude:c': { fav: false, tags: [], abbr: 'cc', cli: 'yes' },
    } });
    const out = parseStored(raw);
    expect(out['claude:a'].cli).toBe(true);
    expect(out['claude:b']).toEqual({ fav: true, tags: [] });
    expect(out['claude:c'].cli).toBeUndefined();
  });
});
