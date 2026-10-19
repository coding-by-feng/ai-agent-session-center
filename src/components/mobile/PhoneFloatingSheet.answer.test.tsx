// PhoneFloatingSheet.answer.test.tsx — AASC-57: an AI popup's answer on the phone. The sheet opens on the
// popup's OWN conversation (the answer, whole, with Copy · Read aloud · Ask AI); a follow-up goes to the
// popup's session through the prompt route, never to the session it came from; Ask AI on the answer forks
// the popup (its terminal) while the new popup shows under the root; Terminal shows the raw terminal.
// Nothing reaches a PTY: the chat page, fetch and the terminal are mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Session } from '@/types';
import type { ChatPage } from '@/types/chat';
import type { ApiResult, PageCursor } from '@/lib/chat/chatApi';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));
vi.mock('@/components/terminal/TerminalContainer', () => ({
  default: (p: { terminalId: string; controlSessionId?: string | null }) => (
    <div data-testid="float-terminal" data-terminal={p.terminalId} data-control={p.controlSessionId ?? ''} />
  ),
}));
vi.mock('@/components/session/FloatingTerminalPanel', () => ({ default: () => <div data-testid="float-panel" /> }));
vi.mock('@/hooks/useControlBaton', () => ({
  useControlBaton: () => ({ mode: 'solo', holder: undefined, canTake: true, waitSecs: 0, ask: vi.fn(), take: vi.fn(), release: vi.fn(), keep: vi.fn(), grant: vi.fn() }),
}));
vi.mock('@/lib/translationLog', () => ({ createLog: vi.fn(async () => 'uuid-1'), captureResponse: vi.fn(async () => {}) }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const ANSWER = 'A baton is the token one device holds to drive a session.';
const fetchChatPage = vi.fn<(id: string, cursor?: PageCursor) => Promise<ApiResult<ChatPage>>>();
vi.mock('@/lib/chat/chatApi', () => ({ fetchChatPage: (id: string, cursor?: PageCursor) => fetchChatPage(id, cursor) }));

import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import FloatingTerminalRoot from '@/components/session/FloatingTerminalRoot';

const s = (sessionId: string, over: Partial<Session> = {}) => ({
  sessionId, status: 'waiting', cliSource: 'claude', projectPath: '/w/proj', projectName: 'proj', events: [], promptHistory: [], responseLog: [], ...over,
}) as unknown as Session;

let fetchMock: ReturnType<typeof vi.fn>;
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), method: (init as RequestInit | undefined)?.method ?? 'GET', body: (init as RequestInit | undefined)?.body }));

