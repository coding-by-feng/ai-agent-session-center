// promptApi.test.ts — the composer's prompt to the Mac (AASC-42): POST /prompt, the
// queue-image upload, the refusals in words, and polling what became of the prompt.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PROMPT_FAST_POLL_MS,
  PROMPT_POLL_TIMEOUT_MS,
  PROMPT_SLOW_POLL_INTERVAL_MS,
  newPromptKey,
  postPrompt,
  promptOutcome,
  sendPrompt,
  uploadPromptImages,
  waitForPrompt,
} from './promptApi';

type Reply = { status: number; body?: unknown } | 'network';

/** fetch answering each call with the next reply (the last one repeats). */
function stubFetch(...replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const reply = replies[Math.min(i++, replies.length - 1)];
    if (reply === 'network') throw new TypeError('Failed to fetch');
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body ?? {} };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const bodyOf = (call: { init?: RequestInit }) => JSON.parse(String(call.init?.body));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('newPromptKey', () => {
  it('is a fresh key the route accepts (8–64 of A–Z a–z 0–9 . _ : -)', () => {
    const a = newPromptKey();
    const b = newPromptKey();
    expect(a).not.toBe(b);
    for (const key of [a, b]) expect(key).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
  });
});

describe('postPrompt', () => {
  it('posts the text, image ids, mode and key, and hears back that it was accepted', async () => {
    const calls = stubFetch({ status: 202, body: { success: true, data: { accepted: true, key: 'k-12345678' } } });
    const result = await postPrompt('s1', { text: 'run the tests', images: ['img1'], mode: 'now', key: 'k-12345678' });
    expect(result).toEqual({ ok: true, key: 'k-12345678' });
    expect(calls[0].url).toBe('/api/sessions/s1/prompt');
    expect(calls[0].init?.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual({ text: 'run the tests', images: ['img1'], mode: 'now', key: 'k-12345678' });
  });

  it('leaves out an empty image list', async () => {
    const calls = stubFetch({ status: 202, body: { success: true, data: { accepted: true, key: 'k-12345678' } } });
    await postPrompt('s 1', { text: 'hi', images: [], mode: 'interrupt', key: 'k-12345678' });
    expect(calls[0].url).toBe('/api/sessions/s%201/prompt');
    expect(bodyOf(calls[0])).toEqual({ text: 'hi', mode: 'interrupt', key: 'k-12345678' });
  });

  it.each([
    [400, { code: 'needs_argument', error: 'x' }, 'needs_argument'],
    [400, { code: 'image_not_found', error: 'x' }, 'image_not_found'],
    [400, { error: 'text: Type a prompt' }, 'invalid'],
    [404, { error: 'Session not found' }, 'not_found'],
    [409, { code: 'AGENT_NOT_RUNNING' }, 'agent_not_running'],
    [409, { code: 'agent_not_ready' }, 'agent_not_ready'],
    [409, { code: 'awaiting_answer' }, 'awaiting_answer'],
    [409, { code: 'key_reused' }, 'key_reused'],
    [409, { code: 'busy' }, 'busy'],
    [423, { code: 'control_held', driver: { label: 'MacBook', online: true } }, 'control_held'],
    [429, { code: 'PHONE_PROMPT_LIMIT', retryAfter: 12 }, 'rate_limited'],
    [500, { error: 'boom' }, 'failed'],
  ])('reads a %i %j as %s, in plain words', async (status, body, code) => {
    stubFetch({ status, body });
    const result = await postPrompt('s1', { text: 'x', mode: 'now', key: 'k-12345678' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(code);
    expect(result.error.message).toMatch(/\S/);
    expect(result.error.message).not.toMatch(/PTY|baton|409|423/);
  });

  it('keeps who drives and how long to wait', async () => {
    stubFetch({ status: 423, body: { code: 'control_held', driver: { label: 'MacBook', online: true } } });
    const held = await postPrompt('s1', { text: 'x', mode: 'now', key: 'k-12345678' });
    expect(held.ok === false && held.error.driver).toEqual({ label: 'MacBook', online: true });
    expect(held.ok === false && held.error.message).toContain('MacBook');

    stubFetch({ status: 429, body: { code: 'PHONE_PROMPT_LIMIT', retryAfter: 12 } });
    const limited = await postPrompt('s1', { text: 'x', mode: 'now', key: 'k-12345678' });
    expect(limited.ok === false && limited.error.retryAfter).toBe(12);
  });

  it('says so when the Mac cannot be reached', async () => {
    stubFetch('network');
    const result = await postPrompt('s1', { text: 'x', mode: 'now', key: 'k-12345678' });
    expect(result.ok === false && result.error.code).toBe('network');
  });
});

describe('uploadPromptImages', () => {
  it('uploads the photos and hands back their ids', async () => {
    const calls = stubFetch({ status: 200, body: { ok: true, paths: ['/tmp/a.jpg'], ids: ['a.jpg'] } });
    const result = await uploadPromptImages([{ name: 'a.jpg', dataUrl: 'data:image/jpeg;base64,AAAA' }]);
    expect(result).toEqual({ ok: true, ids: ['a.jpg'] });
    expect(calls[0].url).toBe('/api/queue-images');
    expect(bodyOf(calls[0])).toEqual({ images: [{ name: 'a.jpg', dataUrl: 'data:image/jpeg;base64,AAAA' }] });
  });

  it('fails when the Mac kept fewer images than it was sent', async () => {
    stubFetch({ status: 200, body: { ok: true, paths: [], ids: [] } });
    const result = await uploadPromptImages([{ name: 'a.jpg', dataUrl: 'data:image/jpeg;base64,AAAA' }]);
    expect(result.ok).toBe(false);
  });

  it('sends nothing for no images', async () => {
    const calls = stubFetch({ status: 200, body: {} });
    expect(await uploadPromptImages([])).toEqual({ ok: true, ids: [] });
    expect(calls).toHaveLength(0);
  });
});

describe('sendPrompt', () => {
  it('uploads the images, then sends the prompt with their ids', async () => {
    const calls = stubFetch(
      { status: 200, body: { ok: true, paths: ['/tmp/a.png'], ids: ['a.png'] } },
      { status: 202, body: { success: true, data: { accepted: true, key: 'k' } } },
    );
    const result = await sendPrompt('s1', { text: 'look', images: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AA' }], mode: 'now' });
    expect(result.ok).toBe(true);
    expect(bodyOf(calls[1]).images).toEqual(['a.png']);
  });

  it('retries once with the SAME key when the Mac could not be reached (a repeat sends nothing twice)', async () => {
    const calls = stubFetch('network', { status: 202, body: { success: true, data: { accepted: true, key: 'k' } } });
    const result = await sendPrompt('s1', { text: 'hi', mode: 'now' });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0]).key).toBe(bodyOf(calls[1]).key);
  });

  it('takes a new key once when the old one was used for another prompt', async () => {
    const calls = stubFetch({ status: 409, body: { code: 'key_reused' } }, { status: 202, body: { success: true, data: { accepted: true, key: 'k' } } });
    const result = await sendPrompt('s1', { text: 'hi', mode: 'now' });
    expect(result.ok).toBe(true);
    expect(bodyOf(calls[0]).key).not.toBe(bodyOf(calls[1]).key);
  });

  it('uploads the images again once when the Mac lost them', async () => {
    const calls = stubFetch(
      { status: 200, body: { ok: true, paths: ['/tmp/a.png'], ids: ['a.png'] } },
      { status: 400, body: { code: 'image_not_found' } },
      { status: 200, body: { ok: true, paths: ['/tmp/b.png'], ids: ['b.png'] } },
      { status: 202, body: { success: true, data: { accepted: true, key: 'k' } } },
    );
    const result = await sendPrompt('s1', { text: 'look', images: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AA' }], mode: 'now' });
    expect(result.ok).toBe(true);
    expect(bodyOf(calls[3]).images).toEqual(['b.png']);
  });

  it('gives up with the reason on any other refusal', async () => {
    stubFetch({ status: 409, body: { code: 'busy' } });
    const result = await sendPrompt('s1', { text: 'hi', mode: 'now' });
    expect(result.ok === false && result.error.code).toBe('busy');
  });
});

describe('waitForPrompt', () => {
  const fastClock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };

  it('polls until the Mac says how the prompt ended', async () => {
    const calls = stubFetch(
      { status: 200, body: { success: true, data: { key: 'k', state: 'pending' } } },
      { status: 200, body: { success: true, data: { key: 'k', state: 'pending' } } },
      { status: 200, body: { success: true, data: { key: 'k', state: 'submitted' } } },
    );
    expect(await waitForPrompt('s1', 'k', fastClock())).toBe('submitted');
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe('/api/sessions/s1/prompt/k');
  });

  it('keeps polling through a dropped request', async () => {
    stubFetch('network', { status: 200, body: { success: true, data: { key: 'k', state: 'gave-up' } } });
    expect(await waitForPrompt('s1', 'k', fastClock())).toBe('gave-up');
  });

  it('stops at an unknown key (the Mac restarted)', async () => {
    stubFetch({ status: 404, body: {} });
    expect(await waitForPrompt('s1', 'k', fastClock())).toBe('unknown');
  });

  it('keeps asking as long as the Mac may still hold the prompt, slower after the first 90 s', async () => {
    // The Mac can hold an accepted prompt behind an earlier one (90 s) or while the
    // agent is busy (minutes): giving up sooner would invite a second send.
    expect(PROMPT_FAST_POLL_MS).toBe(90_000);
    expect(PROMPT_SLOW_POLL_INTERVAL_MS).toBe(5_000);
    expect(PROMPT_POLL_TIMEOUT_MS).toBe(5 * 60_000); // the Mac remembers a key this long
    const calls = stubFetch({ status: 200, body: { success: true, data: { key: 'k', state: 'pending' } } });
    const clock = fastClock();
    const onSlow = vi.fn();
    expect(await waitForPrompt('s1', 'k', { ...clock, onSlow })).toBe('timeout');
    expect(clock.now()).toBeGreaterThanOrEqual(PROMPT_POLL_TIMEOUT_MS);
    // ~90 polls a second apart, then ~42 five seconds apart.
    expect(calls.length).toBeGreaterThan(125);
    expect(calls.length).toBeLessThan(140);
    expect(onSlow).toHaveBeenCalledTimes(1);
  });

  it('still hears a late answer in the slow phase', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      const state = n > 100 ? 'submitted' : 'pending';
      return { ok: true, status: 200, json: async () => ({ success: true, data: { key: 'k', state } }) };
    }));
    expect(await waitForPrompt('s1', 'k', fastClock())).toBe('submitted');
  });

  it('stops when asked to, before or between polls', async () => {
    stubFetch({ status: 200, body: { success: true, data: { key: 'k', state: 'pending' } } });
    const before = new AbortController();
    before.abort();
    expect(await waitForPrompt('s1', 'k', { ...fastClock(), signal: before.signal })).toBe('aborted');

    const between = new AbortController();
    const clock = fastClock();
    const sleep = async (ms: number) => {
      await clock.sleep(ms);
      if (clock.now() > 10_000) between.abort();
    };
    const calls = stubFetch({ status: 200, body: { success: true, data: { key: 'k', state: 'pending' } } });
    expect(await waitForPrompt('s1', 'k', { now: clock.now, sleep, signal: between.signal })).toBe('aborted');
    expect(calls.length).toBeLessThan(15);
  });
});

describe('promptOutcome', () => {
  it('counts a submitted prompt, and a slash command sent once, as sent', () => {
    expect(promptOutcome('submitted').ok).toBe(true);
    expect(promptOutcome('unconfirmed').ok).toBe(true);
  });

  it.each(['stopped', 'gave-up', 'failed', 'timeout', 'unknown'] as const)('explains a %s prompt in plain words', (state) => {
    const outcome = promptOutcome(state);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/\S/);
    expect(outcome.message).not.toMatch(/PTY|hook|gave-up/);
  });

  it.each(['stopped', 'gave-up', 'failed'] as const)('a %s prompt surely went nowhere: its text may go back in the box', (state) => {
    expect(promptOutcome(state).unsure).toBe(false);
  });

  it.each(['timeout', 'unknown'] as const)('after %s the Mac may still send it: no text back, just "Check the chat"', (state) => {
    const outcome = promptOutcome(state);
    expect(outcome.unsure).toBe(true);
    expect(outcome.message).toMatch(/Check the chat/);
  });
});
