// chatApi.transport.test.ts — a chat read that loses its connection says so, and never hangs.
//
// Nov 7 2026: the phone's Chat sat under "Not up to date: The Mac sent an answer this phone
// can't read." while the session kept working. The Mac's pages were valid JSON; the phone's
// connection had dropped mid-answer (the log shows the socket going at the same moment), and
// a cut-off body was reported as an unreadable one. A read on a dead connection also had no
// end, and the chat's one-refresh-at-a-time lock swallowed every later poll behind it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_READ_TIMEOUT_MS, fetchChatPage } from './chatApi';

const page = { entries: [], before: null, after: 'c1', cli: 'claude', hasMore: false };

/** A 200 whose body stream fails, as WebKit's does when the connection drops mid-answer. */
function cutOff(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"success":true,"data":{"entr'));
      controller.error(new TypeError('The network connection was lost.'));
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** A fetch that never answers until its signal aborts, like a read on a dead TCP connection. */
const hangs = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
}));

/** Headers arrive, then the body stalls until the signal aborts (real fetch errors the body then). */
const stallsMidBody = vi.fn(async (_url: string, init?: RequestInit) => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"success":'));
      init?.signal?.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted.', 'AbortError')));
    },
  });
  return new Response(body, { status: 200 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  hangs.mockClear();
  stallsMidBody.mockClear();
});

describe('fetchChatPage over a failing connection', () => {
  it('reports an answer cut off in transit as a connection problem, not an unreadable answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => cutOff()));
    const r = await fetchChatPage('s1', { after: 'c0' });
    expect(r).toEqual({ ok: false, status: 0, message: expect.stringMatching(/Couldn’t reach your Mac/) });
  });

  it('gives up on a read that never answers, so the next refresh can run', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangs);
    const pending = fetchChatPage('s1', { after: 'c0' });
    await vi.advanceTimersByTimeAsync(CHAT_READ_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, status: 0, message: expect.stringMatching(/didn’t answer in time/) });
  });

  it('gives up on a body that stalls after the headers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', stallsMidBody);
    const pending = fetchChatPage('s1', { after: 'c0' });
    await vi.advanceTimersByTimeAsync(CHAT_READ_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, status: 0, message: expect.stringMatching(/didn’t answer in time/) });
  });

  it('still calls a whole answer that is not JSON unreadable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not the API</html>', { status: 200 })));
    const r = await fetchChatPage('s1');
    expect(r).toEqual({ ok: false, status: 200, message: 'The Mac sent an answer this phone can’t read.' });
  });

  it('still reads a good page, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: page }), { status: 200 })));
    const r = await fetchChatPage('s1');
    expect(r).toEqual({ ok: true, data: { ...page, entries: [] } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the caller's own abort on, as before", async () => {
    vi.stubGlobal('fetch', hangs);
    const caller = new AbortController();
    const pending = fetchChatPage('s1', {}, caller.signal);
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
