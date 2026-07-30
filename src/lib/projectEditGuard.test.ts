import { describe, it, expect, beforeEach } from 'vitest';
import { setProjectEditing, isProjectEditing, resetProjectEditing } from './projectEditGuard';

describe('projectEditGuard', () => {
  beforeEach(() => resetProjectEditing());

  it('reports a session as clean until an editor marks it dirty', () => {
    expect(isProjectEditing('s1')).toBe(false);
    setProjectEditing('s1', 'tab-a', true);
    expect(isProjectEditing('s1')).toBe(true);
  });

  it('clears the session once its editor saves or cancels', () => {
    setProjectEditing('s1', 'tab-a', true);
    setProjectEditing('s1', 'tab-a', false);
    expect(isProjectEditing('s1')).toBe(false);
  });

  it('keeps a session pinned while any of its sub-tabs is still dirty', () => {
    setProjectEditing('s1', 'tab-a', true);
    setProjectEditing('s1', 'tab-b', true);

    setProjectEditing('s1', 'tab-a', false);
    // tab-b is still editing — one sub-tab must not unpin the whole session.
    expect(isProjectEditing('s1')).toBe(true);

    setProjectEditing('s1', 'tab-b', false);
    expect(isProjectEditing('s1')).toBe(false);
  });

  it('tracks sessions independently', () => {
    setProjectEditing('s1', 'tab-a', true);
    expect(isProjectEditing('s2')).toBe(false);
  });

  it('ignores editors with no owning session', () => {
    setProjectEditing(undefined, 'tab-a', true);
    expect(isProjectEditing('undefined')).toBe(false);
  });

  it('tolerates clearing an editor that was never marked', () => {
    expect(() => setProjectEditing('s1', 'never-dirty', false)).not.toThrow();
    expect(isProjectEditing('s1')).toBe(false);
  });
});
