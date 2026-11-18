import { describe, it, expect, vi } from 'vitest';
import {
  DICTATION_EVENT, DICTATION_HANDLER, dictationBridge, insertDictation, readDictationOutcome, requestTranscript,
  type DictationOutcome,
} from './phoneDictation';

function iosWindow() {
  const postMessage = vi.fn();
  const target = new EventTarget();
  const win = Object.assign(target, { webkit: { messageHandlers: { [DICTATION_HANDLER]: { postMessage } } } });
  return { win: win as unknown as Window, postMessage, target };
}

function androidWindow() {
  const port = Object.assign(new EventTarget(), { postMessage: vi.fn() });
  const win = Object.assign(new EventTarget(), { [DICTATION_HANDLER]: port });
  return { win: win as unknown as Window, port };
}

describe('dictationBridge', () => {
  it('is null in a browser and in an app without the bridge', () => {
    expect(dictationBridge(new EventTarget() as unknown as Window)).toBeNull();
    expect(dictationBridge(Object.assign(new EventTarget(), { webkit: { messageHandlers: {} } }) as unknown as Window)).toBeNull();
    expect(dictationBridge(Object.assign(new EventTarget(), { [DICTATION_HANDLER]: {} }) as unknown as Window)).toBeNull();
  });

  it('iOS: posts an object and hears the window event', () => {
    const { win, postMessage, target } = iosWindow();
    const bridge = dictationBridge(win)!;
    bridge.post('d1', 'start');
    expect(postMessage).toHaveBeenCalledWith({ id: 'd1', action: 'start' });
    const heard: DictationOutcome[] = [];
    const stop = bridge.listen((o) => heard.push(o));
    target.dispatchEvent(new CustomEvent(DICTATION_EVENT, { detail: { id: 'd1', state: 'recording' } }));
    target.dispatchEvent(new CustomEvent(DICTATION_EVENT, { detail: { id: 'd1', state: 'nonsense' } }));
    expect(heard).toEqual([{ id: 'd1', state: 'recording' }]);
    stop();
    target.dispatchEvent(new CustomEvent(DICTATION_EVENT, { detail: { id: 'd1', state: 'cancelled' } }));
    expect(heard).toHaveLength(1);
  });

  it('Android: posts a JSON string and hears the port’s messages', () => {
    const { win, port } = androidWindow();
    const bridge = dictationBridge(win)!;
    bridge.post('d2', 'stop');
    expect(port.postMessage).toHaveBeenCalledWith(JSON.stringify({ id: 'd2', action: 'stop' }));
    const heard: DictationOutcome[] = [];
    const stop = bridge.listen((o) => heard.push(o));
    port.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 'd2', state: 'permission', granted: true }) }));
    port.dispatchEvent(new MessageEvent('message', { data: 'not json' }));
    port.dispatchEvent(new MessageEvent('message', { data: { id: 'd2', state: 'recording' } }));
    expect(heard).toEqual([{ id: 'd2', state: 'permission', granted: true }]);
    stop();
    port.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 'd2', state: 'cancelled' }) }));
    expect(heard).toHaveLength(1);
  });
});

describe('readDictationOutcome', () => {
  it('reads each state', () => {
    expect(readDictationOutcome({ id: 'a', state: 'recording' })).toEqual({ id: 'a', state: 'recording' });
    expect(readDictationOutcome({ id: 'a', state: 'permission', granted: false })).toEqual({ id: 'a', state: 'permission', granted: false });
    expect(readDictationOutcome({ id: 'a', state: 'cancelled', short: true })).toEqual({ id: 'a', state: 'cancelled', short: true });
    expect(readDictationOutcome({ id: 'a', state: 'cancelled' })).toEqual({ id: 'a', state: 'cancelled', short: false });
    expect(readDictationOutcome({ id: 'a', state: 'failed', message: 'x'.repeat(500) })).toEqual({ id: 'a', state: 'failed', message: 'x'.repeat(200) });
    expect(readDictationOutcome({ id: 'a', state: 'audio', audio: 'QUJD', mime: 'audio/mp4', ms: 1500 }))
      .toEqual({ id: 'a', state: 'audio', audio: 'QUJD', mime: 'audio/mp4', ms: 1500 });
  });

  it('drops anything malformed', () => {
    expect(readDictationOutcome(null)).toBeNull();
    expect(readDictationOutcome('recording')).toBeNull();
    expect(readDictationOutcome({ state: 'recording' })).toBeNull();
    expect(readDictationOutcome({ id: 7, state: 'recording' })).toBeNull();
    expect(readDictationOutcome({ id: 'a', state: 'permission' })).toBeNull();
    expect(readDictationOutcome({ id: 'a', state: 'audio', audio: '', mime: 'audio/mp4', ms: 1 })).toBeNull();
    expect(readDictationOutcome({ id: 'a', state: 'audio', audio: 'QUJD', ms: 1 })).toBeNull();
  });
});

