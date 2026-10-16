// SessionTerminal.ai.test.tsx — AASC-57: an AI popup from the phone's Terminal. ⋯ → Ask AI asks about xterm's
// selection when there is one; otherwise it shows the terminal's text as selectable lines, and a selection
// there raises Ask AI. The popup forks the session of THIS terminal (spawnTerminalId), as the desktop's
// terminal popup does. Off with the session's AI-popup switch off; never on the plain shell.
// Nothing reaches a PTY: useTerminal and fetch are mocked.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone' }));
vi.mock('@/lib/presenceClient', () => ({
  claimControl: vi.fn(async () => ({ ok: true, controller: null })),
  requestControl: vi.fn(async () => ({ ok: true })),
  grantControl: vi.fn(async () => ({ ok: true, controller: null })),
  releaseControl: vi.fn(async () => ({ ok: true, released: true })),
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@/lib/translationLog', () => ({ createLog: vi.fn(async () => 'uuid-1') }));

const term = vi.hoisted(() => ({
  selection: null as string | null,
  text: 'npm test\n✓ 12 passed\nThe baton moves to the phone.\n',
}));
vi.mock('@/hooks/useTerminal', () => ({
  useTerminal: () => ({
    containerRef: { current: null },
    attach: vi.fn(),
    detach: vi.fn(),
    isAttached: true,
    terminalClosed: null,
    isFullscreen: false,
    toggleFullscreen: vi.fn(),
    sendKeys: vi.fn(),
    handleTerminalOutput: vi.fn(),
    handleTerminalGeometry: vi.fn(),
    handleTerminalReady: vi.fn(),
    handleTerminalClosed: vi.fn(),
    handleTerminalCleared: vi.fn(),
    widthMode: 'fit',
    setWidthMode: vi.fn(),
    fitState: null,
    textSize: 11,
    setTextSize: vi.fn(),
    reparent: vi.fn(),
    scrollToBottom: vi.fn(),
    refreshOutput: vi.fn(),
    clearOutput: vi.fn(),
    autoScrollEnabled: false,
    toggleAutoScroll: vi.fn(),
    readRecentText: () => ({ text: term.text, absBottom: 3 }),
    lineAtClientY: () => null,
    revealLine: () => true,
    getXtermSelection: () => term.selection,
    hasXtermSelection: () => !!term.selection,
  }),
}));

const socket = { readyState: 1, send: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as WebSocket;
vi.mock('@/stores/wsStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/wsStore')>();
  actual.useWsStore.setState({ connected: true, client: { getRawSocket: () => socket } as never });
  return actual;
});

import SessionTerminal from './SessionTerminal';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { settleLazy } from '@/__tests__/settleLazy';

const base = { sessionId: 's1', status: 'waiting', terminalId: 'term-1', opsTerminalId: 'ops-1', projectPath: '/p', source: 'ssh', cliSource: 'claude', events: [] };
const makeSession = (over: Partial<Session> = {}) => ({ ...base, ...over }) as unknown as Session;

let fetchMock: ReturnType<typeof vi.fn>;
const spawnBody = () => {
  const call = fetchMock.mock.calls.find(([url]) => url === '/api/sessions/spawn-floating') as [string, RequestInit] | undefined;
  return call ? JSON.parse(String(call[1].body)) : null;
};

async function renderTerminal(over: Partial<Session> = {}) {
  const s = makeSession(over);
  useSessionStore.setState({ sessions: new Map([['s1', s]]) });
  render(<SessionTerminal session={s} />);
  await settleLazy(() => import('../ai/PhoneSelectionAi'), () => import('../ai/TerminalTextSheet'), () => import('../PhoneAiPopupSheet'));
}

/** ⋯ → Ask AI about the terminal. */
function openAskAi() {
  fireEvent.click(screen.getByRole('button', { name: 'More terminal actions' }));
  fireEvent.click(screen.getByRole('button', { name: /Ask AI about the terminal/ }));
}

function selectText(el: Element, from: number, to: number) {
  act(() => {
    const range = document.createRange();
    range.setStart(el.firstChild!, from);
    range.setEnd(el.firstChild!, to);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

beforeAll(() => {
  class NoopObserver { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= NoopObserver;
});

beforeEach(() => {
  vi.clearAllMocks();
  term.selection = null;
  useSettingsStore.setState({
    translationEnabled: true, translationTrigger: 'auto', translationNativeLanguage: '简体中文',
    translationLearningLanguage: 'English', translationInheritContext: true,
    selectionSpawnModel: '', selectionSpawnCodexModel: '', selectionSpawnEffort: '',
  });
  useFloatingSessionsStore.setState({ floats: [], phoneShown: null });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, terminalId: 'term-f1', label: 'Explain (English)' })));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

describe('Ask AI from the phone’s Terminal', () => {
  it('asks about xterm’s own selection, forking THIS terminal’s session', async () => {
    term.selection = 'The baton moves';
    await renderTerminal();
    openAskAi();
    expect(await screen.findByRole('dialog', { name: 'Ask AI about the selection' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'In 简体中文' }));
    await waitFor(() => expect(spawnBody()).not.toBeNull());
    expect(spawnBody()).toMatchObject({ originSessionId: 's1', spawnTerminalId: 'term-1', mode: 'explain-native', selection: 'The baton moves' });
    await waitFor(() => expect(useFloatingSessionsStore.getState().phoneShown).toBe('term-f1'));
    expect(useFloatingSessionsStore.getState().floats[0]).toMatchObject({ originSessionId: 's1' });
  });

  it('without one, shows the terminal’s text to select; a selection there raises Ask AI', async () => {
    await renderTerminal();
    openAskAi();
    await settleLazy();
    const line = await screen.findByText('The baton moves to the phone.');
    expect(screen.getByTestId('terminal-text-sheet')).toBeTruthy();
    selectText(line, 4, 9);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Words, in 简体中文' }));
    await waitFor(() => expect(spawnBody()).not.toBeNull());
    expect(spawnBody()).toMatchObject({
      originSessionId: 's1', spawnTerminalId: 'term-1', mode: 'vocab-native', selection: 'baton', contextLine: 'The baton moves to the phone.',
    });
    // The popup is up: the text sheet steps aside.
    await waitFor(() => expect(screen.queryByTestId('terminal-text-sheet')).toBeNull());
  });

  it('translates the last answer from the text sheet, with no selection', async () => {
    await renderTerminal();
    openAskAi();
    await settleLazy();
    fireEvent.click(await screen.findByRole('button', { name: 'Translate the last answer…' }));
    // The choices sit under the text sheet's layer: the text steps aside while they're up, and comes back.
    expect(await screen.findByRole('dialog', { name: 'Ask AI' })).toBeTruthy();
    expect(screen.queryByTestId('terminal-text-sheet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByTestId('terminal-text-sheet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Translate the last answer…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Translate the last answer to 简体中文' }));
    await waitFor(() => expect(spawnBody()).not.toBeNull());
    expect(spawnBody()).toMatchObject({ originSessionId: 's1', spawnTerminalId: 'term-1', mode: 'translate-answer' });
  });

  it('is off where the desktop’s is off: the session’s AI-popup switch, or translation disabled', async () => {
    await renderTerminal({ aiPopupEnabled: false });
    fireEvent.click(screen.getByRole('button', { name: 'More terminal actions' }));
    expect(screen.queryByRole('button', { name: /Ask AI about the terminal/ })).toBeNull();
  });

  it('is on for a session that never set the switch (unset means on)', async () => {
    await renderTerminal({ aiPopupEnabled: undefined });
    fireEvent.click(screen.getByRole('button', { name: 'More terminal actions' }));
    expect(screen.getByRole('button', { name: /Ask AI about the terminal/ })).toBeTruthy();
  });
});
