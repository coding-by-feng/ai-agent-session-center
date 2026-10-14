// useReadAloud.test.tsx — the phone's read-aloud buttons (AASC-20): the user's own key, one voice at a time.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const tts = vi.hoisted(() => ({
  speak: vi.fn<(text: string, opts: { apiKey: string }) => Promise<void>>(),
  stop: vi.fn(),
}));
vi.mock('@/lib/ttsEngine', () => ({ ttsEngine: tts }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import { showToast } from '@/components/ui/ToastContainer';
import { useSettingsStore } from '@/stores/settingsStore';
import { useReadAloud, READ_ALOUD_SETUP_HINT } from './useReadAloud';

function Speaker({ speakKey, text }: { speakKey: string; text: string }) {
  const { speaking, toggle } = useReadAloud(speakKey);
  return <button type="button" onClick={() => toggle(() => text)}>{speakKey}:{speaking ? 'on' : 'off'}</button>;
}

/** speak() resolves only when the test says the chunk finished playing. */
let finish: Array<() => void> = [];
beforeEach(() => {
  vi.clearAllMocks();
  finish = [];
  tts.speak.mockImplementation(() => new Promise<void>((resolve) => { finish.push(resolve); }));
  tts.stop.mockImplementation(() => { finish.forEach((f) => f()); finish = []; });
  useSettingsStore.setState({ ttsEnabled: true, googleTtsApiKey: 'user-key-0123456789' });
});

describe('useReadAloud', () => {
  it('says where to turn it on when there is no key, and never calls the voice', () => {
    useSettingsStore.setState({ ttsEnabled: true, googleTtsApiKey: '  ' });
    render(<Speaker speakKey="a" text="hello" />);
    fireEvent.click(screen.getByRole('button'));
    expect(showToast).toHaveBeenCalledWith(READ_ALOUD_SETUP_HINT, 'info', 6000);
    expect(tts.speak).not.toHaveBeenCalled();
    expect(screen.getByRole('button').textContent).toBe('a:off');
  });

  it('reads the Markdown as words with the user’s own key, then turns itself off', async () => {
    render(<Speaker speakKey="a" text="**Done.** See `npm test`." />);
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(screen.getByRole('button').textContent).toBe('a:on');
    expect(tts.speak).toHaveBeenCalledWith('Done. See npm test.', expect.objectContaining({ apiKey: 'user-key-0123456789' }));
    await act(async () => { finish.shift()?.(); });
    expect(screen.getByRole('button').textContent).toBe('a:off');
  });

  it('a second tap stops it; starting another button stops the first', async () => {
    render(<><Speaker speakKey="a" text="one" /><Speaker speakKey="b" text="two" /></>);
    const [a, b] = screen.getAllByRole('button');
    await act(async () => { fireEvent.click(a); });
    expect(a.textContent).toBe('a:on');
    await act(async () => { fireEvent.click(b); });
    expect(a.textContent).toBe('a:off');
    expect(b.textContent).toBe('b:on');
    expect(tts.stop).toHaveBeenCalled();
    await act(async () => { fireEvent.click(b); });
    expect(b.textContent).toBe('b:off');
  });

  it('stops when its button goes away', async () => {
    const { unmount } = render(<Speaker speakKey="gone" text="long answer" />);
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    tts.stop.mockClear();
    unmount();
    expect(tts.stop).toHaveBeenCalled();
  });

  it('reports a failed voice', async () => {
    tts.speak.mockRejectedValueOnce(new Error('TTS request failed: HTTP 403'));
    render(<Speaker speakKey="a" text="hello" />);
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(showToast).toHaveBeenCalledWith('TTS request failed: HTTP 403', 'error');
    expect(screen.getByRole('button').textContent).toBe('a:off');
  });
});
