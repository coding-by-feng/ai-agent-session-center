// composerDraftStore.test.ts — the composer's per-session draft (AASC-41/44): set,
// clear, and text appended on a line of its own (Pull back, a diff line's Comment).
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

  it('does not add a blank line after one that already ends', () => {
    expect(appendedDraft('first\n', 'second')).toBe('first\nsecond');
    expect(appendedDraft('', 'x')).toBe('x');
  });
});
