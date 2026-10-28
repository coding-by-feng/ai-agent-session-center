// Composer.video.test.tsx — a video in a phone message (Oct 27 2026): the pickers take videos, each
// uploads to the Mac at once (POST /api/queue-media), Send waits for it, and the message carries the
// saved path on its own line, whether sent now or queued.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import type { DevicePresence, Session } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone', getWindowOriginId: () => 'phone:w' }));
vi.mock('@/lib/presenceClient', () => ({
  claimControl: vi.fn(async () => ({ ok: true, controller: null })),
  requestControl: vi.fn(async () => ({ ok: true })),
  grantControl: vi.fn(async () => ({ ok: true, controller: null })),
  releaseControl: vi.fn(async () => ({ ok: true, released: true })),
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import Composer from './Composer';
import { showToast } from '@/components/ui/ToastContainer';
import { usePresenceStore } from '@/stores/presenceStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { useQueueStore } from '@/stores/queueStore';
import { waitingCardModel } from '@/lib/chat/waitingCardModel';

const SAVED = '/tmp/claude-queue-images/queue-img-1-abc.mov';
type Call = { url: string; method: string; body: unknown; type: string | null };

/** The Mac; its video upload answers when `finish` is called. */
function stubMac(upload: { status: number; body: unknown } = { status: 200, body: { ok: true, path: SAVED, id: 'queue-img-1-abc.mov' } }) {
  const calls: Call[] = [];
  let finish: () => void = () => {};
  const uploaded = new Promise<void>((resolve) => { finish = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, body, type: headers['Content-Type'] ?? null });
    const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
    if (url === '/api/queue-media') {
      await uploaded;
      return reply(upload.status, upload.body);
    }
    if (/\/prompt$/.test(url) && method === 'POST') return reply(202, { success: true, data: { accepted: true, key: (body as { key?: string })?.key } });
    if (/\/prompt\/[^/]+$/.test(url)) return reply(200, { success: true, data: { key: 'k', state: 'submitted' } });
    return reply(200, { ok: true });
  }));
  return { calls, finish };
}

function device(clientId: string, isLocal: boolean): DevicePresence {
  return { clientId, label: clientId === 'desk' ? 'MacBook' : 'iPhone', address: '', isLocal, connections: 1, connectedAt: 1, lastSeenAt: 1 };
}

function session(extra: Partial<Session> = {}): Session {
  return {
    sessionId: 's1', status: 'waiting', cliSource: 'claude', projectName: 'agent-manager', projectPath: '/Users/me/agent-manager',
    terminalId: 'term-1', model: 'claude-opus-5-5', events: [], pendingRequest: null, pendingTool: null, pendingToolDetail: null, waitingDetail: null,
    ...extra,
  } as unknown as Session;
}

function renderComposer(s: Session) {
  useSessionStore.setState({ sessions: new Map([[s.sessionId, s]]) });
  return render(<Composer session={s} card={waitingCardModel(s)} inputRef={createRef<HTMLTextAreaElement>()} />);
}

const type = (text: string) => fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } });
const sendButton = () => screen.getByTestId('composer-send');
const clip = (name = 'bug.mov', type = 'video/quicktime') => new File([new Uint8Array([1, 2, 3])], name, { type });
const pick = (testId: string, files: File[]) => fireEvent.change(screen.getByTestId(testId), { target: { files } });

beforeEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
  useQueueStore.setState({ queues: new Map(), automation: new Map() });
  usePresenceStore.setState({ pendingRequests: new Map() });
  usePresenceStore.getState().applyPresence({
    devices: [device('phone', false), device('desk', true)],
    controllers: [],
    restoreOwner: 'desk',
    workspaceWriter: 'desk',
  });
  vi.mocked(showToast).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Composer — videos', () => {
  it('lets the library pick videos as well as photos, and records a video from its own row', () => {
    stubMac();
    renderComposer(session());
    expect(screen.getByTestId('composer-photo-input').getAttribute('accept')).toBe('image/*,video/*');
    // The camera stays photos only: Android's capture turns any video/* in the list into a video-only camera.
    expect(screen.getByTestId('composer-camera-input').getAttribute('accept')).toBe('image/*');
    const record = screen.getByTestId('composer-video-input');
    expect(record.getAttribute('accept')).toBe('video/*');
    expect(record.getAttribute('capture')).toBe('environment');
  });

  it('uploads a picked video raw, waits for it, then sends its path on its own line', async () => {
    const mac = stubMac();
    renderComposer(session());
    const video = clip();
    pick('composer-photo-input', [video]);
    await waitFor(() => expect(mac.calls.some((c) => c.url === '/api/queue-media')).toBe(true));
    const upload = mac.calls.find((c) => c.url === '/api/queue-media')!;
    expect(upload).toMatchObject({ method: 'POST', body: video, type: 'video/quicktime' });
    expect(screen.getByRole('status')).toHaveTextContent('Uploading');

    type('the login button flickers');
    expect(sendButton()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(sendButton());
    expect(mac.calls.some((c) => c.url === '/api/sessions/s1/prompt')).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Wait for the video to finish uploading.', 'info');

    await act(async () => { mac.finish(); });
    await waitFor(() => expect(sendButton()).not.toHaveAttribute('aria-disabled'));
    fireEvent.click(sendButton());
    await waitFor(() => expect(mac.calls.some((c) => c.url === '/api/sessions/s1/prompt')).toBe(true));
    const post = mac.calls.find((c) => c.url === '/api/sessions/s1/prompt')!;
    expect(post.body).toMatchObject({ text: `the login button flickers\n${SAVED}`, mode: 'now' });
    expect(screen.queryByTestId(/^composer-clip-/)).toBeNull();
  });

  it('puts the path in a queued message too', async () => {
    const mac = stubMac();
    renderComposer(session({ status: 'working' }));
    pick('composer-photo-input', [clip()]);
    await act(async () => { mac.finish(); });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('bug.mov ready'));
    type('look at this');
    fireEvent.click(sendButton());
    await waitFor(() => expect(useQueueStore.getState().queues.get('s1')?.length).toBe(1));
    expect(useQueueStore.getState().queues.get('s1')![0].text).toBe(`look at this\n${SAVED}`);
  });

  it('drops the chip and says why when the Mac refuses the video', async () => {
    const mac = stubMac({ status: 413, body: { ok: false, code: 'too_large' } });
    renderComposer(session());
    pick('composer-video-input', [clip()]);
    await act(async () => { mac.finish(); });
    await waitFor(() => expect(screen.queryByTestId(/^composer-clip-/)).toBeNull());
    expect(showToast).toHaveBeenCalledWith('That video is over 100 MB. Trim it, or send a shorter one.', 'warning');
  });

  it('sends no path for a video taken out before sending', async () => {
    const mac = stubMac();
    renderComposer(session());
    pick('composer-photo-input', [clip()]);
    await act(async () => { mac.finish(); });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove video bug.mov' }));
    type('never mind the video');
    fireEvent.click(sendButton());
    await waitFor(() => expect(mac.calls.some((c) => c.url === '/api/sessions/s1/prompt')).toBe(true));
    expect(mac.calls.find((c) => c.url === '/api/sessions/s1/prompt')!.body).toMatchObject({ text: 'never mind the video' });
  });

  it('counts videos with photos toward the 10 per message', async () => {
    const mac = stubMac();
    renderComposer(session());
    pick('composer-photo-input', Array.from({ length: 11 }, (_, i) => clip(`c${i}.mp4`, 'video/mp4')));
    await act(async () => { mac.finish(); });
    await waitFor(() => expect(screen.getAllByTestId(/^composer-clip-/)).toHaveLength(10));
    expect(showToast).toHaveBeenCalledWith('Up to 10 photos and videos a message.', 'warning');
  });
});
