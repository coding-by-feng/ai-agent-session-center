import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillNotes } from '@/lib/skillNotes';
import type { SkillNoteOpMessage } from '@/types/skillNoteOps';

const roomWriter = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/roomSync', () => ({ isRoomWriter: () => roomWriter.value }));

import { useSettingsStore } from '@/stores/settingsStore';
import {
  applySkillNoteOp,
  handleKeepAwakeOpMessage,
  handleSkillNoteOpMessage,
  waitForSettingsLoad,
  type KeepAwakeOpDeps,
  type SkillNoteOpDeps,
} from './skillNoteOps';

const KEY = 'claude:retouch';

/** A tiny stand-in for the skill-note store: same actions, same immediate effect on `notes`. */
function fakeStore(initial: SkillNotes = {}, ready = true) {
  let state = {
    ready,
    notes: initial,
    toggleFav: vi.fn((key: string) => {
      const note = state.notes[key] ?? { fav: false, tags: [] };
      state = { ...state, notes: { ...state.notes, [key]: { ...note, fav: !note.fav } } };
    }),
    addTag: vi.fn((key: string, tag: string) => {
      const note = state.notes[key] ?? { fav: false, tags: [] };
      state = { ...state, notes: { ...state.notes, [key]: { ...note, tags: [...note.tags, tag] } } };
    }),
    removeTag: vi.fn((key: string, tag: string) => {
      const note = state.notes[key] ?? { fav: false, tags: [] };
      state = { ...state, notes: { ...state.notes, [key]: { ...note, tags: note.tags.filter((t) => t !== tag) } } };
    }),
    setAbbr: vi.fn((key: string, abbr: string): { ok: true; value: string } | { ok: false; error: string } => {
      const note = { ...(state.notes[key] ?? { fav: false, tags: [] }) };
      delete note.abbr;
      state = { ...state, notes: { ...state.notes, [key]: abbr ? { ...note, abbr } : note } };
      return { ok: true, value: abbr };
    }),
  };
  return { getState: () => state };
}

function deps(store = fakeStore(), over: Partial<SkillNoteOpDeps> = {}): SkillNoteOpDeps & { post: ReturnType<typeof vi.fn> } {
  const post = vi.fn().mockResolvedValue(undefined);
  return {
    store,
    realNames: async () => new Set(['claude:retouch', 'claude:tdd']),
    post,
    ...over,
  } as SkillNoteOpDeps & { post: ReturnType<typeof vi.fn> };
}

function op(set: SkillNoteOpMessage['set'], over: Partial<SkillNoteOpMessage> = {}): SkillNoteOpMessage {
  return { type: 'skill_note_op', opId: 'op-1', key: KEY, set, ...over };
}

