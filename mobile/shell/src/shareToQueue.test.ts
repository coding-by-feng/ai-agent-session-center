// shareToQueue.test.ts — AASC-21 M5: shared text lands in a session's queue, paused.
import { describe, it, expect, vi } from 'vitest';
import { prepareSharedText, prepareSharedImages, shareTargets, postSharedText, shareToQueue, SHARE_MAX_BYTES, SHARE_MESSAGES, SHARE_IMAGE_MAX_CHARS } from './shareToQueue';
import type { HttpRequest, HttpRequester } from './http';
import type { SessionLite } from './sessions';
import type { SessionResult } from './pairingClient';

const ORIGIN = 'http://100.101.102.103:3333';

function fakeHttp(answer: { status: number; data: unknown } | Error = { status: 200, data: { ok: true } }) {
  const calls: HttpRequest[] = [];
  const http: HttpRequester & { calls: HttpRequest[] } = {
    calls,
    async request(req) {
      calls.push(req);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return http;
}

function session(sessionId: string, status: SessionLite['status'], lastActivityAt: number, title = sessionId): SessionLite {
  return { sessionId, status, title, lastActivityAt, startedAt: 0, muted: false, hasInterruption: false };
}

describe('prepareSharedText', () => {
  it('trims and normalises line endings, keeping newlines and tabs', () => {
    expect(prepareSharedText('  line 1\r\nline 2\rline\t3\u2028end  ')).toEqual({ ok: true, text: 'line 1\nline 2\nline\t3\nend', bytes: 24 });
  });

  it('strips terminal escapes, control and bidi characters', () => {
    const r = prepareSharedText('\x1B[31mred\x1B[0m \x1B]0;title\x07ok\x00\x08 \u202Eabc\u202C\uFEFF');
    expect(r).toEqual({ ok: true, text: 'red ok abc', bytes: 10 });
  });

  it('removes invisible tag characters an agent would still read', () => {
    expect(prepareSharedText('summarise this\u{E0072}\u{E006D}\u{E0020}\u{E002D}\u{E0072}\u{E0066}')).toMatchObject({ ok: true, text: 'summarise this' });
  });

  it('refuses empty text and anything that is not text', () => {
    expect(prepareSharedText('  \n\t \x1B[0m ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(prepareSharedText(42)).toMatchObject({ ok: false, reason: 'not-text' });
  });

  it('accepts exactly 64 KB and refuses more, counting UTF-8 bytes, never cutting', () => {
    expect(prepareSharedText('a'.repeat(SHARE_MAX_BYTES))).toMatchObject({ ok: true, bytes: SHARE_MAX_BYTES });
    const over = prepareSharedText('a'.repeat(SHARE_MAX_BYTES + 1));
    expect(over).toMatchObject({ ok: false, reason: 'too-large' });
    expect(over.ok === false && over.message).toMatch(/65 KB.*64 KB.*Nothing was added/);
    // 3-byte characters: under the Mac's 65536-unit limit, over 64 KB of UTF-8.
    expect(prepareSharedText('\u4E2D'.repeat(30_000))).toMatchObject({ ok: false, reason: 'too-large' });
  });
});

describe('shareTargets', () => {
  it('lists live sessions, most recent first, the one used last on top', () => {
    const list = [session('a', 'idle', 10), session('b', 'working', 30), session('c', 'ended', 99), session('d', 'approval', 20)];
    expect(shareTargets(list).map((t) => t.sessionId)).toEqual(['b', 'd', 'a']);
    expect(shareTargets(list, 'a').map((t) => t.sessionId)).toEqual(['a', 'b', 'd']);
    expect(shareTargets(list, 'c').map((t) => t.sessionId)).toEqual(['b', 'd', 'a']);
    expect(shareTargets(list)[0]).toEqual({ sessionId: 'b', title: 'b', status: 'working' });
  });
});

describe('postSharedText', () => {
  it('appends with the session token and says it landed paused', async () => {
    const http = fakeHttp();
    expect(await postSharedText(http, ORIGIN, 'sess', 'abc-1', 'hello')).toEqual({ status: 'added', message: 'Added paused — turn it on in the queue to send' });
    expect(http.calls).toEqual([{ method: 'POST', url: `${ORIGIN}/api/sessions/abc-1/queue/items`, headers: { Authorization: 'Bearer sess', 'Content-Type': 'application/json' }, body: { text: 'hello' } }]);
  });

  it.each([
    [404, 'not-shared', SHARE_MESSAGES.notShared],
    [413, 'queue-full', SHARE_MESSAGES.queueFull],
    [400, 'invalid', 'The Mac refused this text. Nothing was added.'],
    [401, 'signed-out', 'Signed out of the Mac. Try again.'],
    [500, 'error', "Couldn't add it (500). Nothing was added."],
  ])('maps %i', async (status, kind, message) => {
    expect(await postSharedText(fakeHttp({ status, data: {} }), ORIGIN, 's', 'abc', 'x')).toEqual({ status: kind, message });
  });

  it('reports offline and never builds a URL from a bad id', async () => {
    expect(await postSharedText(fakeHttp(new Error('offline')), ORIGIN, 's', 'abc', 'x')).toEqual({ status: 'offline', message: SHARE_MESSAGES.offline });
    const http = fakeHttp();
    expect((await postSharedText(http, ORIGIN, 's', '../config', 'x')).status).toBe('not-shared');
    expect(http.calls).toHaveLength(0);
  });
});

describe('shareToQueue', () => {
  const ok = vi.fn(async (): Promise<SessionResult> => ({ status: 'ok', token: 'sess' }));

  it('cleans, signs in and appends the cleaned text', async () => {
    const http = fakeHttp();
    expect((await shareToQueue('  hi\r\n', 'abc', { http, origin: ORIGIN, signIn: ok })).status).toBe('added');
    expect(http.calls[0].body).toEqual({ text: 'hi' });
  });

  it('stops before the network on bad text or no reachable Mac', async () => {
    const http = fakeHttp();
    expect(await shareToQueue('   ', 'abc', { http, origin: ORIGIN, signIn: ok })).toMatchObject({ status: 'invalid' });
    expect(await shareToQueue('hi', 'abc', { http, origin: null, signIn: ok })).toEqual({ status: 'offline', message: SHARE_MESSAGES.offline });
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    [{ status: 'pending' }, 'pending'],
    [{ status: 'revoked' }, 'unpaired'],
    [{ status: 'unreachable' }, 'offline'],
    [{ status: 'error', message: 'Sign-in failed (500)' }, 'error'],
  ] as const)('explains a failed sign-in %j', async (result, status) => {
    const out = await shareToQueue('hi', 'abc', { http: fakeHttp(), origin: ORIGIN, signIn: async () => result });
    expect(out.status).toBe(status);
    expect(out.message).toMatch(/Nothing was added|Pair again/);
  });
});

describe('shared images (AASC-21 M5)', () => {
  const ok = async (): Promise<SessionResult> => ({ status: 'ok', token: 'sess' });
  // A minimal well-formed PNG (signature, IHDR, IEND): only real images get through.
  const pngBytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...new Array(13).fill(1), 0, 0, 0, 0,
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0,
  ]);
  const PNG_B64 = btoa(String.fromCharCode(...pngBytes));
  const PNG = { name: 'shot.png', mimeType: 'image/png', base64: PNG_B64 };

  it('sends images alone or with text, as data URLs with clean names', async () => {
    const http = fakeHttp();
    expect((await shareToQueue('', 'abc', { http, origin: ORIGIN, signIn: ok }, [{ ...PNG, name: 'a/../b.png' }])).status).toBe('added');
    expect(http.calls[0].body).toEqual({ images: [{ name: 'a..b.png', dataUrl: `data:image/png;base64,${PNG_B64}` }] });
    await shareToQueue('look at this', 'abc', { http, origin: ORIGIN, signIn: ok }, [PNG]);
    expect(http.calls[1].body).toMatchObject({ text: 'look at this', images: [{ name: 'shot.png' }] });
  });

  it('refuses what the Mac would refuse, before the network', async () => {
    const http = fakeHttp();
    for (const images of [
      [{ ...PNG, mimeType: 'image/svg+xml' }],
      [{ ...PNG, mimeType: 'image/heic' }],
      [{ ...PNG, base64: 'not base64!' }],
      Array.from({ length: 5 }, () => PNG),
      [{ ...PNG, base64: 'A'.repeat(SHARE_IMAGE_MAX_CHARS) }],
    ]) {
      const out = await shareToQueue('hi', 'abc', { http, origin: ORIGIN, signIn: ok }, images);
      expect(out.status).toBe('invalid');
      expect(out.message).toMatch(/Nothing was added/);
    }
    expect(http.calls).toHaveLength(0);
  });

  it('names an unnamed image and checks the total size', () => {
    const named = prepareSharedImages([{ mimeType: 'image/png', base64: PNG_B64 }]);
    expect(named).toEqual({ ok: true, images: [{ name: 'shared-image-1', dataUrl: `data:image/png;base64,${PNG_B64}` }] });
    expect(prepareSharedImages([{ mimeType: 'image/jpeg', base64: 'AAAA' }])).toMatchObject({ ok: false });
    const big = 'A'.repeat(2_500_000);
    expect(prepareSharedImages([1, 2, 3].map(() => ({ mimeType: 'image/png', base64: big })))).toMatchObject({ ok: false });
  });
});
