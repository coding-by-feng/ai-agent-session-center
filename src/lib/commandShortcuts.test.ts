// commandShortcuts.test.ts — the one rule that links a shortcut command to
// the skill or command it expands to, shared by the prompt autocomplete and
// the RESOURCES tab. A shortcut is a command whose description starts
// "Shortcut for /<target>" (e.g. ~/.claude/commands/raab.md →
// /retouch-ascii-auto-build).
import { describe, it, expect } from 'vitest';
import type { ResourceSummary } from '@/types/resources';
import {
  shortcutTarget,
  stripShortcutPrefix,
  buildShortcutIndex,
  buildResourceShortcuts,
} from './commandShortcuts';

describe('shortcutTarget', () => {
  it('reads the target from a "Shortcut for /x" description', () => {
    expect(shortcutTarget('Shortcut for /retouch-ascii-auto-build — retouch, ASCII sketch, build without waiting'))
      .toBe('retouch-ascii-auto-build');
  });

  it('accepts the Codex $ sigil, any case and leading space', () => {
    expect(shortcutTarget('  shortcut FOR $retouch-ascii-review - x')).toBe('retouch-ascii-review');
  });

  it('keeps namespaced and plugin targets whole', () => {
    expect(shortcutTarget('Shortcut for /superpowers:brainstorming')).toBe('superpowers:brainstorming');
  });

  it('is null for anything that only mentions a command', () => {
    expect(shortcutTarget('Run /retouch-ascii-review first')).toBeNull();
    expect(shortcutTarget('Shortcut for the review flow')).toBeNull();
    expect(shortcutTarget(undefined)).toBeNull();
    expect(shortcutTarget('')).toBeNull();
  });
});

describe('stripShortcutPrefix', () => {
  it('drops the "Shortcut for /x —" lead-in the → chip already shows', () => {
    expect(stripShortcutPrefix('Shortcut for /retouch-ascii-auto-build — retouch, ASCII sketch, build without waiting'))
      .toBe('retouch, ASCII sketch, build without waiting');
    expect(stripShortcutPrefix('Shortcut for /rar: wait')).toBe('wait');
    expect(stripShortcutPrefix('Shortcut for /rar - wait')).toBe('wait');
  });

  it('leaves a description with nothing after the target empty, and others untouched', () => {
    expect(stripShortcutPrefix('Shortcut for /rar')).toBe('');
    expect(stripShortcutPrefix('A normal description')).toBe('A normal description');
  });
});

describe('buildShortcutIndex — one CLI\'s command index', () => {
  const entries = [
    { name: 'raab', description: 'Shortcut for /retouch-ascii-auto-build — build' },
    { name: 'rar', description: 'Shortcut for /retouch-ascii-review — review' },
    { name: 'zz', description: 'Shortcut for /retouch-ascii-auto-build — another' },
    { name: 'retouch-ascii-auto-build', description: 'Retouch, sketch, build' },
    { name: 'loop', description: 'Shortcut for /loop — points at itself' },
    { name: 'chain', description: 'Shortcut for /raab — alias of an alias' },
  ];

  it('maps each alias to its target and each target to its sorted aliases', () => {
    const idx = buildShortcutIndex(entries);
    expect(idx.targetOf.get('raab')).toBe('retouch-ascii-auto-build');
    expect(idx.aliasesOf.get('retouch-ascii-auto-build')).toEqual(['raab', 'zz']);
    // A target missing from the index still knows its alias.
    expect(idx.aliasesOf.get('retouch-ascii-review')).toEqual(['rar']);
  });

  it('ignores a self-reference and records only one hop', () => {
    const idx = buildShortcutIndex(entries);
    expect(idx.targetOf.has('loop')).toBe(false);
    expect(idx.aliasesOf.has('loop')).toBe(false);
    expect(idx.targetOf.get('chain')).toBe('raab');
    expect(idx.aliasesOf.get('retouch-ascii-auto-build')).not.toContain('chain');
  });
});

function res(over: Partial<ResourceSummary> & Pick<ResourceSummary, 'id' | 'name' | 'type'>): ResourceSummary {
  return {
    agent: 'claude', scope: 'global', origin: 'user', format: 'markdown',
    path: `~/x/${over.id}`, fileCount: 1, bytes: 1, mtimeMs: 0,
    repo: { status: 'not-tracked' }, variantIds: [], findingCodes: [],
    ...over,
  };
}

describe('buildResourceShortcuts — the RESOURCES catalog', () => {
  const catalog = [
    res({ id: 'c-raab', type: 'command', name: 'raab', description: 'Shortcut for /retouch-ascii-auto-build — build' }),
    res({ id: 'c-skill', type: 'skill', name: 'retouch-ascii-auto-build' }),
    res({ id: 'x-raab', type: 'command', agent: 'codex', name: 'raab', description: 'Shortcut for /retouch-ascii-auto-build — build' }),
    res({ id: 'x-skill', type: 'skill', agent: 'codex', name: 'retouch-ascii-auto-build' }),
    res({ id: 'p-raab', type: 'command', scope: 'project', projectId: 'p1', name: 'raab', description: 'Shortcut for /retouch-ascii-auto-build' }),
    res({ id: 'c-rule', type: 'rule', name: 'note.md', description: 'Shortcut for /retouch-ascii-auto-build' }),
  ];

  it('links an alias to the target of the SAME agent, never across agents', () => {
    const s = buildResourceShortcuts(catalog);
    expect(s.targetOf.get('c-raab')).toEqual({ name: 'retouch-ascii-auto-build', id: 'c-skill' });
    expect(s.targetOf.get('x-raab')).toEqual({ name: 'retouch-ascii-auto-build', id: 'x-skill' });
    expect(s.aliasesOf.get('c-skill')?.map((a) => a.id)).toEqual(['c-raab', 'p-raab']);
    expect(s.aliasesOf.get('x-skill')?.map((a) => a.id)).toEqual(['x-raab']);
  });

  it('only commands are aliases, and a target missing from the catalog keeps its name', () => {
    const s = buildResourceShortcuts([
      res({ id: 'c-rar', type: 'command', name: 'rar', description: 'Shortcut for /retouch-ascii-review — x' }),
      ...catalog,
    ]);
    expect(s.targetOf.has('c-rule')).toBe(false);
    expect(s.targetOf.get('c-rar')).toEqual({ name: 'retouch-ascii-review', id: undefined });
  });
});