describe('applySkillNoteOp', () => {
  beforeEach(() => {
    roomWriter.value = true;
  });

  it('fav sets, never toggles past the asked value', async () => {
    const store = fakeStore({ [KEY]: { fav: true, tags: [] } });
    const d = deps(store);
    expect(await applySkillNoteOp(op({ fav: true }), d)).toEqual({ ok: true });
    expect(store.getState().toggleFav).not.toHaveBeenCalled();
    expect(await applySkillNoteOp(op({ fav: false }), d)).toEqual({ ok: true });
    expect(store.getState().toggleFav).toHaveBeenCalledTimes(1);
    expect(store.getState().notes[KEY]?.fav).toBe(false);
    expect(await applySkillNoteOp(op({ fav: false }), d)).toEqual({ ok: true });
    expect(store.getState().toggleFav).toHaveBeenCalledTimes(1);
  });

  it('fav sets on a key that has no note yet', async () => {
    const store = fakeStore();
    await applySkillNoteOp(op({ fav: true }), deps(store));
    expect(store.getState().notes[KEY]?.fav).toBe(true);
  });

  it('tags are replaced by add and remove', async () => {
    const store = fakeStore({ [KEY]: { fav: false, tags: ['old', 'keep'] } });
    const result = await applySkillNoteOp(op({ tags: ['keep', 'new-tag'] }), deps(store));
    expect(result).toEqual({ ok: true });
    expect(store.getState().removeTag).toHaveBeenCalledTimes(1);
    expect(store.getState().removeTag).toHaveBeenCalledWith(KEY, 'old');
    expect(store.getState().addTag).toHaveBeenCalledTimes(1);
    expect(store.getState().addTag).toHaveBeenCalledWith(KEY, 'new-tag');
    expect(store.getState().notes[KEY]?.tags).toEqual(['keep', 'new-tag']);
  });

  it('an empty tag list removes every tag', async () => {
    const store = fakeStore({ [KEY]: { fav: false, tags: ['a', 'b'] } });
    expect(await applySkillNoteOp(op({ tags: [] }), deps(store))).toEqual({ ok: true });
    expect(store.getState().notes[KEY]?.tags).toEqual([]);
  });

  it('a tag that cannot be kept is refused before anything changes', async () => {
    const store = fakeStore({ [KEY]: { fav: false, tags: ['a'] } });
    const result = await applySkillNoteOp(op({ fav: true, tags: ['***'] }), deps(store));
    expect(result.ok).toBe(false);
    expect(store.getState().toggleFav).not.toHaveBeenCalled();
    expect(store.getState().removeTag).not.toHaveBeenCalled();
  });

  it('a tag the store would change (cut, folded, lowered) is bad-tags, not quietly kept as something else', async () => {
    for (const tag of ['a--b', 'x'.repeat(25), 'New Tag', '-a']) {
      const store = fakeStore();
      expect(await applySkillNoteOp(op({ tags: [tag] }), deps(store)), tag).toEqual({ ok: false, error: 'bad-tags' });
      expect(store.getState().addTag).not.toHaveBeenCalled();
    }
    expect(await applySkillNoteOp(op({ tags: ['x'.repeat(24), 'a-b_1'] }), deps())).toEqual({ ok: true });
  });

  it('more tags than a note may hold are refused before anything changes', async () => {
    const store = fakeStore();
    const tags = Array.from({ length: 13 }, (_, i) => `t${i}`);
    const result = await applySkillNoteOp(op({ tags }), deps(store));
    expect(result.ok).toBe(false);
    expect(store.getState().addTag).not.toHaveBeenCalled();
  });

  it('an abbr is checked against the real names and applied', async () => {
    const store = fakeStore();
    const realNames = vi.fn().mockResolvedValue(new Set(['claude:retouch', 'claude:tdd']));
    expect(await applySkillNoteOp(op({ abbr: 'rt' }), deps(store, { realNames }))).toEqual({ ok: true });
    expect(store.getState().setAbbr).toHaveBeenCalledWith(KEY, 'rt', new Set(['claude:retouch', 'claude:tdd']));
  });

  it('a null abbr clears it', async () => {
    const store = fakeStore({ [KEY]: { fav: false, tags: [], abbr: 'rt' } });
    expect(await applySkillNoteOp(op({ abbr: null }), deps(store))).toEqual({ ok: true });
    expect(store.getState().setAbbr).toHaveBeenCalledWith(KEY, '', expect.any(Set));
  });

  it('an abbr refusal is a fixed code, never the store’s words, and changes nothing else', async () => {
    const cases: Array<[string, string]> = [
      ['R!', 'abbr-format'],
      ['x', 'abbr-format'],
      ['taken', 'abbr-taken'],
      ['tdd', 'abbr-shadows'],
    ];
    for (const [abbr, code] of cases) {
      const store = fakeStore({ 'claude:other': { fav: false, tags: [], abbr: 'taken' } });
      const result = await applySkillNoteOp(op({ abbr, fav: true }), deps(store));
      expect(result, abbr).toEqual({ ok: false, error: code });
      expect(store.getState().setAbbr).not.toHaveBeenCalled();
      expect(store.getState().toggleFav).not.toHaveBeenCalled();
    }
  });

  it('a skill the catalog does not have is unknown-skill, before anything changes', async () => {
    const store = fakeStore();
    const result = await applySkillNoteOp(op({ fav: true, tags: ['a'] }, { key: 'claude:no-such-skill' }), deps(store));
    expect(result).toEqual({ ok: false, error: 'unknown-skill' });
    expect(store.getState().toggleFav).not.toHaveBeenCalled();
    expect(store.getState().addTag).not.toHaveBeenCalled();
    // The same name under another agent is another skill.
    expect(await applySkillNoteOp(op({ fav: true }, { key: 'codex:retouch' }), deps(fakeStore()))).toEqual({ ok: false, error: 'unknown-skill' });
  });

  it('an op that only clears what an existing note holds passes for a skill the catalog no longer has', async () => {
    const GONE = 'claude:uninstalled';
    const note = { fav: true, tags: ['a', 'b'], abbr: 'un' };
    const store = fakeStore({ [GONE]: note });
    expect(await applySkillNoteOp(op({ fav: false, tags: ['a'], abbr: null }, { key: GONE }), deps(store))).toEqual({ ok: true });
    expect(store.getState().notes[GONE]).toEqual({ fav: false, tags: ['a'] });

    // Even with the catalog unreadable.
    const cleared = fakeStore({ [GONE]: note });
    const down = vi.fn().mockRejectedValue(new Error('down'));
    expect(await applySkillNoteOp(op({ tags: [] }, { key: GONE }), deps(cleared, { realNames: down }))).toEqual({ ok: true });
  });

  it('an op that creates or sets something on a skill the catalog does not have is still unknown-skill', async () => {
    const GONE = 'claude:uninstalled';
    const sets: Array<SkillNoteOpMessage['set']> = [{ fav: true }, { tags: ['a', 'new'] }, { abbr: 'zz' }];
    for (const set of sets) {
      const store = fakeStore({ [GONE]: { fav: false, tags: ['a'] } });
      expect(await applySkillNoteOp(op(set, { key: GONE }), deps(store)), JSON.stringify(set)).toEqual({ ok: false, error: 'unknown-skill' });
    }
    // No note to clear: even a clearing op is refused.
    expect(await applySkillNoteOp(op({ fav: false }, { key: GONE }), deps(fakeStore()))).toEqual({ ok: false, error: 'unknown-skill' });
  });

  it('nothing can be checked when the catalog cannot be read', async () => {
    for (const set of [{ abbr: 'rt' }, { fav: true }]) {
      const store = fakeStore();
      const realNames = vi.fn().mockRejectedValue(new Error('down'));
      const result = await applySkillNoteOp(op(set), deps(store, { realNames }));
      expect(result).toEqual({ ok: false, error: 'catalog-unavailable' });
      expect(store.getState().setAbbr).not.toHaveBeenCalled();
      expect(store.getState().toggleFav).not.toHaveBeenCalled();
    }
  });

  it('not ready answers not-ready', async () => {
    const store = fakeStore({}, false);
    const result = await applySkillNoteOp(op({ fav: true }), deps(store));
    expect(result).toEqual({ ok: false, error: 'not-ready' });
    expect(store.getState().toggleFav).not.toHaveBeenCalled();
  });

  it("the result is posted to the op's result route", async () => {
    const d = deps();
    await applySkillNoteOp(op({ fav: true }, { opId: 'op/9' }), d);
    expect(d.post).toHaveBeenCalledWith('/api/skill-notes/ops/op%2F9/result', { ok: true });
  });

  it('a refusal is posted too', async () => {
    const d = deps(fakeStore({}, false));
    await applySkillNoteOp(op({ fav: true }), d);
    expect(d.post).toHaveBeenCalledWith('/api/skill-notes/ops/op-1/result', { ok: false, error: 'not-ready' });
  });

  it('a result that cannot be posted does not throw', async () => {
    const d = deps(fakeStore(), { post: vi.fn().mockRejectedValue(new Error('offline')) });
    await expect(applySkillNoteOp(op({ fav: true }), d)).resolves.toEqual({ ok: true });
  });
});

