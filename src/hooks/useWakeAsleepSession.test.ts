import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const resume = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sessionActions', () => ({ requestSessionResume: resume }));
vi.mock('@/hooks/useAuth', () => ({ authFetch: vi.fn() }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import { useWakeAsleepSession, __resetWakesForTest } from './useWakeAsleepSession';

afterEach(() => { resume.mockReset(); __resetWakesForTest(); });

describe('useWakeAsleepSession', () => {
  it('does nothing for an awake session', () => {
    renderHook(() => useWakeAsleepSession('s1', undefined));
    expect(resume).not.toHaveBeenCalled();
  });

  it('resumes an asleep session once, however often it re-renders or reopens', async () => {
    resume.mockResolvedValue({ ok: true, message: '' });
    const { rerender, unmount } = renderHook(({ at }) => useWakeAsleepSession('s1', at), { initialProps: { at: 5 } });
    rerender({ at: 5 });
    unmount();
    renderHook(() => useWakeAsleepSession('s1', 5));
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(resume.mock.calls[0][0]).toBe('s1');
  });

  it('tries again on the next open after a failed wake', async () => {
    resume.mockResolvedValueOnce({ ok: false, message: 'nope' }).mockResolvedValueOnce({ ok: true, message: '' });
    const first = renderHook(() => useWakeAsleepSession('s2', 9));
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    first.unmount();
    renderHook(() => useWakeAsleepSession('s2', 9));
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
  });
});
