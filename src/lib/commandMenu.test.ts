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
