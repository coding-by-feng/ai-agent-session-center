import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CentralSessionsSetting from './CentralSessionsSetting';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

function mockFetch(answers: Array<{ ok: boolean; body?: unknown }>) {
  const fn = vi.fn();
  for (const a of answers) fn.mockResolvedValueOnce({ ok: a.ok, status: a.ok ? 200 : 404, json: async () => a.body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('CentralSessionsSetting', () => {
  it('shows the switch off by default with no restart note', async () => {
    mockFetch([{ ok: true, body: { ok: true, enabled: false, nextStart: false } }]);
    render(<CentralSessionsSetting />);
    const box = await screen.findByRole('checkbox', { name: /central sessions/i });
    await waitFor(() => expect(box).not.toBeDisabled());
    expect(box).not.toBeChecked();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('saves on toggle and says a restart is owed', async () => {
    const fetchFn = mockFetch([
      { ok: true, body: { ok: true, enabled: false, nextStart: false } },
      { ok: true, body: { ok: true, enabled: false, nextStart: true } },
    ]);
    render(<CentralSessionsSetting />);
    const box = await screen.findByRole('checkbox', { name: /central sessions/i });
    await waitFor(() => expect(box).not.toBeDisabled());
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(fetchFn).toHaveBeenLastCalledWith('/api/central-sessions-setting', expect.objectContaining({ method: 'PUT', body: '{"enabled":true}' }));
    expect(screen.getByRole('status')).toHaveTextContent('Restart AASC to turn them on');
  });

  it('renders nothing on a device the Mac answers 404', async () => {
    mockFetch([{ ok: false }]);
    const { container } = render(<CentralSessionsSetting />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
