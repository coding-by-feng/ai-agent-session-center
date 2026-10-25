import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePhoneConfirmStore } from './phoneConfirmStore';
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

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('phoneConfirmStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    usePhoneConfirmStore.setState({ confirms: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('apply', () => {
    it('parse rejects a bad view and keeps what was held', () => {
      usePhoneConfirmStore.getState().apply(view());
      usePhoneConfirmStore.getState().apply({ cardId: 'broken' });
      usePhoneConfirmStore.getState().apply(null);
      expect(usePhoneConfirmStore.getState().confirms.map((c) => c.cardId)).toEqual(['card-1']);
    });

    it('copies the public fields only and ignores an already expired card', () => {
      usePhoneConfirmStore.getState().apply({ ...view(), confirmId: 'secret', fingerprint: 'fp' });
      expect(usePhoneConfirmStore.getState().confirms[0]).toEqual(view());
      usePhoneConfirmStore.getState().apply(view({ cardId: 'old', expiresAt: NOW - 1 }));
      expect(usePhoneConfirmStore.getState().confirms).toHaveLength(1);
    });

    it('holds a card once, oldest first, and never edits the held list', () => {
      const held = usePhoneConfirmStore.getState().confirms;
      usePhoneConfirmStore.getState().apply(view({ cardId: 'b', createdAt: NOW + 5 }));
      usePhoneConfirmStore.getState().apply(view({ cardId: 'a' }));
      usePhoneConfirmStore.getState().apply(view({ cardId: 'a', summary: 'newer words' }));
      const now = usePhoneConfirmStore.getState().confirms;
      expect(now.map((c) => c.cardId)).toEqual(['a', 'b']);
      expect(now[0].summary).toBe('newer words');
      expect(held).toEqual([]);
    });
  });

  it('resolved removes the card', () => {
    usePhoneConfirmStore.getState().apply(view());
    usePhoneConfirmStore.getState().resolved('card-1');
    expect(usePhoneConfirmStore.getState().confirms).toEqual([]);
  });

  it('prune drops the cards past their expiry', () => {
    usePhoneConfirmStore.getState().apply(view({ cardId: 'a', expiresAt: NOW + 1_000 }));
    usePhoneConfirmStore.getState().apply(view({ cardId: 'b' }));
    usePhoneConfirmStore.getState().prune(NOW + 1_000);
    expect(usePhoneConfirmStore.getState().confirms.map((c) => c.cardId)).toEqual(['b']);
  });

  describe('a deadline on the phone’s own clock (D-9)', () => {
    const MINUTE = 60_000;

    it('a phone 10 minutes behind the Mac keeps a card for the card’s own 5 minutes, not 15', () => {
      vi.setSystemTime(NOW - 10 * MINUTE);
      usePhoneConfirmStore.getState().apply(view());
      expect(usePhoneConfirmStore.getState().confirms[0].expiresAt).toBe(Date.now() + 5 * MINUTE);
      usePhoneConfirmStore.getState().prune(Date.now() + 5 * MINUTE - 1);
      expect(usePhoneConfirmStore.getState().confirms).toHaveLength(1);
      usePhoneConfirmStore.getState().prune(Date.now() + 5 * MINUTE);
      expect(usePhoneConfirmStore.getState().confirms).toEqual([]);
    });

    it('a phone 10 minutes ahead of the Mac still shows a card that just opened', () => {
      vi.setSystemTime(NOW + 10 * MINUTE);
      usePhoneConfirmStore.getState().apply(view());
      expect(usePhoneConfirmStore.getState().confirms).toHaveLength(1);
      expect(usePhoneConfirmStore.getState().confirms[0].expiresAt).toBe(Date.now() + 5 * MINUTE);
    });

    it('a card sent again keeps the deadline it got when it first arrived', () => {
      usePhoneConfirmStore.getState().apply(view());
      vi.setSystemTime(NOW + 2 * MINUTE);
      usePhoneConfirmStore.getState().apply(view({ summary: 'again' }));
      const held = usePhoneConfirmStore.getState().confirms[0];
      expect(held.summary).toBe('again');
      expect(held.expiresAt).toBe(NOW + 5 * MINUTE);
    });

    it('a read takes the time left from the Mac’s own clock (`now` in the answer), whatever the phone’s says', async () => {
      // Opened 4 minutes before the Mac answered the read; the phone's clock is an hour off.
      vi.setSystemTime(NOW + 60 * MINUTE);
      vi.stubGlobal('fetch', vi.fn(async () => json(200, { ok: true, now: NOW + 4 * MINUTE, confirms: [view()] })));
      await usePhoneConfirmStore.getState().load();
      expect(usePhoneConfirmStore.getState().confirms[0].expiresAt).toBe(Date.now() + MINUTE);
    });

    it('a read with no `now` counts the card’s whole time from its arrival; a held card keeps its deadline', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => json(200, { ok: true, confirms: [view({ cardId: 'read' })] })));
      vi.setSystemTime(NOW - 30 * MINUTE);
      await usePhoneConfirmStore.getState().load();
      expect(usePhoneConfirmStore.getState().confirms[0].expiresAt).toBe(Date.now() + 5 * MINUTE);
      const first = Date.now() + 5 * MINUTE;
      vi.setSystemTime(Date.now() + MINUTE);
      await usePhoneConfirmStore.getState().load();
      expect(usePhoneConfirmStore.getState().confirms[0].expiresAt).toBe(first);
    });
  });

  describe('load', () => {
    it('reads the phone route and keeps the live, valid views', async () => {
      const fetchMock = vi.fn(async () => json(200, {
        ok: true,
        confirms: [view(), { cardId: 'broken' }, view({ cardId: 'gone', expiresAt: NOW - 1 })],
      }));
      vi.stubGlobal('fetch', fetchMock);
      await usePhoneConfirmStore.getState().load();
      expect(fetchMock).toHaveBeenCalledWith('/api/phone-confirms');
      expect(usePhoneConfirmStore.getState().confirms.map((c) => c.cardId)).toEqual(['card-1']);
    });

    it('404 empties the list', async () => {
      usePhoneConfirmStore.getState().apply(view());
      vi.stubGlobal('fetch', vi.fn(async () => json(404, { ok: false })));
      await usePhoneConfirmStore.getState().load();
      expect(usePhoneConfirmStore.getState().confirms).toEqual([]);
    });

    it('any other failure changes nothing', async () => {
      usePhoneConfirmStore.getState().apply(view());
      vi.stubGlobal('fetch', vi.fn(async () => json(500, {})));
      await usePhoneConfirmStore.getState().load();
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
      await usePhoneConfirmStore.getState().load();
      expect(usePhoneConfirmStore.getState().confirms).toHaveLength(1);
    });

    it('a card that ended while the read was in flight is not brought back', async () => {
      let release: (r: Response) => void = () => undefined;
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
      const reading = usePhoneConfirmStore.getState().load();
      usePhoneConfirmStore.getState().resolved('card-1');
      release(json(200, { ok: true, confirms: [view()] }));
      await reading;
      expect(usePhoneConfirmStore.getState().confirms).toEqual([]);
    });

    it('a card pushed while the read was in flight is kept', async () => {
      let release: (r: Response) => void = () => undefined;
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
      const reading = usePhoneConfirmStore.getState().load();
      usePhoneConfirmStore.getState().apply(view({ cardId: 'pushed', createdAt: NOW + 1 }));
      release(json(200, { ok: true, confirms: [view()] }));
      await reading;
      expect(usePhoneConfirmStore.getState().confirms.map((c) => c.cardId)).toEqual(['card-1', 'pushed']);
    });
  });

  describe('answer', () => {
    it('answer posts the decision to the phone route', async () => {
      usePhoneConfirmStore.getState().apply(view({ cardId: 'a/b' }));
      const fetchMock = vi.fn(async () => json(200, { ok: true, state: 'allowed' }));
      vi.stubGlobal('fetch', fetchMock);
      expect(await usePhoneConfirmStore.getState().answer('a/b', 'allow')).toBe('ok');
      expect(fetchMock).toHaveBeenCalledWith('/api/phone-confirms/a%2Fb', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decision: 'allow' }),
      }));
      expect(usePhoneConfirmStore.getState().confirms).toEqual([]);
    });

    it('404 and 409 are gone and remove the card', async () => {
      for (const status of [404, 409]) {
        usePhoneConfirmStore.getState().apply(view());
        vi.stubGlobal('fetch', vi.fn(async () => json(status, {})));
        expect(await usePhoneConfirmStore.getState().answer('card-1', 'deny')).toBe('gone');
        expect(usePhoneConfirmStore.getState().confirms).toEqual([]);
      }
    });

    it('500, 403 and a network error are failed and keep the card', async () => {
      usePhoneConfirmStore.getState().apply(view());
      const makers: Array<() => Response> = [
        () => json(500, {}),
        () => json(403, {}),
        () => { throw new Error('offline'); },
      ];
      for (const make of makers) {
        vi.stubGlobal('fetch', vi.fn(async () => make()));
        expect(await usePhoneConfirmStore.getState().answer('card-1', 'allow')).toBe('failed');
        expect(usePhoneConfirmStore.getState().confirms).toHaveLength(1);
      }
    });
  });
});
