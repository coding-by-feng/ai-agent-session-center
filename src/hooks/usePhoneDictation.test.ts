import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AUDIO_WAIT_MS, NOTE_MS, usePhoneDictation } from './usePhoneDictation';
import type { DictationBridge, DictationOutcome, TranscriptResult } from '@/lib/phoneDictation';

function fakeBridge() {
  let listener: ((o: DictationOutcome) => void) | null = null;
  const post = vi.fn();
  const bridge: DictationBridge = {
    post,
    listen: (l) => {
      listener = l;
      return () => { listener = null; };
    },
  };
  return { bridge, post, say: (o: DictationOutcome) => act(() => listener?.(o)), listening: () => listener !== null };
}

function setup(transcribe: (audio: string, mime: string) => Promise<TranscriptResult> = async () => ({ ok: true, text: 'fix the login bug' })) {
  const app = fakeBridge();
  const onText = vi.fn();
  let n = 0;
  const transcribeFn = vi.fn(transcribe);
  const view = renderHook(() => usePhoneDictation(onText, { bridge: app.bridge, transcribe: transcribeFn, newId: () => `d${(n += 1)}` }));
  return { ...app, onText, transcribe: transcribeFn, view, result: view.result };
}

const CLIP: DictationOutcome = { id: 'd1', state: 'audio', audio: 'QUJD', mime: 'audio/mp4', ms: 1800 };

