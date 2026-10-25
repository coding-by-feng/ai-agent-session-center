// test/mcp/confirmPush.test.ts — the phone push for a central's confirmation (server/mcp/confirmPush.ts, Ruling P5-14):
// the existing phone push (`kind: 'approval'`) on the central's card, for a card a phone may answer, at most one per
// central per 30 s. A fake PushSink only: nothing here reaches the AASC backend or a phone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { createConfirmBook, CONFIRM_TTL_MS, type ConfirmBook, type PendingConfirm } from '../../server/mcp/confirm.js';
import { CONFIRM_PUSH_GAP_MS, startConfirmPush, type ConfirmPushDeps } from '../../server/mcp/confirmPush.js';
import type { PushMessage, PushSink } from '../../server/push/pushNotifier.js';
import { makeSession } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const T0 = 1_800_000_000_000;
const CENTRAL_SESSION = 'c0ffee00-1111-4222-8333-444455556666';
const TITLE = 'Central \u0007of the\nnight';

interface Rig {
  book: ConfirmBook;
  sent: PushMessage[];
  errors: string[];
  card: { session: Session | null };
  sink: { current: PushSink | null };
  answerable: { yes: boolean };
  stop: () => void;
}

const books: ConfirmBook[] = [];
const stops: Array<() => void> = [];

function rig(over: Partial<ConfirmPushDeps> = {}): Rig {
  const book = createConfirmBook();
  books.push(book);
  const sent: PushMessage[] = [];
  const errors: string[] = [];
  const card = { session: makeSession(CENTRAL_SESSION, { title: TITLE, remoteVisible: true }) as Session | null };
  const sink = {
    current: {
      notify: async (m: PushMessage) => {
        sent.push(m);
      },
    } as PushSink | null,
  };
  const answerable = { yes: true };
  const stop = startConfirmPush({
    book,
    mayPhoneAnswer: () => answerable.yes,
    centralCard: (id) => (id === 'central-1' ? card.session : null),
    sink: () => sink.current,
    now: () => Date.now(),
    onError: (m) => errors.push(m),
    ...over,
  });
  stops.push(stop);
  return { book, sent, errors, card, sink, answerable, stop };
}

const open = (book: ConfirmBook, over: { tool?: string; centralId?: string } = {}): PendingConfirm =>
  book.open({
    centralId: over.centralId ?? 'central-1',
    tool: over.tool ?? 'session_kill',
    risk: 'destructive',
    args: { sessionId: 'target-1', secret: 'arg-secret-71' },
    summary: 'Kill summary-secret-3',
    detail: 'detail-secret-9',
    targetSessionId: 'target-1',
    fingerprint: 'fp-secret-5',
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  for (const s of stops.splice(0)) s();
  for (const b of books.splice(0)) b.close();
  vi.useRealTimers();
});

