// test/mcp/confirm.test.ts — the confirmation book (server/mcp/confirm.ts): what a tool that asks the person waits on.
// Two ids per record (the central's confirmId, the Mac's cardId), its caps, its timers (fake), its waiters and the
// frozen copy of the call's arguments it keeps.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIRM_DETAIL_MAX,
  CONFIRM_FINGERPRINT_MAX,
  CONFIRM_SUMMARY_MAX,
  CONFIRM_TTL_MS,
  confirmSummaryOf,
  createConfirmBook,
  fingerprintOf,
  type ConfirmBook,
} from '../../server/mcp/confirm.js';
import { ToolError } from '../../server/mcp/types.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

let books: ConfirmBook[] = [];
const newBook = (): ConfirmBook => {
  const b = createConfirmBook();
  books.push(b);
  return b;
};

const ask = (centralId = 'c1', over: Record<string, unknown> = {}) => ({
  centralId,
  tool: 'demo_ask',
  risk: 'ask' as const,
  args: { id: 's1' },
  summary: 'rename a snippet',
  ...over,
});

const failureOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const b of books) b.close();
  books = [];
  vi.useRealTimers();
});

describe('the confirmation book', () => {
  it('opens with two different ids', () => {
    const b = newBook();
    const a = b.open(ask());
    const c = b.open(ask());

    expect(a.confirmId).not.toBe(a.cardId);
    expect(new Set([a.confirmId, a.cardId, c.confirmId, c.cardId]).size).toBe(4);
    expect(a).toMatchObject({ state: 'pending', consumed: false, decidedAt: null, centralId: 'c1', tool: 'demo_ask' });
    expect(a.expiresAt - a.createdAt).toBe(CONFIRM_TTL_MS);
  });

  it('summary and detail are cut to 300 and 2000 and token shapes blanked (scrubText)', () => {
    const b = newBook();
    const token = 'aasc_mcp_abcdefghijklmnop';
    const r = b.open(ask('c1', { summary: `use ${token} ${'x'.repeat(400)}`, detail: `line one ${token}\nline two\n${'y'.repeat(3_000)}` }));

    expect(r.summary.length).toBeLessThanOrEqual(CONFIRM_SUMMARY_MAX);
    expect(r.detail?.length).toBeLessThanOrEqual(CONFIRM_DETAIL_MAX);
    expect(JSON.stringify([r.summary, r.detail])).not.toContain(token);
    expect(r.summary).toContain('aasc_mcp_[redacted]');
    // The person judges the detail as written: its lines stay lines.
    expect(r.detail?.split('\n').slice(0, 2)).toEqual(['line one aasc_mcp_[redacted]', 'line two']);
    expect(b.open(ask('c1')).detail).toBeNull();
  });

  it('the detail shows every hidden character as a marker and keeps the spaces inside a line (A-I2)', () => {
    const b = newBook();
    const tag = String.fromCodePoint(0xe0041);
    const detail = ['run \u202Eevil\u202C now', 'zero\u200Bwidth\uFEFF and \u2066iso\u2069', `tag${tag}here`, 'steps:', '  - name: a', '      run: b'].join('\n');
    const r = b.open(ask('c1', { detail }));

    expect(r.detail?.split('\n')).toEqual([
      'run ⟨U+202E⟩evil⟨U+202C⟩ now',
      'zero⟨U+200B⟩width⟨U+FEFF⟩ and ⟨U+2066⟩iso⟨U+2069⟩',
      'tag⟨U+E0041⟩here',
      'steps:',
      '  - name: a',
      '      run: b',
    ]);
    // Nothing invisible reaches the view.
    expect(r.detail).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060\uFEFF\u{E0000}-\u{E007F}]/u);
  });

  it('every format character is a marker too: ALM, soft hyphen, invisible operators, Mongolian vowel separator (P3-38)', () => {
    const b = newBook();
    const r = b.open(ask('c1', { detail: 'a\u061Cb\u00ADc\u2061d\u2064e\u180Ef' }));

    expect(r.detail).toBe('a⟨U+061C⟩b⟨U+00AD⟩c⟨U+2061⟩d⟨U+2064⟩e⟨U+180E⟩f');
    expect(r.detail).not.toMatch(/\p{Cf}/u);
  });

  it('the detail still blanks token shapes, and the summary is still one flat line', () => {
    const b = newBook();
    const r = b.open(ask('c1', { summary: 'a   b\t c', detail: '  key: Bearer abcdef123456  \nok' }));

    expect(r.summary).toBe('a b c');
    expect(r.detail).toBe('  key: Bearer [redacted]  \nok');
  });

  it('a 4th pending for one central and a 21st overall are BUDGET', () => {
    const b = newBook();
    for (let i = 0; i < 3; i += 1) b.open(ask('c1'));
    expect(failureOf(() => b.open(ask('c1')))).toMatchObject({ code: 'BUDGET' });

    for (let i = 0; i < 17; i += 1) b.open(ask(`other-${Math.floor(i / 3)}`));
    expect(b.pending()).toHaveLength(20);
    expect(failureOf(() => b.open(ask('fresh')))).toMatchObject({ code: 'BUDGET' });

    // An answered one frees its place.
    b.answer(b.pending()[0].cardId, 'deny');
    expect(() => b.open(ask('fresh'))).not.toThrow();
  });

  it('answer allow resolves a waiter with allowed', async () => {
    const b = newBook();
    const r = b.open(ask());
    const waiting = b.wait(r.confirmId, 'c1', 45_000, new AbortController().signal);

    const answered = b.answer(r.cardId, 'allow');

    expect(answered).toMatchObject({ state: 'allowed', confirmId: r.confirmId });
    await expect(waiting).resolves.toBe('allowed');
  });

  it("answer on a decided card is 'decided', on an unknown or expired one 'gone'", () => {
    const b = newBook();
    const r = b.open(ask());
    b.answer(r.cardId, 'deny');
    expect(b.answer(r.cardId, 'allow')).toBe('decided');
    expect(b.answer('no-such-card', 'allow')).toBe('gone');
    // The central's id is not a card id.
    const other = b.open(ask());
    expect(b.answer(other.confirmId, 'allow')).toBe('gone');

    vi.advanceTimersByTime(CONFIRM_TTL_MS + 1);
    expect(b.answer(other.cardId, 'allow')).toBe('gone');
  });

  it('expires after 5 min as expired and tells onChange', async () => {
    const b = newBook();
    const seen: Array<[string, string]> = [];
    b.onChange((e) => seen.push([e.kind, e.confirm.state]));
    const r = b.open(ask());
    const waiting = b.wait(r.confirmId, 'c1', 50_000, new AbortController().signal);

    vi.advanceTimersByTime(CONFIRM_TTL_MS - 1);
    expect(b.forCentral(r.confirmId, 'c1')?.state).toBe('pending');
    vi.advanceTimersByTime(2);

    expect(b.forCentral(r.confirmId, 'c1')?.state).toBe('expired');
    expect(seen).toEqual([
      ['opened', 'pending'],
      ['resolved', 'expired'],
    ]);
    expect(b.pending()).toEqual([]);
    // The waiter had timed out at 50 s, before the expiry.
    await expect(waiting).resolves.toBe('pending');
  });

  it('wait returns pending at its timeout and caps the timeout at 50 s', async () => {
    const b = newBook();
    const r = b.open(ask());
    let state: string | null = null;
    void b.wait(r.confirmId, 'c1', 120_000, new AbortController().signal).then((s) => {
      state = s;
    });

    await vi.advanceTimersByTimeAsync(49_999);
    expect(state).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toBe('pending');
  });

  it('wait ends on abort', async () => {
    const b = newBook();
    const r = b.open(ask());
    const stop = new AbortController();
    const waiting = b.wait(r.confirmId, 'c1', 45_000, stop.signal);

    stop.abort();

    await expect(waiting).resolves.toBe('pending');
    // An aborted signal ends a new wait at once.
    await expect(b.wait(r.confirmId, 'c1', 45_000, stop.signal)).resolves.toBe('pending');
  });

  it('forCentral never returns another central’s record', async () => {
    const b = newBook();
    const r = b.open(ask('c1'));

    expect(b.forCentral(r.confirmId, 'c2')).toBeNull();
    expect(b.forCentral(undefined, 'c2')).toBeNull();
    expect(b.consume(r.confirmId, 'c2')).toBeNull();
    const err = await b.wait(r.confirmId, 'c2', 1_000, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('forCentral(undefined) gives the newest', () => {
    const b = newBook();
    b.open(ask('c1'));
    vi.advanceTimersByTime(10);
    const newest = b.open(ask('c1'));
    b.open(ask('c2'));

    expect(b.forCentral(undefined, 'c1')?.confirmId).toBe(newest.confirmId);
  });

  it('consume works once', () => {
    const b = newBook();
    const r = b.open(ask());
    expect(b.consume(r.confirmId, 'c1')).toBeNull(); // not allowed yet

    b.answer(r.cardId, 'allow');
    const used = b.consume(r.confirmId, 'c1');
    expect(used).toMatchObject({ confirmId: r.confirmId, consumed: true, state: 'allowed' });
    expect(b.consume(r.confirmId, 'c1')).toBeNull();

    const denied = b.open(ask());
    b.answer(denied.cardId, 'deny');
    expect(b.consume(denied.confirmId, 'c1')).toBeNull();
  });

  it('forgetCentral denies its pending ones', async () => {
    const b = newBook();
    const mine = b.open(ask('c1'));
    const theirs = b.open(ask('c2'));
    const waiting = b.wait(mine.confirmId, 'c1', 45_000, new AbortController().signal);

    b.forgetCentral('c1');

    // The central is told it was withdrawn; the record itself stays denied, the windows' word for it (A-M2).
    await expect(waiting).resolves.toBe('withdrawn');
    expect(b.forCentral(mine.confirmId, 'c1')).toMatchObject({ state: 'denied', withdrawn: true });
    expect(b.forCentral(theirs.confirmId, 'c2')).toMatchObject({ state: 'pending', withdrawn: false });
    expect(b.pending().map((p) => p.confirmId)).toEqual([theirs.confirmId]);
    expect(b.answer(mine.cardId, 'allow')).toBe('decided');
  });

  it('a person’s no is denied, not withdrawn', async () => {
    const b = newBook();
    const r = b.open(ask('c1'));
    b.answer(r.cardId, 'deny');

    expect(b.forCentral(r.confirmId, 'c1')).toMatchObject({ state: 'denied', withdrawn: false });
    await expect(b.wait(r.confirmId, 'c1', 1_000, new AbortController().signal)).resolves.toBe('denied');
  });

  it('args are a frozen copy: changing the caller’s object changes nothing', () => {
    const b = newBook();
    const args = { id: 's1', tags: ['a', 'b'], nested: { x: 1 } };
    const r = b.open(ask('c1', { args }));

    args.id = 'other';
    args.tags.push('c');
    args.nested.x = 2;

    expect(r.args).toEqual({ id: 's1', tags: ['a', 'b'], nested: { x: 1 } });
    expect(Object.isFrozen(r.args)).toBe(true);
    expect(Object.isFrozen(r.args.tags)).toBe(true);
    expect(Object.isFrozen(r.args.nested)).toBe(true);
  });

  it('keeps the fingerprint up to 200 as it is, a longer one as a digest of the whole, and null when there is none (P5-3)', () => {
    const b = newBook();
    const long = 'f'.repeat(CONFIRM_FINGERPRINT_MAX + 50);
    const sha = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

    expect(b.open(ask('c1', { fingerprint: 'term-w1|4242' })).fingerprint).toBe('term-w1|4242');
    expect(b.open(ask('c1', { fingerprint: 'g'.repeat(CONFIRM_FINGERPRINT_MAX) })).fingerprint).toBe('g'.repeat(CONFIRM_FINGERPRINT_MAX));
    expect(b.open(ask('c2', { fingerprint: long })).fingerprint).toBe(sha(long));
    expect(b.open(ask('c2')).fingerprint).toBeNull();
    expect(CONFIRM_FINGERPRINT_MAX).toBe(200);
  });

  it('keeps where the person answered: the Mac unless the phone is named, nothing when nobody answered (D-5)', () => {
    const b = newBook();
    const mac = b.open(ask('c1'));
    const phone = b.open(ask('c1'));
    const left = b.open(ask('c1'));
    const late = b.open(ask('c2'));
    b.answer(mac.cardId, 'allow');
    b.answer(phone.cardId, 'deny', 'phone');
    b.forgetCentral('c1');
    vi.advanceTimersByTime(CONFIRM_TTL_MS);

    expect(b.forCentral(mac.confirmId, 'c1')?.answeredOn).toBe('mac');
    expect(b.forCentral(phone.confirmId, 'c1')?.answeredOn).toBe('phone');
    expect(b.forCentral(left.confirmId, 'c1')?.answeredOn).toBeNull();
    expect(b.forCentral(late.confirmId, 'c2')).toMatchObject({ state: 'expired', answeredOn: null });
    expect(mac.answeredOn).toBeNull();
  });

  it('fingerprintOf: two long fingerprints that differ only past 200 differ', () => {
    const head = 'q'.repeat(CONFIRM_FINGERPRINT_MAX);
    expect(fingerprintOf(`${head}|a`)).not.toBe(fingerprintOf(`${head}|b`));
    expect(fingerprintOf(`${head}|a`)).toBe(fingerprintOf(`${head}|a`));
    expect(fingerprintOf(undefined)).toBeNull();
  });

  it('confirmSummaryOf is the summary as the book stores it', () => {
    const b = newBook();
    const raw = `rename   a\nsnippet ${'z'.repeat(CONFIRM_SUMMARY_MAX)}`;
    expect(b.open(ask('c1', { summary: raw })).summary).toBe(confirmSummaryOf(raw));
  });

  it('the fingerprint survives the answer and the consume', () => {
    const b = newBook();
    const r = b.open(ask('c1', { fingerprint: 'q1,q2,q3' }));
    b.answer(r.cardId, 'allow');

    expect(b.consume(r.confirmId, 'c1')?.fingerprint).toBe('q1,q2,q3');
    expect(b.forCentral(r.confirmId, 'c1')?.fingerprint).toBe('q1,q2,q3');
  });

  it('keeps a decided record 10 min, then forgets it, and close() clears every timer', () => {
    const b = newBook();
    const r = b.open(ask());
    b.answer(r.cardId, 'allow');

    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(b.forCentral(r.confirmId, 'c1')).not.toBeNull();
    vi.advanceTimersByTime(2);
    expect(b.forCentral(r.confirmId, 'c1')).toBeNull();

    b.open(ask());
    b.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
