// useSessionRecap.test.tsx — one rule for a session's Summary button (Nov 27 2026): the desktop peek and
// the phone's Recent prompts sheet and long-press menu all read it, so their labels never drift.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recapAction, requestRecap } from './useSessionRecap';
import type { SessionRecap } from '@/types/session';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
import { showToast } from '@/components/ui/ToastContainer';

const done = (over: Partial<SessionRecap> = {}): SessionRecap => ({ state: 'done', text: '• built it', at: 1, promptAt: 1, ...over } as SessionRecap);

afterEach(() => { vi.unstubAllGlobals(); vi.mocked(showToast).mockClear(); });

describe('recapAction', () => {
  it('names the button for what a press does now', () => {
    expect(recapAction(undefined, false, false)).toMatchObject({ kind: 'new', label: 'Summary', name: 'Summarize what this session has done' });
    expect(recapAction(done(), false, true)).toMatchObject({ kind: 'running', label: 'Summarizing…' });
    expect(recapAction(done({ state: 'running' }), false, false).kind).toBe('running');
    expect(recapAction(done({ state: 'error', error: 'x' }), false, false)).toMatchObject({ kind: 'error', label: 'Try again' });
    expect(recapAction(done(), true, false)).toMatchObject({ kind: 'stale', label: 'Update' });
    expect(recapAction(done(), false, false)).toMatchObject({ kind: 'current', label: 'Resummarize' });
  });
});

describe('requestRecap', () => {
  it('posts for the session and says nothing when the Mac takes it', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await requestRecap('a b')).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/a%20b/recap', { method: 'POST' });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('shows the Mac’s reason, or that it could not reach the Mac', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Nothing typed yet."}', { status: 409 })));
    expect(await requestRecap('s')).toBe(false);
    expect(showToast).toHaveBeenLastCalledWith('Nothing typed yet.', 'error');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await requestRecap('s')).toBe(false);
    expect(showToast).toHaveBeenLastCalledWith('Couldn’t reach the Mac to summarize this session.', 'error');
  });
});
