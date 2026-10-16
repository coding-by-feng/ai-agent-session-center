// PhoneFileView.ai.test.tsx — AASC-57: an AI popup from a project file on the phone. Selected text in the
// file raises Ask AI (every selection mode); the Project header's ✦ offers the selection's modes, or with nothing
// selected, "Translate the whole file". The file's text is the one the read-only route served; the popup
// forks the session whose Project tab this is. fetch is mocked: nothing reaches a PTY.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@/types';

vi.mock('@/lib/translationLog', () => ({ createLog: vi.fn(async () => 'uuid-1') }));

import PhoneFileView from './PhoneFileView';
import PhoneProjectBrowser from './PhoneProjectBrowser';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { settleLazy } from '@/__tests__/settleLazy';

const ROOT = '/Users/me/proj';
const MD = '# Guide\n\nThe baton moves to the phone.\n';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let fetchMock: ReturnType<typeof vi.fn>;
const spawnBody = () => {
  const call = fetchMock.mock.calls.find(([url]) => url === '/api/sessions/spawn-floating') as [string, RequestInit] | undefined;
  return call ? JSON.parse(String(call[1].body)) : null;
};

/** The session's Project tab, then docs/<name> opened from its folder. */
async function renderFile(path = '/docs/guide.md') {
  render(<PhoneProjectBrowser projectPath={ROOT} sessionId="s1" />);
  fireEvent.click(await screen.findByText('docs'));
  fireEvent.click(await screen.findByText(path.split('/').pop()!));
  await settleLazy(() => import('./ai/PhoneSelectionAi'), () => import('./PhoneAiPopupSheet'), () => import('./PhoneMarkdown'));
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
  useSessionStore.setState({
    sessions: new Map([['s1', { sessionId: 's1', projectPath: ROOT, projectName: 'proj', cliSource: 'claude', status: 'waiting', events: [] } as unknown as Session]]),
  });
  useSettingsStore.setState({
    translationEnabled: true, translationTrigger: 'auto', translationNativeLanguage: '简体中文',
    translationLearningLanguage: 'English', translationInheritContext: true, explainAttachFilePath: 'never',
    selectionSpawnModel: '', selectionSpawnCodexModel: '', selectionSpawnEffort: '',
  });
  useFloatingSessionsStore.setState({ floats: [], phoneShown: null });
  fetchMock = vi.fn(async (url: string) => {
    const u = new URL(url, 'http://phone');
    if (u.pathname === '/api/files/list') {
      const dir = u.searchParams.get('path') ?? '/';
      return json({ path: dir, items: dir === '/' ? [{ name: 'docs', type: 'dir' }] : [{ name: 'guide.md', type: 'file', size: MD.length }, { name: 'h.png', type: 'file', size: 9 }] });
    }
    if (u.pathname === '/api/files/read') {
      const path = u.searchParams.get('path') ?? '';
      if (path.endsWith('.png')) return json({ path, name: 'h.png', size: 9, ext: 'png', streamable: true });
      return json({ path, name: 'guide.md', size: MD.length, ext: 'md', content: MD });
    }
    if (u.pathname === '/api/sessions/spawn-floating') return json({ ok: true, terminalId: 'term-f1', label: 'Translate file → 简体中文' });
    return json({ error: 'Not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

describe('Ask AI from a project file', () => {
  it('translates the whole file from the toolbar: its text and absolute path', async () => {
    await renderFile();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask AI about this file' }));
    expect(screen.getByRole('dialog', { name: 'Ask AI about this file' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Translate the whole file to 简体中文' }));
    await waitFor(() => expect(spawnBody()).not.toBeNull());
    expect(spawnBody()).toMatchObject({ originSessionId: 's1', mode: 'translate-file', filePath: `${ROOT}/docs/guide.md`, fileContent: MD });
    expect(spawnBody().spawnTerminalId).toBeUndefined();
    await waitFor(() => expect(useFloatingSessionsStore.getState().phoneShown).toBe('term-f1'));
  });

  it.each([
    ['explain-learning', 'In English'],
    ['explain-native', 'In 简体中文'],
    ['translate-selection-learning', 'To English'],
    ['translate-selection-native', 'To 简体中文'],
    ['vocab-native', 'Words, in 简体中文'],
  ])('a selection in the file starts %s', async (mode, button) => {
    await renderFile();
    selectText(await screen.findByText('The baton moves to the phone.'), 4, 9);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    fireEvent.click(await screen.findByRole('button', { name: button }));
    await waitFor(() => expect(spawnBody()).not.toBeNull());
    expect(spawnBody()).toMatchObject({ originSessionId: 's1', mode, selection: 'baton' });
    expect(spawnBody().fileContent).toBeUndefined();
  });

  it('the toolbar’s ✦ takes the selection too, and your own prompt goes with it', async () => {
    await renderFile();
    selectText(await screen.findByText('The baton moves to the phone.'), 4, 9);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI about this file' }));
    fireEvent.change(screen.getByRole('textbox', { name: /your own prompt/i }), { target: { value: 'Why a baton?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(spawnBody()).not.toBeNull());
    expect(spawnBody()).toMatchObject({ mode: 'custom', customPrompt: 'Why a baton?', selection: 'baton' });
  });

  it('an image has no text to translate whole', async () => {
    await renderFile('/docs/h.png');
    fireEvent.click(await screen.findByRole('button', { name: 'Ask AI about this file' }));
    expect(screen.getByRole('button', { name: 'Translate the whole file to 简体中文' })).toBeDisabled();
  });

  it('offers nothing with the session’s AI popups off, or outside a session', async () => {
    useSessionStore.setState({
      sessions: new Map([['s1', { sessionId: 's1', projectPath: ROOT, cliSource: 'claude', status: 'waiting', aiPopupEnabled: false, events: [] } as unknown as Session]]),
    });
    const { unmount } = render(<PhoneProjectBrowser projectPath={ROOT} sessionId="s1" />);
    fireEvent.click(await screen.findByText('docs'));
    fireEvent.click(await screen.findByText('guide.md'));
    await settleLazy(() => import('./ai/PhoneSelectionAi'), () => import('./PhoneMarkdown'));
    selectText(await screen.findByText('The baton moves to the phone.'), 4, 9);
    expect(screen.queryByRole('button', { name: 'Ask AI about this file' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
    unmount();
    render(
      <PhoneFileView projectPath={ROOT} path="/docs/guide.md" fullscreen={false} onToggleFullscreen={() => {}} onOpenFile={() => {}} />,
    );
    await settleLazy(() => import('./PhoneMarkdown'));
    await screen.findByText('The baton moves to the phone.');
    expect(document.querySelector('[data-ai-selectable]')).toBeNull();
  });
});
