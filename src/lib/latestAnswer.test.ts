// latestAnswer.test.ts — which answer the read-aloud button speaks (AASC-20).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { lastAssistantText, lastResponseText, fetchLatestAnswer } from './latestAnswer';

afterEach(() => vi.unstubAllGlobals());

describe('latestAnswer', () => {
  it('takes the last assistant entry, skipping tools and blanks', () => {
    expect(lastAssistantText([
      { role: 'assistant', text: 'first', timestamp: 1 },
      { role: 'tool_use', tool: 'Bash', input: 'ls', timestamp: 2 },
      { role: 'assistant', text: 'the answer', timestamp: 3 },
      { role: 'assistant', text: '  ', timestamp: 4 },
      { role: 'user', text: 'thanks', timestamp: 5 },
    ])).toBe('the answer');
    expect(lastAssistantText([])).toBe('');
  });

  it('falls back to the newest reply in the response log', async () => {
    expect(lastResponseText(undefined)).toBe('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] }))));
    expect(await fetchLatestAnswer('s1', [{ text: 'old', timestamp: 1 }, { text: 'new', timestamp: 2 }])).toBe('new');
  });

  it('prefers the transcript', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true, data: [{ role: 'assistant', text: 'full answer', timestamp: 1 }],
    }))));
    expect(await fetchLatestAnswer('s1', [{ text: 'excerpt', timestamp: 2 }])).toBe('full answer');
  });
});