describe('usePhoneDictation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is unavailable without the app’s recorder, and does nothing', () => {
    const onText = vi.fn();
    const { result } = renderHook(() => usePhoneDictation(onText, { bridge: null }));
    expect(result.current.available).toBe(false);
    act(() => result.current.start());
    expect(result.current.phase).toBe('idle');
  });

  it('hold, let go, and the words reach the box', async () => {
    const { result, post, say, onText, transcribe } = setup();
    expect(result.current.available).toBe(true);
    act(() => result.current.start());
    expect(post).toHaveBeenLastCalledWith('d1', 'start');
    expect(result.current.phase).toBe('recording');
    expect(result.current.line?.text).toMatch(/Listening/);
    say({ id: 'd1', state: 'recording' });
    act(() => result.current.stop());
    expect(post).toHaveBeenLastCalledWith('d1', 'stop');
    expect(result.current.phase).toBe('transcribing');
    expect(result.current.line?.text).toMatch(/text/i);
    say(CLIP);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(transcribe).toHaveBeenCalledWith('QUJD', 'audio/mp4', expect.anything());
    expect(onText).toHaveBeenCalledWith('fix the login bug');
    expect(result.current.phase).toBe('idle');
    expect(result.current.line).toBeNull();
  });

  it('a second press while one is running is ignored', () => {
    const { result, post } = setup();
    act(() => result.current.start());
    act(() => result.current.start());
    expect(post).toHaveBeenCalledTimes(1);
    act(() => result.current.stop());
    act(() => result.current.start());
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith('d1', 'stop');
  });

  it('the phone asked for the microphone: nothing recorded, and it says what to do next', () => {
    const { result, say, onText } = setup();
    act(() => result.current.start());
    say({ id: 'd1', state: 'permission', granted: true });
    expect(result.current.phase).toBe('idle');
    expect(result.current.line).toEqual({ text: expect.stringMatching(/Hold/) });
    act(() => result.current.stop());
    expect(result.current.phase).toBe('idle');
    act(() => result.current.start());
    say({ id: 'd2', state: 'permission', granted: false });
    expect(result.current.line).toEqual({ text: expect.stringMatching(/Settings/), tone: 'error' });
    expect(onText).not.toHaveBeenCalled();
  });

  it('the microphone question ends the hold first: its late answer still says what to do', () => {
    const { result, say } = setup();
    act(() => result.current.start());
    // The system sheet took the touch: the page lets go, and the app has nothing recording.
    act(() => result.current.stop());
    say({ id: 'd1', state: 'cancelled', short: false });
    expect(result.current.phase).toBe('idle');
    expect(result.current.line).toBeNull();
    say({ id: 'd1', state: 'permission', granted: true });
    expect(result.current.line).toEqual({ text: expect.stringMatching(/Hold/) });
    // Said once, and never for a recording older than the latest.
    act(() => result.current.dismiss());
    say({ id: 'd1', state: 'permission', granted: true });
    expect(result.current.line).toBeNull();
  });

  it('a late microphone answer is dropped once another recording has started', () => {
    const { result, say } = setup();
    act(() => result.current.start());
    act(() => result.current.cancel());
    act(() => result.current.start());
    say({ id: 'd1', state: 'permission', granted: false });
    expect(result.current.phase).toBe('recording');
    expect(result.current.line?.text).toMatch(/Listening/);
  });

  it('let go too soon: a hint, no request', async () => {
    const { result, say, transcribe } = setup();
    act(() => result.current.start());
    act(() => result.current.stop());
    say({ id: 'd1', state: 'cancelled', short: true });
    expect(result.current.phase).toBe('idle');
    expect(result.current.line?.text).toMatch(/Hold/);
    expect(result.current.line?.tone).toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTE_MS); });
    expect(result.current.line).toBeNull();
  });

  it('nothing heard: says so and leaves the box alone', async () => {
    const { result, say, onText } = setup(async () => ({ ok: true, text: '' }));
    act(() => result.current.start());
    act(() => result.current.stop());
    say(CLIP);
    // Not runOnlyPendingTimers: that would also run the hint's own clearing timer.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(onText).not.toHaveBeenCalled();
    expect(result.current.line?.text).toMatch(/catch/);
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTE_MS); });
    expect(result.current.line).toBeNull();
  });

  it('the Mac’s refusal is shown in its own words and stays', async () => {
    const { result, say, onText } = setup(async () => ({ ok: false, code: 'no_key', message: 'Add an OpenAI API key in Settings → Voice on the Mac to dictate.' }));
    act(() => result.current.start());
    act(() => result.current.stop());
    say(CLIP);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(result.current.line).toEqual({ text: 'Add an OpenAI API key in Settings → Voice on the Mac to dictate.', tone: 'error' });
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTE_MS * 3); });
    expect(result.current.line?.tone).toBe('error');
    expect(onText).not.toHaveBeenCalled();
    act(() => result.current.dismiss());
    expect(result.current.line).toBeNull();
  });

  it('a recording the app failed is an error line', () => {
    const { result, say } = setup();
    act(() => result.current.start());
    say({ id: 'd1', state: 'failed', message: 'The microphone is in use.' });
    expect(result.current.phase).toBe('idle');
    expect(result.current.line).toEqual({ text: 'The microphone is in use.', tone: 'error' });
  });

  it('the app reaching its two-minute limit hands the clip over without a stop', async () => {
    const { result, say, onText } = setup();
    act(() => result.current.start());
    say(CLIP);
    expect(result.current.phase).toBe('transcribing');
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(onText).toHaveBeenCalledWith('fix the login bug');
    // The finger lifting afterwards is not a new stop.
    act(() => result.current.stop());
    expect(result.current.phase).toBe('idle');
  });

  it('answers about another recording are ignored', () => {
    const { result, say } = setup();
    act(() => result.current.start());
    say({ id: 'someone-else', state: 'failed', message: 'x' });
    expect(result.current.phase).toBe('recording');
  });

  it('no clip after letting go: gives up and says so', async () => {
    const { result, say, transcribe } = setup();
    act(() => result.current.start());
    act(() => result.current.stop());
    await act(async () => { await vi.advanceTimersByTimeAsync(AUDIO_WAIT_MS); });
    expect(result.current.phase).toBe('idle');
    expect(result.current.line?.tone).toBe('error');
    // A late clip for the given-up recording goes nowhere.
    say(CLIP);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('cancel drops the recording', () => {
    const { result, post } = setup();
    act(() => result.current.start());
    act(() => result.current.cancel());
    expect(post).toHaveBeenLastCalledWith('d1', 'cancel');
    expect(result.current.phase).toBe('idle');
  });

  it('leaving the screen mid-recording cancels it and stops listening', () => {
    const { result, post, view, listening } = setup();
    act(() => result.current.start());
    view.unmount();
    expect(post).toHaveBeenLastCalledWith('d1', 'cancel');
    expect(listening()).toBe(false);
  });

  it('text that arrives after leaving the screen is dropped', async () => {
    let finish: (r: TranscriptResult) => void = () => {};
    const { result, say, onText, view } = setup(() => new Promise<TranscriptResult>((r) => { finish = r; }));
    act(() => result.current.start());
    act(() => result.current.stop());
    say(CLIP);
    view.unmount();
    await act(async () => { finish({ ok: true, text: 'late' }); await Promise.resolve(); });
    expect(onText).not.toHaveBeenCalled();
  });
});
