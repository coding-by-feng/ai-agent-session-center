// usePromptSender.test.ts — what the composer says while the Mac holds a prompt
// (AASC-42): it never gives up before the Mac does (no text back while the Mac may
// still send it), only the newest send speaks on the status line, and leaving the
// chat stops the polling.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import { usePromptSender } from './usePromptSender';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { showToast } from '@/components/ui/ToastContainer';

/** The Mac: accepts every prompt; `stateOf(key, n)` answers the n-th status poll for that key. */
function stubMac(stateOf: (key: string, poll: number) => string) {
  const polls = new Map<string, number>();
  const keys: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const key = JSON.parse(String(init.body)).key as string;
      keys.push(key);
      return { ok: true, status: 202, json: async () => ({ success: true, data: { accepted: true, key } }) };
    }
    const key = decodeURIComponent(url.split('/').pop() ?? '');
    const n = (polls.get(key) ?? 0) + 1;
    polls.set(key, n);
    return { ok: true, status: 200, json: async () => ({ success: true, data: { key, state: stateOf(key, n) } }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, keys };
}

/** The hook, with every status-line phase it passes through ("Sent" fades back to idle). */
function renderSender() {
  const seen: string[] = [];
  const hook = renderHook(() => {
    const sender = usePromptSender('s1');
    if (seen[seen.length - 1] !== sender.state.phase) seen.push(sender.state.phase);
    return sender;
  });
  return { ...hook, seen };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useComposerDraftStore.setState({ drafts: {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('usePromptSender', () => {
  it('says "still waiting" after 90 s, then stops quietly at 5 min without putting the text back', async () => {
    stubMac(() => 'pending');
    const { result } = renderHook(() => usePromptSender('s1'));
    await act(async () => { await result.current.send({ text: 'run the tests' }); });
    expect(result.current.state).toEqual({ phase: 'pending' });

    await act(async () => { await vi.advanceTimersByTimeAsync(95_000); });
    expect(result.current.state).toEqual({ phase: 'pending', slow: true });

    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(result.current.state).toMatchObject({ phase: 'unsure' });
    expect(result.current.state.phase === 'unsure' && result.current.state.message).toMatch(/Check the chat/);
    // The Mac may still type it: the text must not come back for a second send.
    expect(useComposerDraftStore.getState().drafts.s1).toBeUndefined();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('hears a late "submitted" while waiting slowly', async () => {
    stubMac((_key, n) => (n > 95 ? 'submitted' : 'pending'));
    const { result, seen } = renderSender();
    await act(async () => { await result.current.send({ text: 'hi' }); });
    for (let t = 0; t < 130; t += 1) await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(seen.slice(-3)).toEqual(['pending', 'sent', 'idle']);
    expect(seen).not.toContain('unsure');
    expect(useComposerDraftStore.getState().drafts.s1).toBeUndefined();
  });

  it('puts the text back, and says so, when the prompt surely went nowhere', async () => {
    stubMac(() => 'failed');
    const { result } = renderHook(() => usePromptSender('s1'));
    await act(async () => { await result.current.send({ text: 'one more' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.state).toMatchObject({ phase: 'failed' });
    expect(useComposerDraftStore.getState().drafts.s1).toBe('one more');
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('back in the box'), 'error', expect.any(Number));
  });

  it('lets only the newest send speak on the status line', async () => {
    const mac = stubMac((key, n) => (key === mac.keys[0] ? (n > 5 ? 'failed' : 'pending') : 'submitted'));
    const { result, seen } = renderSender();
    await act(async () => { await result.current.send({ text: 'first' }); });
    await act(async () => { await result.current.send({ text: 'second' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    // The first one failed later; the line never showed it over the second, which landed.
    expect(seen).not.toContain('failed');
    expect(seen).toContain('sent');
    // Its own failure is still said, and its text still saved.
    expect(useComposerDraftStore.getState().drafts.s1).toBe('first');
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('back in the box'), 'error', expect.any(Number));
  });

  it('stops polling when the composer goes away', async () => {
    const { fetchMock } = stubMac(() => 'pending');
    const { result, unmount } = renderHook(() => usePromptSender('s1'));
    await act(async () => { await result.current.send({ text: 'bye' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    unmount();
    const calls = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });
});
