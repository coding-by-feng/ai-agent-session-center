// answerApi.test.ts — answering a waiting request from its card (AASC-43): the checked
// route, its refusals in words, and which ones leave only "Open terminal".
import { describe, it, expect, vi, afterEach } from 'vitest';
import { answerRequest } from './answerApi';

type Reply = { status: number; body?: unknown } | 'network';

function stubFetch(reply: Reply) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (reply === 'network') throw new TypeError('Failed to fetch');
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body ?? {} };
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('answerRequest', () => {
  it('posts the choice for that request only, never any text', async () => {
    const calls = stubFetch({ status: 202, body: { success: true, data: { accepted: true } } });
    expect(await answerRequest('s1', 'toolu_1', { choice: 'allow_once' })).toEqual({ ok: true });
    expect(calls[0].url).toBe('/api/sessions/s1/requests/toolu_1/answer');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ choice: 'allow_once' });
  });

  it('sends the option index for a question', async () => {
    const calls = stubFetch({ status: 202, body: { success: true } });
    await answerRequest('s 1', 'req/1', { choice: 'option', optionIndex: 2 });
    expect(calls[0].url).toBe('/api/sessions/s%201/requests/req%2F1/answer');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ choice: 'option', optionIndex: 2 });
  });

  it('a stale card hears that it was already answered on the Mac', async () => {
    stubFetch({ status: 409, body: { code: 'stale' } });
    const result = await answerRequest('s1', 'r', { choice: 'deny' });
    expect(result).toMatchObject({ ok: false, code: 'stale', message: 'Already answered on your Mac' });
  });

  it.each([
    [422, 'unknown_prompt'],
    [422, 'input_truncated'],
  ])('a %i %s leaves only "Open terminal"', async (status, code) => {
    stubFetch({ status, body: { code } });
    const result = await answerRequest('s1', 'r', { choice: 'allow_once' });
    expect(result).toMatchObject({ ok: false, code, terminalOnly: true });
  });

  // Oct 2026: no device holds a session any more, so a 423 only means the Mac didn't recognise the phone.
  it('says the phone wasn\'t recognised on control_held, never that another device drives', async () => {
    stubFetch({ status: 423, body: { code: 'control_held', driver: { label: 'MacBook', online: true } } });
    const result = await answerRequest('s1', 'r', { choice: 'allow_once' });
    expect(result).toMatchObject({ ok: false, code: 'control_held' });
    expect(result.ok === false && result.message).toBe('Your Mac didn’t recognise this phone. Reload the app and try again.');
  });

  it.each([
    [409, { code: 'no_terminal' }, 'no_terminal'],
    [409, { code: 'AGENT_NOT_RUNNING' }, 'agent_not_running'],
    [404, {}, 'not_found'],
    [429, { code: 'rate_limited', retryAfter: 20 }, 'rate_limited'],
    [400, { error: 'Invalid answer' }, 'invalid'],
    [500, {}, 'failed'],
  ])('reads a %i %j as %s, in plain words', async (status, body, code) => {
    stubFetch({ status, body });
    const result = await answerRequest('s1', 'r', { choice: 'deny' });
    expect(result).toMatchObject({ ok: false, code });
    expect(result.ok === false && result.message).not.toMatch(/PTY|baton|\d{3}/);
  });

  it('keeps how long to wait after too many answers', async () => {
    stubFetch({ status: 429, body: { code: 'rate_limited', retryAfter: 20 } });
    const result = await answerRequest('s1', 'r', { choice: 'deny' });
    expect(result.ok === false && result.retryAfter).toBe(20);
  });

  it('says so when the Mac cannot be reached', async () => {
    stubFetch('network');
    expect(await answerRequest('s1', 'r', { choice: 'deny' })).toMatchObject({ ok: false, code: 'network' });
  });
});
