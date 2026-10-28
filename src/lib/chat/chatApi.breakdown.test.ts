// chatApi.breakdown.test.ts — the phone reads what fills the window as the Mac sends it: each
// kind's entries survive the schema (Oct 28 2026), and an older Mac's answer without them still reads.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchContextBreakdown } from './chatApi';

const answer = (data: unknown) => vi.fn(async () => new Response(JSON.stringify({ success: true, data }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
}));
const base = { tokens: 1000, items: [], requests: 3, sinceCompaction: false, measuredAt: 1 };

afterEach(() => vi.unstubAllGlobals());

describe('fetchContextBreakdown', () => {
  it("keeps each kind's entries, their counts and the rest", async () => {
    vi.stubGlobal('fetch', answer({
      ...base,
      kinds: [{
        kind: 'bash', tokens: 1000,
        items: [{ kind: 'bash', label: 'Bash · npm test', tokens: 900, count: 3 }],
        rest: { count: 4, tokens: 100 },
      }],
    }));
    const r = await fetchContextBreakdown('s1');
    expect(r).toEqual({ ok: true, data: expect.objectContaining({
      kinds: [{ kind: 'bash', tokens: 1000, items: [{ kind: 'bash', label: 'Bash · npm test', tokens: 900, count: 3 }], rest: { count: 4, tokens: 100 } }],
    }) });
  });

  it('still reads a Mac that sends kinds without entries', async () => {
    vi.stubGlobal('fetch', answer({ ...base, kinds: [{ kind: 'system', tokens: 1000 }] }));
    expect(await fetchContextBreakdown('s1')).toEqual({ ok: true, data: expect.objectContaining({ kinds: [{ kind: 'system', tokens: 1000 }] }) });
  });
});
