import { describe, it, expect, vi } from 'vitest';
import {
  addCentralReplies, addTranscript, centralOnScreen, callEventEffect, formatDuration, parseCallRequest, parseProgress, requestCall, requestEnd,
  requestProgress, CALL_MESSAGES,
} from './voiceCall.js';
import type { HttpRequest, HttpRequester } from './http.js';

const line = { origin: 'http://100.64.0.2:3334', token: 'tok' };

function requester(status: number, data: unknown): HttpRequester & { last: () => HttpRequest } {
  const calls: HttpRequest[] = [];
  return {
    request: vi.fn(async (req: HttpRequest) => { calls.push(req); return { status, data }; }),
    last: () => calls[calls.length - 1],
  };
}

describe('parseCallRequest', () => {
  it('reads ?call=1 and a safe back path', () => {
    expect(parseCallRequest('?call=1&back=%2F%3Fsession%3Dabc')).toEqual({ back: '/?session=abc' });
    expect(parseCallRequest('?call=1')).toEqual({ back: '/' });
  });

  it('refuses a back that leaves the Mac', () => {
    expect(parseCallRequest('?call=1&back=https%3A%2F%2Fevil.example')).toEqual({ back: '/' });
    expect(parseCallRequest('?call=1&back=%2F%2Fevil.example')).toEqual({ back: '/' });
  });

  it('is null without call=1', () => {
    expect(parseCallRequest('?reauth=1')).toBeNull();
  });
});

describe('requestCall', () => {
  it('posts the offer with the session token and answers the call id and SDP', async () => {
    const http = requester(201, { success: true, data: { callId: 'call_1', sdp: 'v=0 answer' } });
    await expect(requestCall(http, line, 'v=0 offer')).resolves.toEqual({ ok: true, callId: 'call_1', sdp: 'v=0 answer' });
    expect(http.last()).toMatchObject({
      method: 'POST',
      url: 'http://100.64.0.2:3334/api/voice/call',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: { sdp: 'v=0 offer' },
    });
  });

  it("passes on the Mac's own reason for a refusal", async () => {
    const http = requester(409, { success: false, code: 'no_key', error: 'Add an OpenAI API key in Settings → Voice on this Mac.' });
    await expect(requestCall(http, line, 'x')).resolves.toEqual({ ok: false, message: 'Add an OpenAI API key in Settings → Voice on this Mac.' });
  });

  it('says the Mac needs an update when it has no voice route', async () => {
    const http = requester(404, null);
    await expect(requestCall(http, line, 'x')).resolves.toEqual({ ok: false, message: CALL_MESSAGES.oldMac });
  });

  it('says offline when the request fails', async () => {
    const http: HttpRequester = { request: vi.fn(async () => { throw new Error('down'); }) };
    await expect(requestCall(http, line, 'x')).resolves.toEqual({ ok: false, message: CALL_MESSAGES.offline });
  });

  it('refuses an answer without a call id or SDP', async () => {
    const http = requester(201, { success: true, data: { callId: 'c' } });
    await expect(requestCall(http, line, 'x')).resolves.toEqual({ ok: false, message: CALL_MESSAGES.failed });
  });
});

describe('requestEnd', () => {
  it('posts to the call end route, never throwing', async () => {
    const http = requester(200, {});
    await requestEnd(http, line, 'call_1');
    expect(http.last()).toMatchObject({ method: 'POST', url: 'http://100.64.0.2:3334/api/voice/call/call_1/end' });
    const broken: HttpRequester = { request: vi.fn(async () => { throw new Error('x'); }) };
    await expect(requestEnd(broken, line, 'call_1')).resolves.toBeUndefined();
  });
});

describe('callEventEffect', () => {
  it('reads transcript deltas, start and close from data-channel events', () => {
    expect(callEventEffect({ type: 'session.input_transcript.delta', delta: 'hi' })).toEqual({ kind: 'transcript', role: 'you', delta: 'hi' });
    expect(callEventEffect({ type: 'session.output_transcript.delta', delta: 'yo' })).toEqual({ kind: 'transcript', role: 'aasc', delta: 'yo' });
    expect(callEventEffect({ type: 'session.started' })).toEqual({ kind: 'started' });
    expect(callEventEffect({ type: 'session.closed', reason: 'expired' })).toEqual({ kind: 'closed', reason: 'expired' });
    expect(callEventEffect({ type: 'session.output_audio.delta' })).toBeNull();
    expect(callEventEffect(null)).toBeNull();
  });
});

