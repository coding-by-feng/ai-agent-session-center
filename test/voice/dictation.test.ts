import { describe, it, expect, vi } from 'vitest';
import {
  transcribeAudio, audioFileName, TRANSCRIBE_MODEL, TRANSCRIBE_URL, TEXT_MAX,
} from '../../server/voice/dictation.js';
import { LiveApiError } from '../../server/voice/liveApi.js';

const KEY = 'sk-proj-secret-key-value-1234567890';
const AUDIO = Buffer.from('not really audio, but bytes all the same');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('audioFileName', () => {
  it.each([
    ['audio/mp4', 'dictation.m4a'],
    ['audio/m4a', 'dictation.m4a'],
    ['audio/x-m4a', 'dictation.m4a'],
    ['audio/webm', 'dictation.webm'],
    ['audio/wav', 'dictation.wav'],
    ['audio/ogg', 'dictation.ogg'],
    ['audio/mpeg', 'dictation.mp3'],
  ])('%s is sent as %s', (mime, name) => {
    expect(audioFileName(mime)).toBe(name);
  });

  it('knows no other type', () => {
    expect(audioFileName('video/mp4')).toBeNull();
    expect(audioFileName('audio/mp4; codecs=evil')).toBeNull();
    expect(audioFileName('')).toBeNull();
  });
});

describe('transcribeAudio', () => {
  it('posts the clip as a multipart file with the model, and answers the text', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { text: '  fix the login bug  ' }));
    const text = await transcribeAudio({ apiKey: KEY, audio: AUDIO, mime: 'audio/mp4' }, fetchImpl);
    expect(text).toBe('fix the login bug');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TRANSCRIBE_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    // fetch sets the multipart boundary itself: no Content-Type of ours.
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    const form = init.body as FormData;
    expect(form.get('model')).toBe(TRANSCRIBE_MODEL);
    expect(form.get('response_format')).toBe('json');
    const file = form.get('file') as File;
    expect(file.name).toBe('dictation.m4a');
    expect(file.type).toBe('audio/mp4');
    expect(Buffer.from(await file.arrayBuffer()).equals(AUDIO)).toBe(true);
  });

  it('answers an empty string when nothing was heard', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { text: '   ' }));
    expect(await transcribeAudio({ apiKey: KEY, audio: AUDIO, mime: 'audio/mp4' }, fetchImpl)).toBe('');
  });

  it('caps a runaway answer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { text: 'a'.repeat(TEXT_MAX + 500) }));
    const text = await transcribeAudio({ apiKey: KEY, audio: AUDIO, mime: 'audio/mp4' }, fetchImpl);
    expect(text.length).toBe(TEXT_MAX);
  });

  it('strips control characters, keeping new lines', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { text: 'one\u0007\u001b[31m\ntwo\u0000' }));
    expect(await transcribeAudio({ apiKey: KEY, audio: AUDIO, mime: 'audio/mp4' }, fetchImpl)).toBe('one[31m\ntwo');
  });

  it.each([
    [401, 'key'],
    [403, 'access'],
    [429, 'rate'],
    [400, 'bad_request'],
    [500, 'upstream'],
  ] as const)('maps HTTP %i to %s, never echoing the key', async (status, reason) => {
    const fetchImpl = vi.fn(async () => jsonResponse(status, { error: { message: `bad ${KEY}` } }));
    const err = await transcribeAudio({ apiKey: KEY, audio: AUDIO, mime: 'audio/mp4' }, fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiveApiError);
    expect((err as LiveApiError).reason).toBe(reason);
    expect((err as LiveApiError).message).not.toContain(KEY);
  });

  it('maps a network failure to network', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const err = await transcribeAudio({ apiKey: KEY, audio: AUDIO, mime: 'audio/mp4' }, fetchImpl).catch((e: unknown) => e);
    expect((err as LiveApiError).reason).toBe('network');
  });

  it('refuses a 200 without text, and a type it does not know', async () => {
    const noText = vi.fn(async () => jsonResponse(200, { words: [] }));
    const err = await transcribeAudio({ apiKey: KEY, audio: AUDIO, mime: 'audio/mp4' }, noText).catch((e: unknown) => e);
    expect((err as LiveApiError).reason).toBe('upstream');
    const never = vi.fn(async () => jsonResponse(200, { text: 'x' }));
    const bad = await transcribeAudio({ apiKey: KEY, audio: AUDIO, mime: 'video/mp4' }, never).catch((e: unknown) => e);
    expect((bad as LiveApiError).reason).toBe('bad_request');
    expect(never).not.toHaveBeenCalled();
  });
});