beforeEach(() => {
  vi.clearAllMocks();
  platform.isMobile = true;
  useChatStore.getState().clearAll();
  useComposerDraftStore.setState({ drafts: {} });
  fetchChatPage.mockImplementation(async (id) => ({
    ok: true,
    data: {
      entries: id === 'fork-2'
        ? [
          { key: '10:0', timestamp: 1, kind: 'user', text: 'Explain the following in English…' },
          { key: '20:0', timestamp: 2, kind: 'assistant', text: ANSWER },
        ]
        : [],
      before: null, after: 'a1', cli: 'claude', hasMore: false,
    },
  } as ApiResult<ChatPage>));
  useSettingsStore.setState({
    translationEnabled: true, translationTrigger: 'auto', translationNativeLanguage: '简体中文',
    translationLearningLanguage: 'English', translationInheritContext: true,
    selectionSpawnModel: '', selectionSpawnCodexModel: '', selectionSpawnEffort: '',
    // Read aloud shows once Voice is set up on the phone (Oct 20 2026).
    ttsEnabled: true, googleTtsApiKey: 'AIza-test',
  });
  useFloatingSessionsStore.setState({
    floats: [{ terminalId: 't-2', label: 'Explain (English)', originSessionId: 'root', createdAt: 1 }],
    poppedOut: [], phoneShown: 't-2',
  });
  useSessionStore.setState({
    selectedSessionId: 'root',
    sessions: new Map([
      ['root', s('root', { terminalId: 't-root' })],
      ['fork-2', s('fork-2', { terminalId: 't-2', isFloating: true, isFork: true })],
    ]),
  });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (/\/prompt$/.test(url)) return new Response(JSON.stringify({ success: true, data: { accepted: true, key: body?.key } }), { status: 202 });
    if (/\/prompt\/[^/]+$/.test(url)) return new Response(JSON.stringify({ success: true, data: { key: 'k', state: 'submitted' } }));
    if (url === '/api/sessions/spawn-floating') return new Response(JSON.stringify({ ok: true, terminalId: 'term-f9', label: 'Explain (中文)' }));
    return new Response(JSON.stringify({ ok: true }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('the AI popup’s answer on a phone', () => {
  it('opens on the popup’s own conversation: the answer with Copy, Read aloud and Ask AI', async () => {
    render(<FloatingTerminalRoot />);
    const answer = await screen.findByTestId('phone-float-answer');
    expect(await within(answer).findByText(ANSWER)).toBeTruthy();
    expect(fetchChatPage).toHaveBeenCalledWith('fork-2', undefined);
    expect(fetchChatPage).not.toHaveBeenCalledWith('root', expect.anything());
    expect(within(answer).getByRole('button', { name: 'Copy this answer' })).toBeTruthy();
    expect(within(answer).getByRole('button', { name: 'Read aloud' })).toBeTruthy();
    expect(await within(answer).findByRole('button', { name: 'Ask AI about this answer' })).toBeTruthy();
    expect(screen.queryByTestId('float-terminal')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Answer' })).toHaveAttribute('aria-selected', 'true');
  });

  it('sends a follow-up to the popup’s session through the Mac, never to the session it came from', async () => {
    render(<FloatingTerminalRoot />);
    await screen.findByText(ANSWER);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'And in one sentence?' } });
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(calls().some((c) => c.method === 'POST' && c.url.endsWith('/prompt'))).toBe(true));
    const prompts = calls().filter((c) => c.method === 'POST' && c.url.endsWith('/prompt'));
    expect(prompts.map((c) => c.url)).toEqual(['/api/sessions/fork-2/prompt']);
    expect(JSON.parse(String(prompts[0].body))).toMatchObject({ text: 'And in one sentence?', mode: 'now' });
    expect(calls().some((c) => c.url.includes('/sessions/root/') || c.url.includes('/terminals/t-root'))).toBe(false);
  });

  it('Ask AI on the answer forks the popup and shows the new one under the session on screen', async () => {
    render(<FloatingTerminalRoot />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask AI about this answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'In 简体中文' }));
    await waitFor(() => expect(calls().some((c) => c.url === '/api/sessions/spawn-floating')).toBe(true));
    const spawn = calls().find((c) => c.url === '/api/sessions/spawn-floating')!;
    expect(JSON.parse(String(spawn.body))).toMatchObject({
      originSessionId: 'root', spawnTerminalId: 't-2', mode: 'explain-native', selection: ANSWER,
    });
    await waitFor(() => expect(useFloatingSessionsStore.getState().phoneShown).toBe('term-f9'));
    expect(useFloatingSessionsStore.getState().floats.find((f) => f.terminalId === 'term-f9')).toMatchObject({ originSessionId: 'root' });
  });

  it('Terminal shows the popup’s terminal, with the popup’s own session at the keys', async () => {
    render(<FloatingTerminalRoot />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Terminal' }));
    const terminal = await screen.findByTestId('float-terminal');
    expect(terminal.dataset.terminal).toBe('t-2');
    expect(terminal.dataset.control).toBe('fork-2');
    expect(screen.queryByTestId('phone-float-answer')).toBeNull();
  });

  it('says a popup just started is starting, then opens its answer once the Mac announces it', async () => {
    useFloatingSessionsStore.setState({ floats: [{ terminalId: 't-2', label: 'Explain (English)', originSessionId: 'root', createdAt: Date.now() }] });
    useSessionStore.setState({ sessions: new Map([['root', s('root', { terminalId: 't-root' })]]) });
    render(<FloatingTerminalRoot />);
    expect(await screen.findByText('Starting the AI popup…')).toBeTruthy();
    expect(screen.queryByTestId('float-terminal')).toBeNull();
    act(() => {
      useSessionStore.setState((st) => ({ sessions: new Map([...st.sessions, ['fork-2', s('fork-2', { terminalId: 't-2', isFloating: true })]]) }));
    });
    expect(await screen.findByText(ANSWER)).toBeTruthy();
    expect(screen.queryByTestId('float-terminal')).toBeNull();
  });

  it('shows the terminal when the popup’s session was never announced', async () => {
    useSessionStore.setState({ sessions: new Map([['root', s('root', { terminalId: 't-root' })]]) });
    render(<FloatingTerminalRoot />);
    expect(await screen.findByTestId('float-terminal')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Answer' })).toBeNull();
  });
});
