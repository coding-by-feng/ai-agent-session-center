import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMcpConfirmStore, parseConfirmView } from './mcpConfirmStore';
import type { McpConfirmView } from '@/types/mcpConfirm';

const NOW = 1_700_000_000_000;

function view(over: Partial<McpConfirmView> = {}): McpConfirmView {
  return {
    cardId: 'card-1',
    centralId: 'central-1',
    tool: 'session_kill',
    risk: 'ask',
    summary: 'Close the session "api"',
    detail: null,
    targetSessionId: 's-1',
    createdAt: NOW,
    expiresAt: NOW + 300_000,
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('mcpConfirmStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useMcpConfirmStore.setState({ confirms: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('parseConfirmView', () => {
    it('parse rejects a view with a missing or wrong field', () => {
      expect(parseConfirmView(view())).toEqual(view());
      expect(parseConfirmView(null)).toBeNull();
      expect(parseConfirmView('x')).toBeNull();
      for (const key of Object.keys(view())) {
        const incomplete: Record<string, unknown> = { ...view() };
        delete incomplete[key];
        expect(parseConfirmView(incomplete), `missing ${key}`).toBeNull();
      }
      expect(parseConfirmView({ ...view(), cardId: '' })).toBeNull();
      expect(parseConfirmView({ ...view(), risk: 'bogus' })).toBeNull();
      expect(parseConfirmView({ ...view(), expiresAt: 'soon' })).toBeNull();
      expect(parseConfirmView({ ...view(), detail: 5 })).toBeNull();
      expect(parseConfirmView({ ...view(), targetSessionId: 5 })).toBeNull();
    });

    it('parse bounds the strings and drops unknown fields', () => {
      expect(parseConfirmView({ ...view(), summary: 'x'.repeat(301) })).toBeNull();
      expect(parseConfirmView({ ...view(), detail: 'x'.repeat(2001) })).toBeNull();
      const parsed = parseConfirmView({ ...view(), confirmId: 'secret', args: { a: 1 } });
      expect(parsed).toEqual(view());
      expect(parsed).not.toHaveProperty('confirmId');
    });
  });

  it('apply dedupes by cardId', () => {
    const { apply } = useMcpConfirmStore.getState();
    apply(view());
    apply(view({ summary: 'newer words' }));
    apply(view({ cardId: 'card-2', createdAt: NOW + 1 }));
    const held = useMcpConfirmStore.getState().confirms;
    expect(held.map((c) => c.cardId)).toEqual(['card-1', 'card-2']);
    expect(held[0].summary).toBe('newer words');
  });

  it('apply ignores a malformed view and an expired one', () => {
    const { apply } = useMcpConfirmStore.getState();
    apply({ nope: true });
    apply(view({ expiresAt: NOW - 1 }));
    expect(useMcpConfirmStore.getState().confirms).toEqual([]);
  });

  it('apply keeps the list oldest first', () => {
    const { apply } = useMcpConfirmStore.getState();
    apply(view({ cardId: 'b', createdAt: NOW + 5 }));
    apply(view({ cardId: 'a', createdAt: NOW + 1 }));
    expect(useMcpConfirmStore.getState().confirms.map((c) => c.cardId)).toEqual(['a', 'b']);
  });

  it('resolved removes', () => {
    const { apply, resolved } = useMcpConfirmStore.getState();
    apply(view());
    apply(view({ cardId: 'card-2' }));
    resolved('card-1');
    expect(useMcpConfirmStore.getState().confirms.map((c) => c.cardId)).toEqual(['card-2']);
  });

  it('prune drops the cards past their expiry', () => {
    const { apply, prune } = useMcpConfirmStore.getState();
    apply(view());
    prune(NOW + 300_001);
    expect(useMcpConfirmStore.getState().confirms).toEqual([]);
  });

  describe('answer', () => {
    it('answer posts the decision to /api/mcp/confirm/<cardId>', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, state: 'allowed' }));
      vi.stubGlobal('fetch', fetchMock);
      useMcpConfirmStore.getState().apply(view());
      const out = await useMcpConfirmStore.getState().answer('card-1', 'allow');
      expect(out).toBe('ok');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/mcp/confirm/card-1');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ decision: 'allow' });
      expect(useMcpConfirmStore.getState().confirms).toEqual([]);
    });

    it('answer encodes the card id in the path', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
      vi.stubGlobal('fetch', fetchMock);
      await useMcpConfirmStore.getState().answer('a/b c', 'deny');
      expect(fetchMock.mock.calls[0][0]).toBe('/api/mcp/confirm/a%2Fb%20c');
    });

    it('answer 404 is gone and removes', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { ok: false })));
      useMcpConfirmStore.getState().apply(view());
      expect(await useMcpConfirmStore.getState().answer('card-1', 'deny')).toBe('gone');
      expect(useMcpConfirmStore.getState().confirms).toEqual([]);
    });

    it('answer 409 already-answered is gone and removes', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(409, { ok: false, error: 'already-answered' })));
      useMcpConfirmStore.getState().apply(view());
      expect(await useMcpConfirmStore.getState().answer('card-1', 'allow')).toBe('gone');
      expect(useMcpConfirmStore.getState().confirms).toEqual([]);
    });

    it('answer 500 is failed and keeps', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, {})));
      useMcpConfirmStore.getState().apply(view());
      expect(await useMcpConfirmStore.getState().answer('card-1', 'allow')).toBe('failed');
      expect(useMcpConfirmStore.getState().confirms).toHaveLength(1);
    });

    it('answer that cannot reach the server is failed and keeps', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
      useMcpConfirmStore.getState().apply(view());
      expect(await useMcpConfirmStore.getState().answer('card-1', 'allow')).toBe('failed');
      expect(useMcpConfirmStore.getState().confirms).toHaveLength(1);
    });
  });

  describe('load', () => {
    it('load reads the list and keeps only well-formed, live views', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse(200, {
            ok: true,
            confirms: [view(), { junk: 1 }, view({ cardId: 'old', expiresAt: NOW - 5 })],
          }),
        ),
      );
      await useMcpConfirmStore.getState().load();
      expect(useMcpConfirmStore.getState().confirms.map((c) => c.cardId)).toEqual(['card-1']);
    });

    it('load 404 leaves an empty list', async () => {
      useMcpConfirmStore.getState().apply(view());
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, {})));
      await useMcpConfirmStore.getState().load();
      expect(useMcpConfirmStore.getState().confirms).toEqual([]);
    });

    it('load keeps what it held when the server fails', async () => {
      useMcpConfirmStore.getState().apply(view());
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, {})));
      await useMcpConfirmStore.getState().load();
      expect(useMcpConfirmStore.getState().confirms).toHaveLength(1);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
      await useMcpConfirmStore.getState().load();
      expect(useMcpConfirmStore.getState().confirms).toHaveLength(1);
    });

    it('a card pushed while a read was in flight is not lost', async () => {
      let release: (r: Response) => void = () => undefined;
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((r) => (release = r))));
      const pending = useMcpConfirmStore.getState().load();
      useMcpConfirmStore.getState().apply(view({ cardId: 'live' }));
      release(jsonResponse(200, { ok: true, confirms: [] }));
      await pending;
      expect(useMcpConfirmStore.getState().confirms.map((c) => c.cardId)).toEqual(['live']);
    });
  });

  it('expired cards are not returned', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { confirms: [view({ expiresAt: NOW })] })));
    await useMcpConfirmStore.getState().load();
    expect(useMcpConfirmStore.getState().confirms).toEqual([]);
  });
});
