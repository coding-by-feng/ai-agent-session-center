// useChatLive.test.tsx — the Mac's `chat_grew` (Oct 22 2026) re-reads the chat on screen at once: Claude's prose
// and thinking between tool calls have no hook to move the session, and used to wait for the 8 s poll.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/types';

const refresh = vi.fn(async () => {});
const open = vi.fn(async () => {});
let isTop = true;

vi.mock('@/stores/chatStore', () => ({
  retainChat: () => () => {},
  useChatStore: { getState: () => ({ refresh, open }) },
}));
vi.mock('../kit', () => ({ useScreenSlot: () => ({ isTop }) }));

const { useChatLive } = await import('./useChatLive');
const { noteChatGrew } = await import('@/lib/chatGrowth');

const session = (sessionId: string) => ({ sessionId, status: 'waiting', lastActivityAt: 1, totalToolCalls: 0 }) as unknown as Session;

describe('useChatLive and chat_grew', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
    isTop = true;
  });
  afterEach(() => vi.useRealTimers());

  it('re-reads 250 ms after the Mac says this session’s transcript grew', () => {
    renderHook(() => useChatLive(session('grow-a')));
    act(() => noteChatGrew('grow-a'));
    expect(refresh).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(250); });
    expect(refresh).toHaveBeenCalledWith('grow-a');
  });

  it('a burst of growth rides one read', () => {
    renderHook(() => useChatLive(session('grow-b')));
    act(() => {
      noteChatGrew('grow-b');
      noteChatGrew('grow-b');
      noteChatGrew('grow-b');
    });
    act(() => { vi.advanceTimersByTime(300); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ignores another session’s growth, and reads nothing while the screen is not on top', () => {
    renderHook(() => useChatLive(session('grow-c')));
    act(() => noteChatGrew('someone-else'));
    act(() => { vi.advanceTimersByTime(300); });
    expect(refresh).not.toHaveBeenCalled();

    isTop = false;
    renderHook(() => useChatLive(session('grow-d')));
    act(() => noteChatGrew('grow-d'));
    act(() => { vi.advanceTimersByTime(300); });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('the working poll only fills silence: no tick right after a cued read', () => {
    const working = { ...session('grow-e'), status: 'working' } as Session;
    renderHook(() => useChatLive(working));
    act(() => { vi.advanceTimersByTime(7_000); });
    act(() => noteChatGrew('grow-e'));
    act(() => { vi.advanceTimersByTime(300); }); // the cued read, at 7.25 s
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1_000); }); // the 8 s tick: skipped
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(8_000); }); // the 16 s tick: 8.75 s of silence, so it reads
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
