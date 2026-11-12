import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAgentVoice } from './useAgentVoice';
import { CLAUDE_TALK_REPEAT_MS } from '@/lib/agentVoice';

describe('useAgentVoice', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hold: writes Space at once and at key-repeat cadence until released', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useAgentVoice('hold', 't1', send));
    act(() => result.current.start());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(' ');
    expect(result.current.active).toBe(true);
    act(() => { vi.advanceTimersByTime(CLAUDE_TALK_REPEAT_MS * 4); });
    expect(send).toHaveBeenCalledTimes(5);
    act(() => result.current.stop());
    expect(result.current.active).toBe(false);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('hold: a second press while held does not start a second stream', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useAgentVoice('hold', 't1', send));
    act(() => { result.current.start(); result.current.start(); });
    act(() => { vi.advanceTimersByTime(CLAUDE_TALK_REPEAT_MS); });
    expect(send).toHaveBeenCalledTimes(2);
    act(() => result.current.stop());
  });

  it('toggle: /voice then /voice stop', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useAgentVoice('toggle', 't1', send));
    act(() => result.current.toggle());
    expect(send).toHaveBeenLastCalledWith('/voice\r');
    expect(result.current.active).toBe(true);
    act(() => result.current.toggle());
    expect(send).toHaveBeenLastCalledWith('/voice stop\r');
    expect(result.current.active).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('each kind ignores the other kind\'s control', () => {
    const send = vi.fn();
    const hold = renderHook(() => useAgentVoice('hold', 't1', send));
    act(() => hold.result.current.toggle());
    const toggle = renderHook(() => useAgentVoice('toggle', 't1', send));
    act(() => toggle.result.current.start());
    expect(send).not.toHaveBeenCalled();
  });

  it('switching terminal ends a hold and forgets a toggle', () => {
    const send = vi.fn();
    const { result, rerender } = renderHook(({ id, kind }) => useAgentVoice(kind, id, send), {
      initialProps: { id: 't1', kind: 'hold' as 'hold' | 'toggle' },
    });
    act(() => result.current.start());
    rerender({ id: 't2', kind: 'hold' });
    expect(result.current.active).toBe(false);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(send).toHaveBeenCalledTimes(1);

    rerender({ id: 't2', kind: 'toggle' });
    act(() => result.current.toggle());
    rerender({ id: 't3', kind: 'toggle' });
    act(() => result.current.toggle());
    expect(send).toHaveBeenLastCalledWith('/voice\r');
  });

  it('unmount stops a held stream', () => {
    const send = vi.fn();
    const { result, unmount } = renderHook(() => useAgentVoice('hold', 't1', send));
    act(() => result.current.start());
    unmount();
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