describe('requestTranscript', () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('posts the clip as JSON to the Mac and answers the text', async () => {
    const fetchFn = vi.fn(async () => ok({ success: true, data: { text: 'hello there' } }));
    const result = await requestTranscript('QUJD', 'audio/mp4', fetchFn);
    expect(result).toEqual({ ok: true, text: 'hello there' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/voice/dictate');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ audio: 'QUJD', mime: 'audio/mp4' });
  });

  it('passes on the Mac’s own words for a refusal', async () => {
    const fetchFn = vi.fn(async () => ok({ success: false, code: 'no_key', error: 'Add an OpenAI API key in Settings → Voice on the Mac to dictate.' }, 409));
    expect(await requestTranscript('QUJD', 'audio/mp4', fetchFn)).toEqual({
      ok: false, code: 'no_key', message: 'Add an OpenAI API key in Settings → Voice on the Mac to dictate.',
    });
  });

  it('a Mac from before dictation answers 404: says to update it', async () => {
    const fetchFn = vi.fn(async () => new Response('Not found', { status: 404 }));
    const result = await requestTranscript('QUJD', 'audio/mp4', fetchFn);
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    expect((result as { message: string }).message).toMatch(/update/i);
  });

  it('an unreachable Mac is said plainly', async () => {
    const fetchFn = vi.fn(async () => { throw new TypeError('Load failed'); });
    expect(await requestTranscript('QUJD', 'audio/mp4', fetchFn)).toMatchObject({ ok: false, code: 'offline' });
  });

  it('a 200 without text is a failure, not an empty answer', async () => {
    const fetchFn = vi.fn(async () => ok({ success: true, data: {} }));
    expect(await requestTranscript('QUJD', 'audio/mp4', fetchFn)).toMatchObject({ ok: false, code: 'failed' });
  });
});

describe('insertDictation', () => {
  it('fills an empty box', () => {
    expect(insertDictation('', null, 'fix the login bug')).toEqual({ text: 'fix the login bug', caret: 17 });
  });

  it('appends after a space when the box ends in a word', () => {
    expect(insertDictation('First.', null, 'Then the tests')).toEqual({ text: 'First. Then the tests', caret: 21 });
  });

  it('adds no second space or space after a new line', () => {
    expect(insertDictation('First. ', null, 'Then').text).toBe('First. Then');
    expect(insertDictation('First.\n', null, 'Then').text).toBe('First.\nThen');
  });

  it('inserts at the caret, spaced on both sides', () => {
    expect(insertDictation('run tests', 3, 'all the')).toEqual({ text: 'run all the tests', caret: 11 });
  });

  it('adds no spaces around Chinese', () => {
    expect(insertDictation('修复登录', null, '然后跑测试').text).toBe('修复登录然后跑测试');
    expect(insertDictation('修复', null, 'login bug').text).toBe('修复login bug');
  });

  it('adds no space before closing punctuation or after an opening bracket', () => {
    expect(insertDictation('see (', null, 'the docs').text).toBe('see (the docs');
    expect(insertDictation('done', 4, ', then more').text).toBe('done, then more');
  });

  it('a caret past the end appends', () => {
    expect(insertDictation('abc', 99, 'def').text).toBe('abc def');
  });
});
