import { describe, expect, it } from 'vitest';
import { followSessionAlias } from '../server/sessionAliasResolver.js';

describe('followSessionAlias', () => {
  it('resolves a saved terminal ID through a fresh terminal ID to the hook UUID', () => {
    const live = new Set(['codex-uuid']);
    const aliases = new Map([
      ['term-saved', 'term-fresh'],
      ['term-fresh', 'codex-uuid'],
    ]);

    expect(followSessionAlias('term-saved', (id) => live.has(id), (id) => aliases.get(id)))
      .toBe('codex-uuid');
  });

  it('returns null for an alias cycle', () => {
    const aliases = new Map([['a', 'b'], ['b', 'a']]);
    expect(followSessionAlias('a', () => false, (id) => aliases.get(id))).toBeNull();
  });
});