describe('handleSkillNoteOpMessage', () => {
  beforeEach(() => {
    roomWriter.value = true;
  });

  it('a window that is not the room writer ignores the message', async () => {
    roomWriter.value = false;
    const store = fakeStore();
    const d = deps(store);
    await handleSkillNoteOpMessage(op({ fav: true }), d);
    expect(store.getState().toggleFav).not.toHaveBeenCalled();
    expect(d.post).not.toHaveBeenCalled();
  });

  it('the writer applies a well-formed op', async () => {
    const store = fakeStore();
    const d = deps(store);
    await handleSkillNoteOpMessage(op({ fav: true }), d);
    expect(store.getState().notes[KEY]?.fav).toBe(true);
    expect(d.post).toHaveBeenCalledTimes(1);
  });

  it('a malformed op with an id is answered bad-op; one without is ignored', async () => {
    const d = deps();
    await handleSkillNoteOpMessage({ type: 'skill_note_op', opId: 'op-2', key: 5, set: {} }, d);
    expect(d.post).toHaveBeenCalledWith('/api/skill-notes/ops/op-2/result', { ok: false, error: 'bad-op' });
    d.post.mockClear();
    await handleSkillNoteOpMessage({ type: 'skill_note_op' }, d);
    await handleSkillNoteOpMessage(null, d);
    expect(d.post).not.toHaveBeenCalled();
  });

  it('a malformed change is bad-op and changes nothing', async () => {
    const store = fakeStore();
    const d = deps(store);
    await handleSkillNoteOpMessage(op({ fav: 'yes' } as unknown as SkillNoteOpMessage['set']), d);
    await handleSkillNoteOpMessage(op({ tags: [1] } as unknown as SkillNoteOpMessage['set']), d);
    await handleSkillNoteOpMessage(op({ abbr: 5 } as unknown as SkillNoteOpMessage['set']), d);
    expect(store.getState().toggleFav).not.toHaveBeenCalled();
    expect(d.post).toHaveBeenCalledTimes(3);
    for (const call of d.post.mock.calls) expect(call[1]).toEqual({ ok: false, error: 'bad-op' });
  });

  it('a key that is not agent:name is bad-op', async () => {
    const d = deps();
    await handleSkillNoteOpMessage(op({ fav: true }, { key: 'nocolon' }), d);
    expect(d.post).toHaveBeenCalledWith('/api/skill-notes/ops/op-1/result', { ok: false, error: 'bad-op' });
  });
});

