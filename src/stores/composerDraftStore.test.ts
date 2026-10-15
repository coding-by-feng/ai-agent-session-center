// composerDraftStore.test.ts — the composer's per-session draft (AASC-41/44/42): set,
// clear, text appended on a line of its own (Pull back, a diff line's Comment), and
// kept in localStorage so a reload keeps it.
import { describe, it, expect, beforeEach } from 'vitest';
import { appendedDraft, useComposerDraftStore } from './composerDraftStore';

beforeEach(() => useComposerDraftStore.setState({ drafts: {} }));

describe('composerDraftStore', () => {
  it('sets and clears one session’s draft without touching another', () => {
    const { setDraft } = useComposerDraftStore.getState();
    setDraft('a', 'hello');
    setDraft('b', 'other');
    setDraft('a', '');
    expect(useComposerDraftStore.getState().drafts).toEqual({ b: 'other' });
  });

  it('appends on a new line', () => {
    const { setDraft, appendToDraft } = useComposerDraftStore.getState();
    appendToDraft('a', 'src/ui/icons.tsx:41 — ');
    expect(useComposerDraftStore.getState().drafts.a).toBe('src/ui/icons.tsx:41 — ');
    setDraft('a', 'Please also');
    appendToDraft('a', 'pulled back prompt');
    expect(useComposerDraftStore.getState().drafts.a).toBe('Please also\npulled back prompt');
  });

  it('keeps a Comment’s trailing space and ignores blank text', () => {
    const { appendToDraft } = useComposerDraftStore.getState();
    appendToDraft('a', '   ');
    expect(useComposerDraftStore.getState().drafts).toEqual({});
    appendToDraft('a', 'a.ts:3 — ');
    expect(useComposerDraftStore.getState().drafts.a).toBe('a.ts:3 — ');
  });

  it('writes the drafts to localStorage', () => {
    const { setDraft } = useComposerDraftStore.getState();
    setDraft('a', 'keep me');
    expect(JSON.parse(localStorage.getItem('aasc.composerDrafts') ?? '{}')).toEqual({ a: 'keep me' });
    setDraft('a', '');
    expect(JSON.parse(localStorage.getItem('aasc.composerDrafts') ?? '{}')).toEqual({});
  });

  it('does not add a blank line after one that already ends', () => {
    expect(appendedDraft('first\n', 'second')).toBe('first\nsecond');
    expect(appendedDraft('', 'x')).toBe('x');
  });

  it('moves a draft to a session\'s new id when it re-keys, never over one already there', () => {
    const { setDraft, moveDraft } = useComposerDraftStore.getState();
    setDraft('old', 'half a thought');
    moveDraft('old', 'new');
    expect(useComposerDraftStore.getState().drafts).toEqual({ new: 'half a thought' });
    expect(JSON.parse(localStorage.getItem('aasc.composerDrafts') ?? '{}')).toEqual({ new: 'half a thought' });

    setDraft('a', 'from a');
    setDraft('b', 'already in b');
    moveDraft('a', 'b');
    expect(useComposerDraftStore.getState().drafts.b).toBe('already in b\nfrom a');
    expect(useComposerDraftStore.getState().drafts.a).toBeUndefined();

    const before = useComposerDraftStore.getState().drafts;
    moveDraft('nothing-here', 'c');
    expect(useComposerDraftStore.getState().drafts).toBe(before);
  });
});
