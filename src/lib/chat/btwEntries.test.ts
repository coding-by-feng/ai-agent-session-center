import { describe, it, expect } from 'vitest';
import type { ChatEntry } from '@/types/chat';
import { btwEntry, withBtwEntries } from './btwEntries';
import { buildChatItems } from './buildChatItems';

const user = (key: string, timestamp: number): ChatEntry => ({ kind: 'user', key, timestamp, text: key });

describe('withBtwEntries', () => {
  it('returns the same entries when there are no answers', () => {
    const entries = [user('a', 1)];
    expect(withBtwEntries(entries, undefined, false)).toBe(entries);
    expect(withBtwEntries(entries, [], false)).toBe(entries);
  });

  it('places each answer by time among the transcript entries', () => {
    const entries = [user('a', 10), user('b', 30)];
    const out = withBtwEntries(entries, [{ question: 'q', answer: 'x', at: 20 }, { question: 'r', answer: 'y', at: 40 }], false);
    expect(out.map((e) => e.key)).toEqual(['a', 'btw:20', 'b', 'btw:40']);
  });

  it('leaves out an answer older than the loaded page while older pages remain', () => {
    const entries = [user('a', 10)];
    expect(withBtwEntries(entries, [{ question: 'q', answer: 'x', at: 5 }], true).map((e) => e.key)).toEqual(['a']);
    expect(withBtwEntries(entries, [{ question: 'q', answer: 'x', at: 5 }], false).map((e) => e.key)).toEqual(['btw:5', 'a']);
  });

  it('becomes a /btw command row with its answer as the output', () => {
    expect(btwEntry({ question: 'how many?', answer: 'Eight.', at: 7 })).toEqual({
      kind: 'command', key: 'btw:7', timestamp: 7, name: 'btw', args: 'how many?', output: 'Eight.',
    });
    const items = buildChatItems(withBtwEntries([], [{ question: 'how many?', answer: 'Eight.', at: 7 }], false));
    expect(items).toEqual([expect.objectContaining({ kind: 'command', name: 'btw', args: 'how many?', output: 'Eight.' })]);
  });
});
