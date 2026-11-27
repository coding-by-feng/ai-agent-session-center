// sentPrompts.test.ts — the queue History → Sent list's merge (Nov 27 2026).
import { describe, expect, it, vi } from 'vitest';
import { fetchSentPage, isTypedPrompt, mergeSentPrompts, sentPromptsUrl, SENT_PAGE_SIZE } from './sentPrompts';

describe('isTypedPrompt', () => {
  it('drops blank rows and harness tags, keeps commands and text', () => {
    expect(isTypedPrompt('')).toBe(false);
    expect(isTypedPrompt('   ')).toBe(false);
    expect(isTypedPrompt(null)).toBe(false);
    expect(isTypedPrompt('  <task-notification>done</task-notification>')).toBe(false);
    expect(isTypedPrompt('/clear')).toBe(true);
    expect(isTypedPrompt('fix the build')).toBe(true);
  });
});

describe('mergeSentPrompts', () => {
  it('keeps each prompt once, newest first, across the card and the record', () => {
    const memory = [{ text: 'b', timestamp: 20 }, { text: 'c', timestamp: 30 }];
    const stored = [{ text: 'c', timestamp: 30 }, { text: 'b', timestamp: 20 }, { text: 'a', timestamp: 10 }];
    expect(mergeSentPrompts(memory, stored)).toEqual([
      { text: 'c', timestamp: 30 },
      { text: 'b', timestamp: 20 },
      { text: 'a', timestamp: 10 },
    ]);
  });

  it('keeps the longer copy when the card trimmed a long prompt', () => {
    const merged = mergeSentPrompts([{ text: 'a long prompt', timestamp: 5 }], [{ text: 'a long prompt that goes on', timestamp: 5 }]);
    expect(merged).toEqual([{ text: 'a long prompt that goes on', timestamp: 5 }]);
  });

  it('keeps one copy of a prompt the card cut with the server’s truncation marker (review, Nov 27 2026)', () => {
    const full = 'x'.repeat(30);
    const card = full.slice(0, 10) + '\n\n[… truncated — full prompt kept in the session transcript]';
    expect(mergeSentPrompts([{ text: card, timestamp: 5 }], [{ text: full, timestamp: 5 }])).toEqual([{ text: full, timestamp: 5 }]);
    expect(mergeSentPrompts([{ text: card, timestamp: 5 }], [])).toEqual([{ text: card, timestamp: 5 }]);
  });

  it('keeps two different prompts that share a time, and the same text sent twice', () => {
    const merged = mergeSentPrompts([{ text: 'yes', timestamp: 5 }, { text: 'yes', timestamp: 9 }], [{ text: 'no', timestamp: 5 }]);
    expect(merged).toHaveLength(3);
  });

  it('leaves out harness rows from either source', () => {
    expect(mergeSentPrompts([{ text: '<x>', timestamp: 1 }], [{ text: '<y>', timestamp: 2 }])).toEqual([]);
  });
});

describe('fetchSentPage', () => {
  it('asks for this session’s typed prompts, newest first, one page', () => {
    const url = new URL(sentPromptsUrl('s 1', 2), 'http://x');
    expect(url.pathname).toBe('/api/db/prompts');
    expect(Object.fromEntries(url.searchParams)).toEqual({ session: 's 1', kind: 'mine', sortDir: 'desc', page: '2', pageSize: String(SENT_PAGE_SIZE) });
  });

  it('says whether more pages are stored', async () => {
    const answer = (total: number) => vi.fn(async () => new Response(JSON.stringify({ prompts: [{ id: 1, session_id: 's', text: 'hi', timestamp: 3 }], total, page: 1, pageSize: 50 })));
    expect(await fetchSentPage('s', 1, answer(51))).toEqual({ prompts: [{ text: 'hi', timestamp: 3 }], more: true });
    expect((await fetchSentPage('s', 1, answer(50))).more).toBe(false);
  });

  it('throws on a refusal, with a rate-limit message for 429', async () => {
    await expect(fetchSentPage('s', 1, async () => new Response('', { status: 429 }))).rejects.toThrow(/Too many/);
    await expect(fetchSentPage('s', 1, async () => new Response('', { status: 404 }))).rejects.toThrow(/404/);
  });
});
