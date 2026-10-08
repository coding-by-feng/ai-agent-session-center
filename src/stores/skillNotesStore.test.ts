import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSkillNotesStore, loadSkillNotes } from './skillNotesStore';
import { STORAGE_KEY } from '@/lib/skillNotes';

const reset = () => {
  try { localStorage.clear(); } catch { /* ignore */ }
  useSkillNotesStore.setState({ notes: {} });
};

describe('skillNotesStore', () => {
  beforeEach(reset);

  it('toggles a favourite and persists it', () => {
    useSkillNotesStore.getState().toggleFav('claude:x');
    expect(useSkillNotesStore.getState().notes['claude:x'].fav).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).notes['claude:x'].fav).toBe(true);
    useSkillNotesStore.getState().toggleFav('claude:x');
    expect(useSkillNotesStore.getState().notes).toEqual({});
  });

  it('adds and removes several tags', () => {
    const s = useSkillNotesStore.getState();
    s.addTag('claude:x', 'Review');
    s.addTag('claude:x', 'workflow');
    expect(useSkillNotesStore.getState().notes['claude:x'].tags).toEqual(['review', 'workflow']);
    s.removeTag('claude:x', 'review');
    expect(useSkillNotesStore.getState().notes['claude:x'].tags).toEqual(['workflow']);
  });

  it('sets an abbreviation when valid and reports why when not', () => {
    const real = new Set(['claude:plan']);
    const s = useSkillNotesStore.getState();
    expect(s.setAbbr('claude:retouch', 'rar', real)).toEqual({ ok: true, value: 'rar' });
    expect(useSkillNotesStore.getState().notes['claude:retouch'].abbr).toBe('rar');
    const dup = s.setAbbr('claude:other', 'rar', real);
    expect(dup.ok).toBe(false);
    expect(useSkillNotesStore.getState().notes['claude:other']).toBeUndefined();
    expect(s.setAbbr('claude:retouch', '', real)).toEqual({ ok: true, value: '' });
    expect(useSkillNotesStore.getState().notes).toEqual({});
  });

  it('never mutates the previous notes object', () => {
    const before = useSkillNotesStore.getState().notes;
    useSkillNotesStore.getState().addTag('claude:x', 'a');
    expect(before).toEqual({});
  });

  it('loads what was stored, and starts empty on a corrupt value', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, notes: { 'codex:y': { fav: true, tags: ['t'] } } }));
    expect(loadSkillNotes()['codex:y']).toEqual({ fav: true, tags: ['t'] });
    localStorage.setItem(STORAGE_KEY, '{oops');
    expect(loadSkillNotes()).toEqual({});
  });

  it('follows a change made in another window (storage event)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, notes: { 'claude:z': { fav: true, tags: [] } } }));
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    expect(useSkillNotesStore.getState().notes['claude:z'].fav).toBe(true);
  });

  it('keeps working in memory when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => useSkillNotesStore.getState().toggleFav('claude:q')).not.toThrow();
    expect(useSkillNotesStore.getState().notes['claude:q'].fav).toBe(true);
    spy.mockRestore();
  });
});
