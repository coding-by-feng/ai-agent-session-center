// Composer.quickReply.test.tsx — the composer's quick reply button (Oct 21 2026): a tap sends
// "proceed" (or this phone's own text) the way Send would, leaving the draft alone; while it works
// it queues; it is off while a card waits (Send would deny it); a hold edits the text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import type { PendingRequest, Session } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone', getWindowOriginId: () => 'phone:w' }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import Composer from './Composer';
import { useSessionStore } from '@/stores/sessionStore';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { useQueueStore } from '@/stores/queueStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { waitingCardModel } from '@/lib/chat/waitingCardModel';
import { QUICK_REPLY_KEY, resetQuickReplyForTest } from '@/lib/chat/quickReply';

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function stubMac(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    const reply = (status: number, json: unknown) => ({ ok: true, status, json: async () => json });
    if (/\/prompt$/.test(url) && method === 'POST') return reply(202, { success: true, data: { accepted: true, key: body?.key } });
    if (/\/prompt\/[^/]+$/.test(url)) return reply(200, { success: true, data: { key: 'k', state: 'submitted' } });
    return reply(200, { ok: true });
  }));
  return calls;
}

function session(extra: Partial<Session> = {}): Session {
  return {
    sessionId: 's1', status: 'waiting', cliSource: 'claude', projectName: 'p', projectPath: '/p/quick',
    terminalId: 'term-1', model: 'claude-opus-5-5', events: [], pendingRequest: null, pendingTool: null, pendingToolDetail: null, waitingDetail: null,
    ...extra,
  } as unknown as Session;
}

function renderComposer(s: Session) {
  useSessionStore.setState({ sessions: new Map([[s.sessionId, s]]) });
  return render(<Composer session={s} card={waitingCardModel(s)} inputRef={createRef<HTMLTextAreaElement>()} />);
}

const quick = () => screen.getByTestId('composer-quick-reply');
const prompts = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/prompt') && c.method === 'POST').map((c) => c.body);

beforeEach(() => {
  localStorage.clear();
  resetQuickReplyForTest();
  useComposerDraftStore.setState({ drafts: {} });
  useQueueStore.setState({ queues: new Map(), automation: new Map() });
  usePresenceStore.getState().applyPresence({ devices: [], controllers: [], restoreOwner: null, workspaceWriter: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the quick reply button', () => {
  it('sends "proceed" at once, through the Mac’s confirmed send, and leaves the typed draft alone', async () => {
    const calls = stubMac();
    renderComposer(session());
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'half a thought' } });
    expect(quick()).toHaveAccessibleName('Send “proceed”');
    fireEvent.click(quick());
    await waitFor(() => expect(prompts(calls)).toEqual([expect.objectContaining({ text: 'proceed', mode: 'now' })]));
    expect(useComposerDraftStore.getState().drafts.s1).toBe('half a thought');
  });

  it('queues it while the agent works, as Send would', () => {
    const calls = stubMac();
    renderComposer(session({ status: 'working' }));
    expect(quick()).toHaveAccessibleName('Queue “proceed”');
    fireEvent.click(quick());
    expect(useQueueStore.getState().queues.get('s1')?.map((i) => i.text)).toEqual(['proceed']);
    expect(prompts(calls)).toEqual([]);
  });

  it('is off while a card waits: Send would deny the tool call, so "proceed" never goes there', () => {
    const calls = stubMac();
    const bash: PendingRequest = { id: 'toolu_9', kind: 'permission', cli: 'claude', tool: 'Bash', raisedAt: 1, source: 'permission_request', input: { command: 'rm -rf dist' } };
    renderComposer(session({ status: 'approval', pendingRequest: bash }));
    expect(quick()).toHaveAttribute('aria-disabled', 'true');
    expect(quick()).toHaveAccessibleDescription(/Answer the card first/);
    fireEvent.click(quick());
    expect(calls.some((c) => c.url.includes('/prompt') || c.url.includes('/answer'))).toBe(false);
  });

  it('a hold edits the text, kept on this phone; the next tap sends it; Reset goes back to "proceed"', async () => {
    const calls = stubMac();
    vi.useFakeTimers();
    renderComposer(session());
    fireEvent.pointerDown(quick(), { pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.pointerUp(quick(), { pointerType: 'touch' });
    fireEvent.click(quick()); // the click that ends a hold sends nothing
    vi.useRealTimers();
    const field = await screen.findByRole('textbox', { name: 'Quick reply text' });
    expect(prompts(calls)).toEqual([]);
    fireEvent.change(field, { target: { value: 'go on with your recommendations' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(localStorage.getItem(QUICK_REPLY_KEY)).toBe('go on with your recommendations');
    await waitFor(() => expect(quick()).toHaveAccessibleName('Send “go on with your recommendations”'));
    fireEvent.click(quick());
    await waitFor(() => expect(prompts(calls)).toEqual([expect.objectContaining({ text: 'go on with your recommendations' })]));

    fireEvent.contextMenu(quick()); // a long press on iOS / a right click opens it too
    fireEvent.click(await screen.findByRole('button', { name: 'Reset to “proceed”' }));
    expect(localStorage.getItem(QUICK_REPLY_KEY)).toBeNull();
    await waitFor(() => expect(quick()).toHaveAccessibleName('Send “proceed”'));
  });

  it('can’t save a blank reply', async () => {
    stubMac();
    renderComposer(session());
    fireEvent.contextMenu(quick());
    const field = await screen.findByRole('textbox', { name: 'Quick reply text' });
    fireEvent.change(field, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(localStorage.getItem(QUICK_REPLY_KEY)).toBeNull();
  });
});

// Oct 23 2026: when the last answer asks "Reply proceed…", P lights up so the reply is one obvious tap.
describe('the quick reply button while a "proceed" is owed', () => {
  it('lights up and says why', () => {
    stubMac();
    renderComposer(session({ status: 'idle', pendingProceedAt: 1 }));
    expect(quick()).toHaveAttribute('data-pending', 'true');
    expect(quick()).toHaveAccessibleDescription(/The last answer asks you to proceed/);
  });

  it('stays plain when nothing is owed', () => {
    stubMac();
    renderComposer(session({ status: 'waiting', pendingProceedAt: null }));
    expect(quick()).not.toHaveAttribute('data-pending');
    expect(quick()).not.toHaveAccessibleDescription(/asks you to proceed/);
  });

  it('stays plain while a card waits: the card comes first', () => {
    stubMac();
    const bash: PendingRequest = { id: 'toolu_9', kind: 'permission', cli: 'claude', tool: 'Bash', raisedAt: 1, source: 'permission_request', input: { command: 'ls' } };
    renderComposer(session({ status: 'approval', pendingRequest: bash, pendingProceedAt: 1 }));
    expect(quick()).not.toHaveAttribute('data-pending');
  });
});
