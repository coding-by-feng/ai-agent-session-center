import { describe, it, expect } from 'vitest';
import { buildCommandMenu, menuKinds, terminalMenuKinds } from './commandMenu';
import type { CommandEntry } from '@/lib/commandIndex';

const codex: CommandEntry[] = [
  { name: 'review', description: 'Codex built-in', cli: 'codex', kind: 'command', source: 'builtin' },
  { name: 'imagegen', description: 'Codex skill', cli: 'codex', kind: 'skill', source: 'global' },
] as CommandEntry[];

describe('command menu kinds', () => {
  it('the queue editor’s `/` on Codex lists commands only (a `/skill` there does nothing)', () => {
    expect(menuKinds('command', 'codex')).toEqual(['command']);
    const { items } = buildCommandMenu(codex, '', 'command', 'codex', {});
    expect(items.map((i) => i.insert)).toEqual(['/review']);
  });

  it('the terminal’s `/` lists commands, then skills under their own sigil', () => {
    const { items } = buildCommandMenu(codex, '', 'command', 'codex', {}, terminalMenuKinds());
    expect(items.map((i) => i.insert)).toEqual(['/review', '$imagegen']);
  });
});

describe('command menu ranking (Oct 26 2026)', () => {
  const g = (name: string, kind: 'command' | 'skill', uses?: number): CommandEntry =>
    ({ name, description: '', cli: 'claude', kind, source: 'global', ...(uses ? { uses } : {}) }) as CommandEntry;

  it('ranks a Claude `/` group as one list: a used skill is not stuck below unused commands', () => {
    const entries = [g('clear', 'command'), g('compact', 'command', 3), g('raab', 'skill', 90), g('review-pr', 'skill', 12)];
    const { items, groupSpans } = buildCommandMenu(entries, '', 'command', 'claude', {});
    expect(items.map((i) => i.insert)).toEqual(['/raab', '/review-pr', '/compact', '/clear']);
    expect(groupSpans).toEqual([{ title: 'Global', startIdx: 0, count: 4 }]);
  });

  it('orders the merged groups by their best row', () => {
    const entries = [
      { name: 'ultrareview', description: '', cli: 'claude', kind: 'command', source: 'builtin' },
      g('rar', 'command', 104),
    ] as CommandEntry[];
    const { groupSpans } = buildCommandMenu(entries, 'rar', 'command', 'claude', {});
    expect(groupSpans.map((s) => s.title)).toEqual(['Global', 'Built-in']);
  });

  it('carries each row’s count, and none for an unused row', () => {
    const { items } = buildCommandMenu([g('raab', 'skill', 90), g('plan', 'skill')], '', 'command', 'claude', {});
    expect(items.map((i) => [i.insert, i.uses])).toEqual([['/raab', 90], ['/plan', undefined]]);
  });
});