describe('addTranscript', () => {
  it("joins one speaker's deltas and keeps the newest lines", () => {
    let lines = addTranscript([], 'you', 'What ');
    lines = addTranscript(lines, 'you', 'is up?');
    lines = addTranscript(lines, 'aasc', 'All good.');
    expect(lines).toEqual([{ role: 'you', text: 'What is up?' }, { role: 'aasc', text: 'All good.' }]);
    let many = lines;
    for (let i = 0; i < 50; i += 1) many = addTranscript(many, i % 2 ? 'you' : 'aasc', `t${i}`);
    expect(many.length).toBe(40);
  });
});

describe('formatDuration', () => {
  it('formats minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(252_000)).toBe('4:12');
    expect(formatDuration(3_725_000)).toBe('62:05');
  });
});

describe('requestProgress (Nov 22 2026)', () => {
  const view = {
    central: { title: 'Voice', state: 'working', step: 'Checking your sessions', elapsedMs: 5 },
    tasks: [{ title: 'AASC docs', state: 'working' }],
    replies: [{ at: 9, text: 'Done.' }],
  };

  it('reads the call’s progress with the session token', async () => {
    const http = requester(200, { success: true, data: view });
    await expect(requestProgress(http, line, 'call_1')).resolves.toEqual(view);
    expect(http.last()).toMatchObject({ method: 'GET', url: 'http://100.64.0.2:3334/api/voice/call/call_1/progress' });
    expect(http.last().headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('is null for a refusal, an old Mac, or a failed request', async () => {
    await expect(requestProgress(requester(404, {}), line, 'call_1')).resolves.toBeNull();
    const broken: HttpRequester = { request: vi.fn(async () => { throw new Error('x'); }) };
    await expect(requestProgress(broken, line, 'call_1')).resolves.toBeNull();
  });
});

describe('parseProgress', () => {
  it('keeps only well-formed parts', () => {
    expect(parseProgress({
      central: { title: 'Voice', state: 'sleeping', step: 3, elapsedMs: -4 },
      tasks: [{ title: 'ok', state: 'finished' }, { title: 5, state: 'working' }, { title: 'bad', state: 'nope' }],
      replies: [{ at: 1, text: 'hi' }, { at: 'x', text: 'no' }],
    })).toEqual({
      central: { title: 'Voice', state: 'working', step: null, elapsedMs: null },
      tasks: [{ title: 'ok', state: 'finished' }],
      replies: [{ at: 1, text: 'hi' }],
    });
    expect(parseProgress(null)).toBeNull();
    expect(parseProgress({ central: null, tasks: [], replies: [] })).toEqual({ central: null, tasks: [], replies: [] });
  });
});

describe('a reply\'s on-screen part (Nov 23 2026)', () => {
  it('parseProgress keeps a string screen part and drops anything else', () => {
    expect(parseProgress({ central: null, tasks: [], replies: [{ at: 1, text: 'hi', screen: '| a |\n| - |' }, { at: 2, text: 'x', screen: 7 }] })?.replies)
      .toEqual([{ at: 1, text: 'hi', screen: '| a |\n| - |' }, { at: 2, text: 'x' }]);
  });

  it('addCentralReplies carries it onto the Central line', () => {
    const { lines } = addCentralReplies([], [], [{ at: 9, text: 'Two changes.', screen: '- one\n- two' }]);
    expect(lines).toEqual([{ role: 'central', text: 'Two changes.', screen: '- one\n- two' }]);
  });
});

describe('centralOnScreen', () => {
  it('puts the elapsed time on this phone’s clock', () => {
    expect(centralOnScreen({ title: 'Voice', state: 'working', step: 'Thinking', elapsedMs: 3_000 }, 10_000))
      .toEqual({ title: 'Voice', state: 'working', step: 'Thinking', since: 7_000 });
    expect(centralOnScreen({ title: 'Voice', state: 'idle', step: null, elapsedMs: null }, 10_000)?.since).toBeNull();
    expect(centralOnScreen(null, 10_000)).toBeNull();
  });
});

describe('addCentralReplies', () => {
  it('adds each reply once, as a Central line, after what was said', () => {
    const said = addTranscript([], 'aasc', 'Let me check.');
    const first = addCentralReplies(said, [], [{ at: 9, text: 'v2.10.80 adds dictation.' }]);
    expect(first.lines).toEqual([{ role: 'aasc', text: 'Let me check.' }, { role: 'central', text: 'v2.10.80 adds dictation.' }]);
    expect(first.seen).toEqual([9]);
    const again = addCentralReplies(first.lines, first.seen, [{ at: 9, text: 'v2.10.80 adds dictation.' }]);
    expect(again.lines).toBe(first.lines);
  });

  it('starts a new voice line after a Central line, never joining across it', () => {
    const { lines } = addCentralReplies(addTranscript([], 'aasc', 'One.'), [], [{ at: 1, text: 'Reply.' }]);
    expect(addTranscript(lines, 'aasc', 'Two.').map((l) => l.role)).toEqual(['aasc', 'central', 'aasc']);
  });
});
