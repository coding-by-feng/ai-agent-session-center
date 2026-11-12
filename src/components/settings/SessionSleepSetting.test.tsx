import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SessionSleepSetting from './SessionSleepSetting';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

function mockFetch(answers: Array<{ ok: boolean; body?: unknown }>) {
  const fn = vi.fn();
  for (const a of answers) fn.mockResolvedValueOnce({ ok: a.ok, status: a.ok ? 200 : 404, json: async () => a.body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('SessionSleepSetting', () => {
  it('offers day-length choices and saves the minutes of the one picked', async () => {
    const fetchFn = mockFetch([
      { ok: true, body: { ok: true, idleMinutes: 120 } },
      { ok: true, body: { ok: true, idleMinutes: 2880 } },
    ]);
    render(<SessionSleepSetting />);
    fireEvent.click(await screen.findByRole('combobox'));
    const labels = screen.getAllByRole('option').map((o) => o.textContent);
    expect(labels.slice(-4)).toEqual(['After 1 day idle', 'After 2 days idle', 'After 3 days idle', 'After 7 days idle']);
    fireEvent.mouseDown(screen.getByRole('option', { name: 'After 2 days idle' })); // Select picks on mousedown
    await waitFor(() =>
      expect(fetchFn).toHaveBeenLastCalledWith('/api/session-sleep-setting', expect.objectContaining({ method: 'PUT', body: '{"idleMinutes":2880}' })),
    );
  });
});
