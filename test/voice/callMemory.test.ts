import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createCallMemory, memoryBlock, visibleTo, type MemoryItem } from '../../server/voice/callMemory.js';

function setup() {
  let t = 1_000;
  let n = 0;
  const memory = createCallMemory({ db: () => new DatabaseSync(':memory:'), now: () => (t += 1), newId: () => `m${(n += 1)}` });
  return { memory };
}

const pref = { kind: 'preference' as const, meant: 'Open new web work in agent-manager worktrees', heard: 'open new web work in agent manager work trees', scope: 'project:/repo/agent-manager' };
const fix = { kind: 'correction' as const, meant: 'central session', heard: 'central section', scope: 'global' };

describe('createCallMemory (Nov 22 2026)', () => {
  it('stores what a call proposes, and uses none of it until the person keeps it', () => {
    const { memory } = setup();
    const added = memory.propose([pref, fix], 'call-1');
    expect(added.map((i) => i.status)).toEqual(['proposed', 'proposed']);
    expect(memory.kept()).toEqual([]);
    const kept = memory.decide('m2', { action: 'keep' });
    expect(kept?.status).toBe('kept');
    expect(memory.kept().map((i) => i.meant)).toEqual(['central session']);
  });

  it('asks once: the same thing proposed again is not a second card, and a skip is remembered', () => {
    const { memory } = setup();
    memory.propose([fix], 'call-1');
    expect(memory.propose([{ ...fix, meant: 'Central Session' }], 'call-2')).toEqual([]);
    memory.decide('m1', { action: 'skip' });
    expect(memory.propose([fix], 'call-3')).toEqual([]);
    expect(memory.list().map((i) => i.status)).toEqual(['skipped']);
  });

  it('proposes a usage pattern only once it was heard in two separate calls', () => {
    const { memory } = setup();
    const pattern = { kind: 'pattern' as const, meant: 'Asks for a status round-up of all sessions at the start of a call', heard: 'what is everyone doing', scope: 'global' };
    expect(memory.propose([pattern], 'call-1')).toEqual([]);
    expect(memory.propose([pattern], 'call-1')).toEqual([]); // the same call twice still counts once
    const [item] = memory.propose([pattern], 'call-2');
    expect(item).toMatchObject({ status: 'proposed', seenCount: 2 });
  });

  it('keeps with the scope the person picks and their edited wording; a newer kept item replaces the old one', () => {
    const { memory } = setup();
    memory.propose([pref], 'call-1');
    const kept = memory.decide('m1', { action: 'keep', scope: 'global', meant: 'Open new web work in a worktree' });
    expect(kept).toMatchObject({ scope: 'global', meant: 'Open new web work in a worktree', heard: pref.heard });
    memory.propose([{ ...pref, meant: 'Open new web work on the main branch', heard: 'no, keep web work on main' }], 'call-2');
    // A different wording of the same subject is its own proposal…
    const second = memory.list().find((i) => i.status === 'proposed') as MemoryItem;
    const replaced = memory.decide(second.id, { action: 'keep', supersedes: 'm1' });
    expect(replaced?.supersedes).toBe('m1');
    // …and keeping it with `supersedes` retires the old one.
    expect(memory.list().find((i) => i.id === 'm1')?.status).toBe('retired');
  });

  it('retires a kept item and refuses unknown ids or a bad scope', () => {
    const { memory } = setup();
    memory.propose([fix], 'call-1');
    memory.decide('m1', { action: 'keep' });
    expect(memory.decide('m1', { action: 'retire' })?.status).toBe('retired');
    expect(memory.decide('nope', { action: 'keep' })).toBeNull();
    expect(() => memory.decide('m1', { action: 'keep', scope: 'project:relative' })).toThrow(/scope/);
  });

  it('blanks token shapes before anything is stored', () => {
    const { memory } = setup();
    const [item] = memory.propose([{ ...fix, meant: 'use key sk-abcdefghijklmnopqrstuvwxyz0123', heard: 'x' }], 'call-1');
    expect(item.meant).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
  });

  it('survives a restart (the table lives in the database)', () => {
    const db = new DatabaseSync(':memory:');
    const a = createCallMemory({ db: () => db, newId: () => 'x1' });
    a.propose([fix], 'call-1');
    a.decide('x1', { action: 'keep' });
    const b = createCallMemory({ db: () => db });
    expect(b.kept().map((i) => i.id)).toEqual(['x1']);
  });
});

describe('visibleTo', () => {
  const item = (scope: string) => ({ scope }) as MemoryItem;
  it('lets this Mac see everything, and a remote device global items and its visible projects only', () => {
    expect(visibleTo(item('project:/secret'), { isLocal: true, projects: [] })).toBe(true);
    expect(visibleTo(item('global'), { isLocal: false, projects: [] })).toBe(true);
    expect(visibleTo(item('project:/shared'), { isLocal: false, projects: ['/shared'] })).toBe(true);
    expect(visibleTo(item('project:/secret'), { isLocal: false, projects: ['/shared'] })).toBe(false);
  });
});

describe('memoryBlock (what the Voice central is told)', () => {
  const kept = (over: Partial<MemoryItem>): MemoryItem => ({
    id: 'k', kind: 'preference', meant: '', heard: '', scope: 'global', status: 'kept', callId: 'c', createdAt: 0,
    updatedAt: 0, lastUsedAt: null, supersedes: null, key: 'k', seenCount: 1, ...over,
  });

  it('puts corrections first, then the preferences that fit this request and project, fenced as the person’s own', () => {
    const items = [
      kept({ id: 'a', kind: 'correction', heard: 'central section', meant: 'central session' }),
      kept({ id: 'b', meant: 'Open new web work in agent-manager worktrees', scope: 'project:/repo/am' }),
      kept({ id: 'c', meant: 'Write commit messages in English', scope: 'project:/repo/other' }),
      kept({ id: 'd', meant: 'Prefers short spoken answers' }),
    ];
    const { text, used } = memoryBlock(items, 'open a new session for the web site', ['/repo/am']);
    expect(text).toMatch(/^Kept for this person/);
    expect(text.indexOf('"central section" means central session')).toBeLessThan(text.indexOf('worktrees'));
    expect(text).toContain('Prefers short spoken answers');
    expect(text).not.toContain('commit messages'); // another project's
    expect(used.sort()).toEqual(['a', 'b', 'd']);
  });

  it('is empty when nothing is kept', () => {
    expect(memoryBlock([], 'anything', [])).toEqual({ text: '', used: [] });
  });
});
