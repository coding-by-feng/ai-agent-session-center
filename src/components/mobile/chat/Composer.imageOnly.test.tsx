// Composer.imageOnly.test.tsx — a photo is a prompt on its own (Nov 8 2026): with a photo attached and
// no text, Send (and Queue) work; with neither, the button stays off.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('@/lib/queueImageAttach', () => ({
  readQueueImages: vi.fn(async (files: File[]) => ({
    images: files.map((f) => ({ name: f.name, dataUrl: `data:image/png;base64,${f.name}` })),
    message: null,
  })),
}));

import Composer from './Composer';
import { usePresenceStore } from '@/stores/presenceStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { useQueueStore } from '@/stores/queueStore';
import { waitingCardModel } from '@/lib/chat/waitingCardModel';

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function stubMac(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
    if (url === '/api/queue-images') return reply(200, { ids: ['queue-img-1-shot.png'] });
    if (/\/prompt$/.test(url) && method === 'POST') return reply(202, { success: true, data: { accepted: true, key: body?.key } });
    if (/\/prompt\/[^/]+$/.test(url)) return reply(200, { success: true, data: { key: 'k', state: 'submitted' } });
    return reply(200, { ok: true });
  }));
  return calls;
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

async function attachPhoto(name = 'shot.png') {
  const file = new File([new Uint8Array([1])], name, { type: 'image/png' });
  fireEvent.change(screen.getByTestId('composer-photo-input'), { target: { files: [file] } });
  await screen.findByRole('button', { name: `View ${name}` });
}

const sendButton = () => screen.getByTestId('composer-send');

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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Composer — a prompt that is only a photo', () => {
  it('keeps Send off with neither text nor a photo', () => {
    stubMac();
    renderComposer(session());
    expect(sendButton()).toHaveAttribute('aria-disabled', 'true');
  });

  it('sends a photo with no text: the prompt carries the image and empty text', async () => {
    const calls = stubMac();
    renderComposer(session());
    await attachPhoto();
    expect(sendButton()).not.toHaveAttribute('aria-disabled');
    fireEvent.click(sendButton());
    await waitFor(() => expect(calls.some((c) => c.url === '/api/sessions/s1/prompt')).toBe(true));
    const post = calls.find((c) => c.url === '/api/sessions/s1/prompt')!;
    expect(post.body).toMatchObject({ text: '', images: ['queue-img-1-shot.png'], mode: 'now' });
    // The photo strip clears once it is sent.
    expect(screen.queryByRole('button', { name: 'View shot.png' })).toBeNull();
  });

  it('queues a photo with no text while the agent works', async () => {
    stubMac();
    renderComposer(session({ status: 'working' }));
    await attachPhoto();
    expect(sendButton()).toHaveTextContent('Queue');
    fireEvent.click(sendButton());
    const items = useQueueStore.getState().queues.get('s1') ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: '', images: [{ name: 'shot.png' }] });
  });
});