describe('handleKeepAwakeOpMessage', () => {
  beforeEach(() => {
    roomWriter.value = true;
    useSettingsStore.setState({ keepAwakeWhileWorking: false });
  });

  function keepAwakeDeps(over: Partial<KeepAwakeOpDeps> = {}): KeepAwakeOpDeps & { post: ReturnType<typeof vi.fn> } {
    const post = vi.fn().mockResolvedValue(undefined);
    return { settings: useSettingsStore, isDesktop: () => true, settingsLoaded: async () => true, post, ...over } as KeepAwakeOpDeps & {
      post: ReturnType<typeof vi.fn>;
    };
  }

  it('the writer’s desktop window sets the setting itself and answers ok', async () => {
    const d = keepAwakeDeps();

    await handleKeepAwakeOpMessage({ type: 'keep_awake_op', opId: 'op/3', on: true }, d);

    // The store holds it, so the window's own push (useSettingsInit) and any later one carry the new value.
    expect(useSettingsStore.getState().keepAwakeWhileWorking).toBe(true);
    expect(d.post).toHaveBeenCalledWith('/api/keep-awake/ops/op%2F3/result', { ok: true });

    await handleKeepAwakeOpMessage({ type: 'keep_awake_op', opId: 'op-4', on: false }, d);
    expect(useSettingsStore.getState().keepAwakeWhileWorking).toBe(false);
  });

  it('a window that is not the desktop app answers not-desktop and changes nothing', async () => {
    const d = keepAwakeDeps({ isDesktop: () => false });

    await handleKeepAwakeOpMessage({ type: 'keep_awake_op', opId: 'op-1', on: true }, d);

    expect(useSettingsStore.getState().keepAwakeWhileWorking).toBe(false);
    expect(d.post).toHaveBeenCalledWith('/api/keep-awake/ops/op-1/result', { ok: false, error: 'not-desktop' });
  });

  it('settings still loading from IndexedDB is not-ready, and the setting is not touched (the load would undo it)', async () => {
    const d = keepAwakeDeps({ settingsLoaded: async () => false });

    await handleKeepAwakeOpMessage({ type: 'keep_awake_op', opId: 'op-1', on: true }, d);

    expect(useSettingsStore.getState().keepAwakeWhileWorking).toBe(false);
    expect(d.post).toHaveBeenCalledWith('/api/keep-awake/ops/op-1/result', { ok: false, error: 'not-ready' });
  });

  it('a window that is not the writer ignores it; a malformed op is bad-op', async () => {
    roomWriter.value = false;
    const d = keepAwakeDeps();
    await handleKeepAwakeOpMessage({ type: 'keep_awake_op', opId: 'op-1', on: true }, d);
    expect(d.post).not.toHaveBeenCalled();

    roomWriter.value = true;
    await handleKeepAwakeOpMessage({ type: 'keep_awake_op', opId: 'op-2', on: 'yes' }, d);
    expect(d.post).toHaveBeenCalledWith('/api/keep-awake/ops/op-2/result', { ok: false, error: 'bad-op' });
    await handleKeepAwakeOpMessage({ type: 'keep_awake_op' }, d);
    expect(d.post).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().keepAwakeWhileWorking).toBe(false);
  });

  it('a result that cannot be posted does not throw', async () => {
    const d = keepAwakeDeps({ post: vi.fn().mockRejectedValue(new Error('offline')) });
    await expect(handleKeepAwakeOpMessage({ type: 'keep_awake_op', opId: 'op-1', on: true }, d)).resolves.toBeUndefined();
  });
});

