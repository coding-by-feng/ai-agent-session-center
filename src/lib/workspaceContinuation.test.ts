import { expect, it } from 'vitest';
import { mergeContinuation } from './workspaceContinuation';
import type { ContinuationDraft, WorkspaceContinuation } from '@/types/workspaceContinuation';
const draft = (text: string): ContinuationDraft => ({
  text,
  images: [],
  type: 'once',
  intervalValue: 1,
  intervalUnit: 'min',
  runAt: '',
});
const record = (sourceId: string, text: string, updatedAt = 1): WorkspaceContinuation => ({
  sourceId,
  revision: 1,
  updatedAt,
  selectedSessionId: 'a',
  drafts: [{ sessionId: 'a', draft: draft(text) }],
});
it('continues the most recent visible session and complete unsent draft', () => {
  const recent = record('recent', 'new', 2);
  recent.drafts[0].draft.images = [{ name: 'x.png', dataUrl: 'data:image/png;base64,YQ==' }];
  const result = mergeContinuation(new Map(), [record('old', 'old'), recent], new Set(['a']));
  expect(result.selectedSessionId).toBe('a');
  expect(result.drafts.get('a')).toEqual(recent.drafts[0].draft);
  expect(result.conflicts.map((item) => item.draft.text)).toEqual(['old']);
  expect(result.adopt).toEqual([{ sourceId: 'recent', revision: 1 }]);
});
it('preserves a local draft and leaves conflicting windows available; never selects hidden IDs', () => {
  const current = new Map([['a', draft('local')]]);
  const result = mergeContinuation(current, [record('remote', 'other')], new Set(['a']));
  expect(result.drafts.get('a')?.text).toBe('local');
  expect(result.conflicts[0].draft.text).toBe('other');
  expect(result.adopt).toEqual([]);
  const hidden = mergeContinuation(new Map(), [record('private', 'secret')], new Set());
  expect(hidden.selectedSessionId).toBeNull();
  expect(hidden.drafts.size).toBe(0);
  expect(hidden.conflicts).toEqual([]);
});

it('prioritizes the switching window and keeps newer windows as alternates, including an intentionally empty draft', () => {
  const own = record('own', 'own draft', 1),
    other = record('other', 'other draft', 100);
  other.selectedSessionId = 'b';
  const merged = mergeContinuation(new Map(), [other, own], new Set(['a', 'b']), 'own');
  expect(merged.selectedSessionId).toBe('a');
  expect(merged.drafts.get('a')?.text).toBe('own draft');
  expect(merged.conflicts[0].draft.text).toBe('other draft');
  own.drafts = [];
  const cleared = mergeContinuation(new Map(), [other, own], new Set(['a', 'b']), 'own');
  expect(cleared.drafts.has('a')).toBe(false);
  expect(cleared.conflicts[0].draft.text).toBe('other draft');
});
