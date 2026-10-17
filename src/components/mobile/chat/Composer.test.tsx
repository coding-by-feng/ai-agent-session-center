// Composer.test.tsx — the phone composer (AASC-42): Send when idle, Queue while
// working (hold: Send now, confirmed), "Deny and tell Claude" while a card waits,
// off while another device drives, and the note when no AASC window is open.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import type { DevicePresence, PendingRequest, Session } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone', getWindowOriginId: () => 'phone:w' }));
vi.mock('@/lib/presenceClient', () => ({
  claimControl: vi.fn(async () => ({ ok: true, controller: null })),
  requestControl: vi.fn(async () => ({ ok: true })),
  grantControl: vi.fn(async () => ({ ok: true, controller: null })),
  releaseControl: vi.fn(async () => ({ ok: true, released: true })),
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import Composer from './Composer';
import { usePresenceStore } from '@/stores/presenceStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { useQueueStore } from '@/stores/queueStore';
import { waitingCardModel } from '@/lib/chat/waitingCardModel';

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function stubMac(over: { prompt?: { status: number; body: unknown }; answer?: { status: number; body: unknown } } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
    if (/\/prompt$/.test(url) && method === 'POST') {
      const r = over.prompt ?? { status: 202, body: { success: true, data: { accepted: true, key: body?.key } } };
      return reply(r.status, r.body);
    }
    if (/\/prompt\/[^/]+$/.test(url)) return reply(200, { success: true, data: { key: 'k', state: 'submitted' } });
    if (/\/answer$/.test(url)) {
      const r = over.answer ?? { status: 202, body: { success: true, data: { accepted: true } } };
      return reply(r.status, r.body);
    }
    return reply(200, { ok: true });
  }));
  return calls;
}

function device(clientId: string, isLocal: boolean): DevicePresence {
  return { clientId, label: clientId === 'desk' ? 'MacBook' : 'iPhone', address: '', isLocal, connections: 1, connectedAt: 1, lastSeenAt: 1 };
}

function presence(opts: { held?: boolean; writer?: string | null } = {}) {
  usePresenceStore.setState({ pendingRequests: new Map() });
  usePresenceStore.getState().applyPresence({
    devices: [device('phone', false), device('desk', true)],
    controllers: opts.held ? [{ sessionId: 's1', clientId: 'desk', label: 'MacBook', since: 1, lastActivityAt: Date.now(), online: true }] : [],
    restoreOwner: 'desk',
    workspaceWriter: opts.writer === undefined ? 'desk' : opts.writer,
  });
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
  const card = waitingCardModel(s);
  return render(<Composer session={s} card={card} inputRef={createRef<HTMLTextAreaElement>()} />);
}

const type = (text: string) => fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } });
const sendButton = () => screen.getByTestId('composer-send');

beforeEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
  useQueueStore.setState({ queues: new Map() });
  presence();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Composer', () => {
  it('sends at once when the agent waits, through the Mac’s confirmed send', async () => {
    const calls = stubMac();
    renderComposer(session());
    type('run the tests');
    expect(sendButton()).toHaveTextContent('Send');
    fireEvent.click(sendButton());

    await waitFor(() => expect(calls.some((c) => c.url === '/api/sessions/s1/prompt')).toBe(true));
    const post = calls.find((c) => c.url === '/api/sessions/s1/prompt')!;
    expect(post.body).toMatchObject({ text: 'run the tests', mode: 'now' });
    expect(String(post.body?.key)).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
    expect(useComposerDraftStore.getState().drafts.s1).toBeUndefined();
    await screen.findByText('Sent');
    expect(calls.some((c) => /\/api\/sessions\/s1\/prompt\/.+/.test(c.url))).toBe(true);
  });

  it('keeps a draft per session on this phone', () => {
    stubMac();
    renderComposer(session());
    type('half a thought');
    expect(useComposerDraftStore.getState().drafts.s1).toBe('half a thought');
    expect(JSON.parse(localStorage.getItem('aasc.composerDrafts') ?? '{}')).toEqual({ s1: 'half a thought' });
  });

  it('while the agent works, queues an active item instead of sending', async () => {
    const calls = stubMac();
    renderComposer(session({ status: 'working' }));
    type('then update the docs');
    expect(sendButton()).toHaveTextContent('Queue');
    expect(screen.getByRole('button', { name: /^Stop/ })).toBeInTheDocument();
    fireEvent.click(sendButton());

    const items = useQueueStore.getState().queues.get('s1') ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: 'then update the docs', type: 'once', nextFireAt: 0 });
    expect(items[0].disabled).toBeUndefined();
    expect(calls.some((c) => c.url.endsWith('/prompt'))).toBe(false);
    expect(await screen.findByText('Queued · sent when Claude finishes')).toBeInTheDocument();
  });

  it('says a queued prompt waits for the Mac when no AASC window is open', () => {
    stubMac();
    presence({ writer: 'phone' });
    renderComposer(session({ status: 'working' }));
    expect(screen.getByText('Sent when AASC is open on your Mac')).toBeInTheDocument();
  });

  it('holding Queue offers Send now, which interrupts after a confirm', async () => {
    const calls = stubMac();
    renderComposer(session({ status: 'working' }));
    type('stop and do this instead');
    fireEvent.contextMenu(sendButton());
    expect(await screen.findByRole('dialog', { name: 'Send now?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop and send' }));

    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/prompt'))?.body).toMatchObject({ mode: 'interrupt', text: 'stop and do this instead' }));
  });

  const bash: PendingRequest = { id: 'toolu_9', kind: 'permission', cli: 'claude', tool: 'Bash', raisedAt: 1, source: 'permission_request', input: { command: 'rm -rf dist' } };

  it('while a permission waits, Send denies it, then tells Claude once the dialog closes', async () => {
    const calls = stubMac();
    renderComposer(session({ status: 'approval', pendingRequest: bash }));
    type('use the clean script instead');
    expect(sendButton()).toHaveTextContent('Deny and tell Claude');
    fireEvent.click(sendButton());

    await waitFor(() => expect(calls.some((c) => c.url === '/api/sessions/s1/requests/toolu_9/answer')).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/answer'))?.body).toEqual({ choice: 'deny' });
    expect(calls.some((c) => c.url.endsWith('/prompt'))).toBe(false);
    // The CLI takes the "No" and stops: the session leaves its dialog.
    act(() => { useSessionStore.setState({ sessions: new Map([['s1', session({ status: 'waiting' })]]) }); });

    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/prompt'))?.body).toMatchObject({ text: 'use the clean script instead', mode: 'now' }));
  });

  it('if the dialog doesn’t close, the message goes as an interrupt (the Mac presses Esc, "No", first)', async () => {
    const calls = stubMac();
    renderComposer(session({ status: 'approval', pendingRequest: bash }));
    type('use the clean script instead');
    fireEvent.click(sendButton());

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/prompt'))).toBe(true), { timeout: 5000 });
    expect(calls.find((c) => c.url.endsWith('/prompt'))?.body).toMatchObject({ mode: 'interrupt' });
  });

  it('a refused answer (the Mac didn\'t recognise the phone) stops there, keeping the text', async () => {
    const calls = stubMac({ answer: { status: 423, body: { code: 'control_held', driver: { label: 'MacBook', online: true } } } });
    renderComposer(session({ status: 'approval', pendingRequest: bash }));
    type('no, do this');
    fireEvent.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Your Mac didn’t recognise this phone');
    expect(calls.some((c) => c.url.endsWith('/prompt'))).toBe(false);
    expect(useComposerDraftStore.getState().drafts.s1).toBe('no, do this');
  });

  // Oct 2026, by request: no control baton for people. Another device having typed last leaves
  // the box on, with no "… is driving" banner.
  it('stays on, with no driving banner, while another device typed last', () => {
    stubMac();
    presence({ held: true });
    renderComposer(session());
    expect(screen.getByTestId('composer-input')).not.toBeDisabled();
    expect(screen.queryByTestId('driving-banner')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Your Mac is driving')).toBeNull();
  });

  it('puts the text back and says why when the Mac refuses it', async () => {
    stubMac({ prompt: { status: 409, body: { code: 'busy' } } });
    renderComposer(session());
    type('one more');
    fireEvent.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/still being typed/);
    expect(useComposerDraftStore.getState().drafts.s1).toBe('one more');
  });

  it('answers a bare /model with the model sheet instead of sending it', async () => {
    const calls = stubMac();
    renderComposer(session());
    type('/model');
    act(() => { fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Escape' }); });
    fireEvent.click(sendButton());
    expect(await screen.findByTestId('model-sheet')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^Sonnet/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Apply/ }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/prompt'))?.body).toMatchObject({ text: '/model sonnet', mode: 'now' }));
  });

  // Oct 2026, by request: model and effort picked in one visit. The Mac refuses a second prompt
  // while the first is still being typed, so the effort goes only once the model has landed.
  it('applies the model, then the effort once the model has landed', async () => {
    const calls = stubMac();
    renderComposer(session());
    fireEvent.click(screen.getByRole('button', { name: /^Model / }));
    expect(await screen.findByTestId('model-sheet')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^Sonnet/ })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: /^High/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Apply/ }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/prompt') && c.method === 'POST')).toHaveLength(2));
    const order = calls.map((c) => (c.url.endsWith('/prompt') && c.method === 'POST' ? `send ${c.body?.text}` : /\/prompt\/[^/]+$/.test(c.url) ? 'poll' : null)).filter(Boolean);
    expect(order.indexOf('send /model sonnet')).toBeLessThan(order.indexOf('poll'));
    expect(order.indexOf('poll')).toBeLessThan(order.indexOf('send /effort high'));
  });

  it('offers the model chip with an empty box', async () => {
    stubMac();
    renderComposer(session());
    const chip = screen.getByRole('button', { name: /^Model / });
    expect(chip).not.toHaveAttribute('aria-disabled');
    fireEvent.click(chip);
    expect(await screen.findByTestId('model-sheet')).toBeInTheDocument();
  });

  it.each([
    ['the session has ended', () => {}, session({ status: 'ended' }), 'This session has ended'],
    ['the agent is still starting', () => {}, session({ status: 'connecting' }), 'The agent is still starting'],
  ])('turns the model chip off, saying why, while %s', async (_label, setup, s, reason) => {
    const calls = stubMac();
    setup();
    renderComposer(s);
    const chip = screen.getByRole('button', { name: /^Model / });
    expect(chip).toHaveAttribute('aria-disabled', 'true');
    expect(chip).toHaveAccessibleDescription(reason);
    fireEvent.click(chip);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByTestId('model-sheet')).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/prompt'))).toBe(false);
    expect(useComposerDraftStore.getState().drafts.s1).toBeUndefined();
  });

  it('opens the queue from the "N queued" chip', () => {
    stubMac();
    useQueueStore.setState({ queues: new Map([['s1', [{ id: 1, sessionId: 's1', text: 'x', position: 0, createdAt: 1 }]]]) });
    renderComposer(session());
    expect(screen.getByRole('button', { name: /1 queued/ })).toBeInTheDocument();
  });
});