describe('waitForSettingsLoad', () => {
  function signal(rows: number | Error, loaded = false) {
    const listeners = new Set<() => void>();
    const state = { loaded };
    return {
      state,
      fire: () => listeners.forEach((l) => l()),
      sig: {
        loaded: () => state.loaded,
        subscribe: (l: () => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        countRows: async () => {
          if (rows instanceof Error) throw rows;
          return rows;
        },
        timeoutMs: 3_000,
      },
      listeners,
    };
  }

  it('is true at once when loaded, when there is nothing to load, or when IndexedDB cannot be read', async () => {
    expect(await waitForSettingsLoad(signal(5, true).sig)).toBe(true);
    expect(await waitForSettingsLoad(signal(0).sig)).toBe(true);
    expect(await waitForSettingsLoad(signal(new Error('no idb')).sig)).toBe(true);
  });

  it('waits for the load, and is false at the bound', async () => {
    vi.useFakeTimers();
    try {
      const s = signal(5);
      const waiting = waitForSettingsLoad(s.sig);
      await vi.advanceTimersByTimeAsync(100);
      s.fire(); // a store change that is not the load
      s.state.loaded = true;
      s.fire();
      expect(await waiting).toBe(true);
      expect(s.listeners.size).toBe(0);

      const never = signal(5);
      const timedOut = waitForSettingsLoad(never.sig);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await timedOut).toBe(false);
      expect(never.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
