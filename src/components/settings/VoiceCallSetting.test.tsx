import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VoiceCallSetting from './VoiceCallSetting';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const SETTINGS = { success: true, data: { configured: false, keyHint: null, voice: 'marin', brainCentralId: null } };
const STATUS_NO_CENTRAL = {
  success: true,
  data: { configured: false, voice: 'marin', brain: { state: 'no_central', centralId: null, title: null, shared: false }, call: null },
};

function mockFetch(routes: Record<string, Array<{ ok: boolean; body?: unknown }>>) {
  const queues = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, [...v]]));
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const next = queues[key]?.shift() ?? { ok: false };
    return { ok: next.ok, status: next.ok ? 200 : 404, json: async () => next.body };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('VoiceCallSetting', () => {
  it('shows that no key is set and what the Voice central needs', async () => {
    mockFetch({ 'GET /api/voice/settings': [{ ok: true, body: SETTINGS }], 'GET /api/voice/status': [{ ok: true, body: STATUS_NO_CENTRAL }] });
    render(<VoiceCallSetting />);
    expect(await screen.findByText(/no key set/i)).toBeInTheDocument();
    expect(await screen.findByText(/exactly one global central session/i)).toBeInTheDocument();
  });

  it('saves a key to this Mac and shows only its last four characters', async () => {
    const fetchFn = mockFetch({
      'GET /api/voice/settings': [{ ok: true, body: SETTINGS }],
      'GET /api/voice/status': [{ ok: true, body: STATUS_NO_CENTRAL }, { ok: true, body: STATUS_NO_CENTRAL }],
      'PUT /api/voice/settings': [{ ok: true, body: { success: true, data: { ...SETTINGS.data, configured: true, keyHint: '…9xyz' } } }],
    });
    render(<VoiceCallSetting />);
    const input = await screen.findByLabelText(/openai api key/i);
    fireEvent.change(input, { target: { value: 'sk-proj-aaaaaaaaaaaaaaaaaaaa9xyz' } });
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));
    await waitFor(() => expect(screen.getByText(/…9xyz/)).toBeInTheDocument());
    expect(fetchFn).toHaveBeenCalledWith('/api/voice/settings', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ apiKey: 'sk-proj-aaaaaaaaaaaaaaaaaaaa9xyz' }),
    }));
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('changes the voice', async () => {
    const fetchFn = mockFetch({
      'GET /api/voice/settings': [{ ok: true, body: SETTINGS }],
      'GET /api/voice/status': [{ ok: true, body: STATUS_NO_CENTRAL }],
      'PUT /api/voice/settings': [{ ok: true, body: { success: true, data: { ...SETTINGS.data, voice: 'cinder' } } }],
    });
    render(<VoiceCallSetting />);
    const select = await screen.findByLabelText(/voice/i, { selector: 'select' });
    fireEvent.change(select, { target: { value: 'cinder' } });
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith('/api/voice/settings', expect.objectContaining({ body: '{"voice":"cinder"}' })));
  });

  it('renders nothing on a device the Mac answers 404', async () => {
    mockFetch({ 'GET /api/voice/settings': [{ ok: false }] });
    const { container } = render(<VoiceCallSetting />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
