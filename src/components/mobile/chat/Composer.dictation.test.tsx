// Composer.dictation.test.tsx — the hold-to-talk mic in the phone Chat composer (Nov 16 2026): shown
// only where the app has a recorder; the spoken words fill the box and are never sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import type { Session } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone', getWindowOriginId: () => 'phone:w' }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import Composer from './Composer';
import { useSessionStore } from '@/stores/sessionStore';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { useQueueStore } from '@/stores/queueStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { DICTATION_EVENT, DICTATION_HANDLER } from '@/lib/phoneDictation';

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function stubMac(dictate: { status: number; json: unknown } = { status: 200, json: { success: true, data: { text: 'then run the tests' } } }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    if (url === '/api/voice/dictate') return { ok: dictate.status === 200, status: dictate.status, json: async () => dictate.json };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
  return calls;
}

/** The iOS app's recorder: what the page posted, and a way to answer it. */
function installApp() {
  const posted: Array<{ id: string; action: string }> = [];
  (window as unknown as { webkit?: unknown }).webkit = { messageHandlers: { [DICTATION_HANDLER]: { postMessage: (m: { id: string; action: string }) => posted.push(m) } } };
  const answer = (detail: Record<string, unknown>) => act(() => { window.dispatchEvent(new CustomEvent(DICTATION_EVENT, { detail })); });
  return { posted, answer };
}

function session(extra: Partial<Session> = {}): Session {
  return {
    sessionId: 's1', status: 'waiting', cliSource: 'claude', projectName: 'p', projectPath: '/p/quick',
    terminalId: 'term-1', model: 'claude-opus-5-5', events: [], pendingRequest: null, pendingTool: null, pendingToolDetail: null, waitingDetail: null,
    ...extra,
  } as unknown as Session;
}

function renderComposer(s: Session = session()) {
  useSessionStore.setState({ sessions: new Map([[s.sessionId, s]]) });
  return render(<Composer session={s} card={null} inputRef={createRef<HTMLTextAreaElement>()} />);
}

const mic = () => screen.getByTestId('dictate-button');
const prompts = (calls: Call[]) => calls.filter((c) => /\/prompt$/.test(c.url) && c.method === 'POST');

beforeEach(() => {
  localStorage.clear();
  useComposerDraftStore.setState({ drafts: {} });
  useQueueStore.setState({ queues: new Map(), automation: new Map() });
  usePresenceStore.getState().applyPresence({ devices: [], controllers: [], restoreOwner: null, workspaceWriter: null });
});

afterEach(() => {
  delete (window as unknown as { webkit?: unknown }).webkit;
  vi.unstubAllGlobals();
});

describe('the composer’s hold-to-talk mic', () => {
  it('is not there in a browser or an app without the recorder', () => {
    stubMac();
    renderComposer();
    expect(screen.queryByTestId('dictate-button')).toBeNull();
  });

  it('tap, speak, tap again: the words fill the box after what was typed, and nothing is sent', async () => {
    const calls = stubMac();
    const app = installApp();
    renderComposer();
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'Fix the login bug.' } });
    fireEvent.pointerDown(mic());
    expect(app.posted).toEqual([{ id: expect.any(String), action: 'start' }]);
    const id = app.posted[0].id;
    expect(screen.getByTestId('dictation-line')).toHaveTextContent(/Listening/);
    expect(mic()).toHaveAttribute('aria-pressed', 'true');
    // Lifting the finger no longer ends it: only the second tap does.
    fireEvent.pointerUp(mic());
    expect(app.posted).toHaveLength(1);
    fireEvent.pointerDown(mic());
    expect(app.posted[1]).toEqual({ id, action: 'stop' });
    expect(screen.getByTestId('dictation-line')).toHaveTextContent(/text/);
    app.answer({ id, state: 'audio', audio: 'QUJD', mime: 'audio/mp4', ms: 2000 });
    await waitFor(() => expect(useComposerDraftStore.getState().drafts.s1).toBe('Fix the login bug. then run the tests'));
    expect(calls.find((c) => c.url === '/api/voice/dictate')?.body).toEqual({ audio: 'QUJD', mime: 'audio/mp4' });
    expect(prompts(calls)).toEqual([]);
    expect(screen.queryByTestId('dictation-line')).toBeNull();
    expect(mic()).toHaveAccessibleName('Tap to dictate');
  });

  it('shows the Mac’s refusal under the box as an alert and keeps the draft', async () => {
    stubMac({ status: 409, json: { success: false, code: 'no_key', error: 'Add an OpenAI API key in Settings → Voice on the Mac to dictate.' } });
    const app = installApp();
    renderComposer();
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'kept' } });
    fireEvent.pointerDown(mic());
    fireEvent.pointerDown(mic());
    app.answer({ id: app.posted[0].id, state: 'audio', audio: 'QUJD', mime: 'audio/mp4', ms: 2000 });
    const line = await screen.findByRole('alert');
    expect(line).toHaveTextContent('Add an OpenAI API key in Settings → Voice on the Mac to dictate.');
    expect(useComposerDraftStore.getState().drafts.s1).toBe('kept');
  });

  it('is off while the box is (the session has ended)', () => {
    stubMac();
    const app = installApp();
    renderComposer(session({ status: 'ended' }));
    expect(mic()).toBeDisabled();
    fireEvent.pointerDown(mic());
    expect(app.posted).toEqual([]);
  });
});
