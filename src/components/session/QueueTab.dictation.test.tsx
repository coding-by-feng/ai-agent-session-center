/**
 * The queue compose box's 🎙 (Nov 27 2026): the phone app only. The spoken words go into the box and
 * nothing is added to the queue; an older app or a desktop draws no mic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import QueueTab from './QueueTab';
import { useQueueStore } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { resetPhoneSkillNotesCache } from '@/lib/phoneSuggestions';
import { DICTATION_EVENT, DICTATION_HANDLER } from '@/lib/phoneDictation';
import { settleLazy } from '@/__tests__/settleLazy';
import type { Session } from '@/types';

vi.mock('@/lib/terminalSend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/terminalSend')>()),
  sendPromptToTerminal: vi.fn(async () => true),
}));
const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));
vi.mock('@/components/ui/ToastContainer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/ToastContainer')>()),
  showToast: vi.fn(),
}));
vi.mock('./QueueItemEditModal', () => ({ default: () => null }));
vi.mock('./QueueHistorySheet', () => ({ default: () => null }));
vi.mock('./LoopExcludeWindowsModal', () => ({ default: () => null }));

let dictateAnswer: { status: number; body: unknown } = { status: 200, body: { success: true, data: { text: 'run the tests' } } };
const urls: string[] = [];
const fetchMock = vi.fn(async (url: string) => {
  urls.push(url);
  if (url === '/api/voice/dictate') return new Response(JSON.stringify(dictateAnswer.body), { status: dictateAnswer.status });
  if (url === '/api/skill-notes/favorites') return new Response(JSON.stringify({ source: 'none', entries: [] }));
  if (url.startsWith('/api/commands')) return new Response(JSON.stringify({ entries: [] }));
  return new Response('{}');
});

function installApp() {
  const posted: Array<{ id: string; action: string }> = [];
  (window as unknown as { webkit?: unknown }).webkit = {
    messageHandlers: { [DICTATION_HANDLER]: { postMessage: (m: { id: string; action: string }) => posted.push(m) } },
  };
  const answer = (detail: Record<string, unknown>) => act(() => { window.dispatchEvent(new CustomEvent(DICTATION_EVENT, { detail })); });
  return { posted, answer };
}

const draftText = () => useQueueStore.getState().composeDrafts.get('s1')?.text ?? '';
const renderTab = () => render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" fullHeight />);

beforeEach(() => {
  platform.isMobile = true;
  urls.length = 0;
  dictateAnswer = { status: 200, body: { success: true, data: { text: 'run the tests' } } };
  resetPhoneSkillNotesCache();
  vi.stubGlobal('fetch', fetchMock);
  useUiStore.setState({ queuePanelCollapsed: false });
  useSessionStore.setState({
    sessions: new Map([['s1', { sessionId: 's1', title: 'AASC', projectName: 'agent-manager', projectPath: '/p/x', status: 'waiting', cliSource: 'claude' } as unknown as Session]]),
    selectedSessionId: 's1',
  });
  useQueueStore.setState({ queues: new Map([['s1', []]]), automation: new Map(), composeDrafts: new Map() });
});

afterEach(() => {
  delete (window as unknown as { webkit?: unknown }).webkit;
  vi.unstubAllGlobals();
});

describe('the queue compose box’s 🎙', () => {
  it('is not there without the app’s recorder', async () => {
    renderTab();
    await settleLazy();
    expect(screen.getByRole('button', { name: 'ADD' })).toBeTruthy();
    expect(screen.queryByTestId('dictate-button')).toBeNull();
  });

  it('is not on the desktop, even with a recorder', async () => {
    platform.isMobile = false;
    installApp();
    renderTab();
    await settleLazy();
    expect(screen.queryByTestId('dictate-button')).toBeNull();
  });

  it('puts the spoken words after what is typed and adds nothing to the queue', async () => {
    const app = installApp();
    useQueueStore.getState().setComposeDraft('s1', { text: 'then' });
    renderTab();
    const mic = await screen.findByTestId('dictate-button');
    fireEvent.pointerDown(mic);
    expect(screen.getByTestId('dictation-line').textContent).toMatch(/Listening/);
    fireEvent.pointerDown(mic);
    app.answer({ id: app.posted[0].id, state: 'audio', audio: 'QUJD', mime: 'audio/mp4', ms: 1500 });
    await waitFor(() => expect(draftText()).toBe('then run the tests'));
    expect(urls.filter((u) => u === '/api/voice/dictate')).toHaveLength(1);
    expect(useQueueStore.getState().queues.get('s1')).toEqual([]);
    expect(screen.queryByTestId('dictation-line')).toBeNull();
  });

  it('a switch to another session ends the recording, so its words never land in the other draft (review, Nov 27 2026)', async () => {
    const app = installApp();
    useSessionStore.setState({
      sessions: new Map([
        ['s1', { sessionId: 's1', title: 'AASC', projectName: 'a', projectPath: '/p/x', status: 'waiting', cliSource: 'claude' } as unknown as Session],
        ['s2', { sessionId: 's2', title: 'B', projectName: 'b', projectPath: '/p/y', status: 'waiting', cliSource: 'claude' } as unknown as Session],
      ]),
    });
    useQueueStore.setState({ queues: new Map([['s1', []], ['s2', []]]) });
    const view = renderTab();
    const mic = await screen.findByTestId('dictate-button');
    fireEvent.pointerDown(mic);
    fireEvent.pointerDown(mic);
    const id = app.posted[0].id;
    view.rerender(<QueueTab sessionId="s2" sessionStatus="waiting" terminalId="term-2" fullHeight />);
    await settleLazy();
    app.answer({ id, state: 'audio', audio: 'QUJD', mime: 'audio/mp4', ms: 1500 });
    await new Promise((r) => setTimeout(r, 20));
    expect(useQueueStore.getState().composeDrafts.get('s2')?.text ?? '').toBe('');
    expect(draftText()).toBe('');
  });

  it('shows an error that can be dismissed, and leaves the box alone', async () => {
    dictateAnswer = { status: 502, body: { success: false, code: 'network', error: 'The Mac could not reach OpenAI.' } };
    const app = installApp();
    renderTab();
    const mic = await screen.findByTestId('dictate-button');
    fireEvent.pointerDown(mic);
    fireEvent.pointerDown(mic);
    app.answer({ id: app.posted[0].id, state: 'audio', audio: 'QUJD', mime: 'audio/mp4', ms: 1500 });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/OpenAI/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(draftText()).toBe('');
  });
});
