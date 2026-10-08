import { describe, it, expect } from 'vitest';
import { filterAndGroup, type CommandEntry } from './commandIndex';
import { withAbbr, withFav, type SkillNotes } from './skillNotes';

const skill = (name: string, over: Partial<CommandEntry> = {}): CommandEntry => ({
  name, description: '', cli: 'claude', kind: 'skill', source: 'global', ...over,
});
const names = (groups: ReturnType<typeof filterAndGroup>) => groups.flatMap((g) => g.entries.map((e) => e.name));

describe('filterAndGroup with skill notes', () => {
  const entries = [skill('retouch-ascii-review'), skill('brainstorming'), skill('random-skill'), skill('plan')];

  it('is unchanged without notes', () => {
    expect(names(filterAndGroup(entries, 're', 'skill'))).toEqual(['retouch-ascii-review']);
    expect(names(filterAndGroup(entries, '', 'skill'))).toEqual(['brainstorming', 'plan', 'random-skill', 'retouch-ascii-review']);
  });

  it('finds a skill by its abbreviation and ranks it first', () => {
    const notes: SkillNotes = withAbbr({}, 'claude:retouch-ascii-review', 'rar');
    // a partial abbreviation counts as a prefix hit (same tier as a name prefix); a plain substring comes after
    expect(names(filterAndGroup(entries, 'ra', 'skill', notes))).toEqual(['random-skill', 'retouch-ascii-review', 'brainstorming']);
    expect(names(filterAndGroup(entries, 'rar', 'skill', notes))).toEqual(['retouch-ascii-review']);
  });

  it('floats favourites first within their group, then alphabetical', () => {
    const notes = withFav({}, 'claude:random-skill', true);
    expect(names(filterAndGroup(entries, '', 'skill', notes))).toEqual(['random-skill', 'brainstorming', 'plan', 'retouch-ascii-review']);
  });

  it('keeps an exact abbreviation ahead of a favourite', () => {
    let notes = withFav({}, 'claude:random-skill', true);
    notes = withAbbr(notes, 'claude:plan', 'ra');
    expect(names(filterAndGroup(entries, 'ra', 'skill', notes))[0]).toBe('plan');
  });

  it('ignores another agent\'s notes but honours shared ones', () => {
    let notes = withAbbr({}, 'codex:plan', 'pp');
    expect(names(filterAndGroup(entries, 'pp', 'skill', notes))).toEqual([]);
    notes = withAbbr({}, 'shared:plan', 'pp');
    expect(names(filterAndGroup(entries, 'pp', 'skill', notes))).toEqual(['plan']);
  });

  it('keys a Codex entry under codex', () => {
    const codex = [skill('plan', { cli: 'codex' })];
    expect(names(filterAndGroup(codex, 'pp', 'skill', withAbbr({}, 'codex:plan', 'pp')))).toEqual(['plan']);
  });
});