describe('startConfirmPush', () => {
  it('a phone-answerable card sends one approval push on the central’s card', async () => {
    const r = rig();
    open(r.book);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.sent).toHaveLength(1);
    const m = r.sent[0];
    expect(m.kind).toBe('approval');
    expect(m.sessionRef).toBe(CENTRAL_SESSION);
    expect(m.title).toBe('Central of the night');
    expect(m.toolName).toBe('session_kill');
    expect(m.collapseKey).toBe(`mcp-confirm:${CENTRAL_SESSION}`.slice(0, 64));
    expect(m.collapseKey.length).toBeLessThanOrEqual(64);
    expect(m.mutationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a Mac-only tool’s card sends nothing', async () => {
    const r = rig();
    r.answerable.yes = false;
    open(r.book, { tool: 'history_delete' });
    await vi.advanceTimersByTimeAsync(CONFIRM_PUSH_GAP_MS * 2);
    expect(r.sent).toHaveLength(0);
  });

  it('a central card that is not shared, or muted, sends nothing', async () => {
    for (const over of [{ remoteVisible: false }, { remoteVisible: undefined }, { muted: true }]) {
      const r = rig();
      r.card.session = makeSession(CENTRAL_SESSION, { remoteVisible: true, ...over });
      open(r.book);
      await vi.advanceTimersByTimeAsync(0);
      expect(r.sent, JSON.stringify(over)).toHaveLength(0);
    }
    const none = rig();
    none.card.session = null;
    open(none.book);
    await vi.advanceTimersByTimeAsync(0);
    expect(none.sent).toHaveLength(0);
  });

  it('a central card whose id is not push-safe sends nothing', async () => {
    const r = rig();
    r.card.session = makeSession('bad id/with spaces', { remoteVisible: true });
    open(r.book);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.sent).toHaveLength(0);
  });

  it('no sink sends nothing and throws nothing', async () => {
    const r = rig();
    r.sink.current = null;
    expect(() => open(r.book)).not.toThrow();
    await vi.advanceTimersByTimeAsync(CONFIRM_PUSH_GAP_MS * 2);
    expect(r.sent).toHaveLength(0);
    expect(r.errors).toEqual([]);
  });

  it('two cards within 30 s send one push', async () => {
    const r = rig();
    open(r.book);
    await vi.advanceTimersByTimeAsync(5_000);
    const second = open(r.book, { tool: 'queue_clear' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.sent).toHaveLength(1);
    // The later card is batched: told once the 30 s are up, if it still waits.
    await vi.advanceTimersByTimeAsync(CONFIRM_PUSH_GAP_MS);
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1].collapseKey).toBe(r.sent[0].collapseKey);
    expect(r.sent[1].toolName).toBe('queue_clear');
    r.book.answer(second.cardId, 'deny');
  });

  it('a batched card answered before the 30 s are up sends nothing more', async () => {
    const r = rig();
    open(r.book);
    await vi.advanceTimersByTimeAsync(1_000);
    const second = open(r.book, { tool: 'queue_clear' });
    r.book.answer(second.cardId, 'allow');
    await vi.advanceTimersByTimeAsync(CONFIRM_PUSH_GAP_MS * 2);
    expect(r.sent).toHaveLength(1);
  });

  it('the newest batched card answered on the Mac: the push tells the newest one still waiting (D-7)', async () => {
    const r = rig();
    const a = open(r.book);
    await vi.advanceTimersByTimeAsync(5_000);
    const b = open(r.book, { tool: 'queue_clear' });
    await vi.advanceTimersByTimeAsync(5_000);
    const c = open(r.book, { tool: 'snippet_delete' });
    await vi.advanceTimersByTimeAsync(5_000);
    r.book.answer(c.cardId, 'deny');
    await vi.advanceTimersByTimeAsync(CONFIRM_PUSH_GAP_MS);
    expect(r.sent.map((m) => m.toolName)).toEqual(['session_kill', 'queue_clear']);
    r.book.answer(a.cardId, 'deny');
    r.book.answer(b.cardId, 'deny');
  });

  it('at the flush, a batched card a phone may no longer answer is passed over for an older one that it may', async () => {
    const notThePhones = new Set<string>();
    const r = rig({ mayPhoneAnswer: (card) => !notThePhones.has(card.tool) });
    const a = open(r.book);
    await vi.advanceTimersByTimeAsync(5_000);
    const b = open(r.book, { tool: 'queue_clear' });
    const c = open(r.book, { tool: 'snippet_delete' });
    expect(r.sent).toHaveLength(1);
    // c, the newest batched card, is no longer the phone's (its session was unshared).
    notThePhones.add('snippet_delete');
    await vi.advanceTimersByTimeAsync(CONFIRM_PUSH_GAP_MS);
    expect(r.sent.map((m) => m.toolName)).toEqual(['session_kill', 'queue_clear']);
    for (const card of [a, b, c]) r.book.answer(card.cardId, 'deny');
  });

  it('a card that was already pushed is not pushed again by a later batch', async () => {
    const r = rig();
    open(r.book);
    await vi.advanceTimersByTimeAsync(5_000);
    const b = open(r.book, { tool: 'queue_clear' });
    r.book.answer(b.cardId, 'deny');
    await vi.advanceTimersByTimeAsync(CONFIRM_PUSH_GAP_MS);
    // a still waits, but it was told already: nothing in the batch still waits.
    expect(r.sent).toHaveLength(1);
  });

  it('another central has its own 30 s', async () => {
    const other = makeSession('d00d0000-1111-4222-8333-444455556666', { remoteVisible: true });
    const r = rig({ centralCard: (id) => (id === 'central-2' ? other : makeSession(CENTRAL_SESSION, { remoteVisible: true })) });
    open(r.book);
    open(r.book, { centralId: 'central-2' });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.sent.map((m) => m.sessionRef)).toEqual([CENTRAL_SESSION, other.sessionId]);
  });

  it('ttl is the card’s remaining time, at most 300', async () => {
    const r = rig();
    open(r.book);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.sent[0].ttlSeconds).toBe(Math.min(300, CONFIRM_TTL_MS / 1000));
    await vi.advanceTimersByTimeAsync(1_000);
    open(r.book, { tool: 'queue_clear' });
    await vi.advanceTimersByTimeAsync(CONFIRM_PUSH_GAP_MS);
    expect(r.sent[1].ttlSeconds).toBeLessThanOrEqual(300 - 29);
    expect(r.sent[1].ttlSeconds).toBeGreaterThan(0);
  });

  it('the message holds no summary, detail, confirmId or cardId (key scan)', async () => {
    const r = rig();
    const card = open(r.book);
    await vi.advanceTimersByTimeAsync(0);
    const m = r.sent[0];
    expect(Object.keys(m).sort()).toEqual(['collapseKey', 'kind', 'mutationId', 'sessionRef', 'title', 'toolName', 'ttlSeconds']);
    const text = JSON.stringify(m);
    for (const secret of ['summary-secret', 'detail-secret', 'arg-secret', 'fp-secret', card.confirmId, card.cardId, 'target-1']) {
      expect(text).not.toContain(secret);
    }
  });

  it('a sink failure is logged without the title', async () => {
    const r = rig();
    r.sink.current = {
      notify: async () => {
        throw new Error('backend 503');
      },
    };
    open(r.book);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('backend 503');
    expect(r.errors[0]).not.toContain('Central');
    expect(r.errors[0]).not.toContain('night');
  });

  it('a sink that throws at once breaks nothing', async () => {
    const r = rig();
    r.sink.current = {
      notify: () => {
        throw new Error('sync boom');
      },
    };
    expect(() => open(r.book)).not.toThrow();
    expect(r.errors).toHaveLength(1);
  });

  it('the stop ends the listener and the batch timer', async () => {
    const r = rig();
    open(r.book);
    await vi.advanceTimersByTimeAsync(1_000);
    open(r.book, { tool: 'queue_clear' });
    r.stop();
    await vi.advanceTimersByTimeAsync(CONFIRM_PUSH_GAP_MS * 2);
    open(r.book, { tool: 'snippet_delete' });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.sent).toHaveLength(1);
  });
});
