// PhoneAiPopupSheet.test.tsx — AASC-57: the phone's AI popup offers the desktop's modes from every
// source (Chat, Terminal, a project file, a popup's answer). Each mode sends the desktop's payload to
// spawn-floating, and the popup opens in the phone's sheet under the ROOT session. No PTY is spawned:
// fetch is mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@/types';

vi.mock('@/lib/translationLog', () => ({ createLog: vi.fn(async () => 'uuid-1') }));

import { createLog } from '@/lib/translationLog';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import type { AiSource } from '@/lib/floatingSpawn';
import PhoneAiPopupSheet from '../PhoneAiPopupSheet';

const session = (over: Partial<Session> = {}): Session => ({
  sessionId: 'root', title: 'AASC', projectName: 'proj', projectPath: '/w/proj', status: 'waiting',
  cliSource: 'claude', events: [], promptHistory: [], ...over,
}) as unknown as Session;

const SOURCES: Record<string, AiSource> = {
  chat: { kind: 'chat' },
  terminal: { kind: 'terminal', spawnTerminalId: 'term-main' },
  file: { kind: 'file', filePath: '/w/proj/docs/guide.md', fileContent: '# Guide\nRead me.' },
  popup: { kind: 'popup', spawnTerminalId: 'term-pop' },
};

// The six selection choices, by the button that starts each (languages: English / 简体中文).
const SELECTION_BUTTONS: ReadonlyArray<[string, string]> = [
  ['explain-learning', 'In English'],
  ['explain-native', 'In 简体中文'],
  ['translate-selection-learning', 'To English'],
  ['translate-selection-native', 'To 简体中文'],
  ['vocab-native', 'Words, in 简体中文'],
];

let fetchMock: ReturnType<typeof vi.fn>;
const onClose = vi.fn();

function sheet(source: AiSource, selection: { text: string; contextLine?: string } | null = { text: 'the baton', contextLine: 'Only one device holds the baton.' }) {
  return render(<PhoneAiPopupSheet open selection={selection} originSessionId="root" source={source} onClose={onClose} />);
}

const lastBody = () => JSON.parse(String((fetchMock.mock.calls.at(-1) as [string, RequestInit])[1].body));

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.setState({ sessions: new Map([['root', session()]]) });
  useSettingsStore.setState({
    translationEnabled: true, translationTrigger: 'auto', translationNativeLanguage: '简体中文',
    translationLearningLanguage: 'English', translationInheritContext: true, explainAttachFilePath: 'never',
    selectionSpawnModel: '', selectionSpawnCodexModel: '', selectionSpawnEffort: '',
  });
  useFloatingSessionsStore.setState({ floats: [], phoneShown: null });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, terminalId: 'term-f1', label: 'AI popup' })));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('every selection mode from every source', () => {
  for (const [name, source] of Object.entries(SOURCES)) {
    it.each(SELECTION_BUTTONS)(`${name}: %s`, async (mode, button) => {
      sheet(source);
      fireEvent.click(screen.getByRole('button', { name: button }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/spawn-floating');
      const body = lastBody();
      expect(body).toMatchObject({
        originSessionId: 'root', mode, selection: 'the baton', contextLine: 'Only one device holds the baton.',
        nativeLanguage: '简体中文', learningLanguage: 'English', inheritContext: true,
      });
      expect(body.spawnTerminalId).toBe(source.spawnTerminalId);
      expect(body.fileContent).toBeUndefined();
      // Shown at once, under the root session (never under a popup that is never selected).
      await waitFor(() => expect(useFloatingSessionsStore.getState().phoneShown).toBe('term-f1'));
      expect(useFloatingSessionsStore.getState().floats).toEqual([expect.objectContaining({ terminalId: 'term-f1', originSessionId: 'root' })]);
      expect(createLog).toHaveBeenCalledWith(expect.objectContaining({ mode, floatTerminalId: 'term-f1', originSessionId: 'root' }));
      expect(onClose).toHaveBeenCalled();
    });

    it(`${name}: your own prompt`, async () => {
      sheet(source);
      fireEvent.change(screen.getByRole('textbox', { name: /your own prompt/i }), { target: { value: 'Is this safe?' } });
      fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(lastBody()).toMatchObject({ mode: 'custom', customPrompt: 'Is this safe?', selection: 'the baton' });
      expect(lastBody().spawnTerminalId).toBe(source.spawnTerminalId);
    });
  }
});

describe('the last answer (Chat and Terminal)', () => {
  it.each([['chat'], ['terminal']])('%s: translates the session’s last answer, no selection needed', async (name) => {
    sheet(SOURCES[name], null);
    expect(screen.getByRole('dialog', { name: 'Ask AI' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Translate the last answer to 简体中文' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = lastBody();
    expect(body).toMatchObject({ originSessionId: 'root', mode: 'translate-answer' });
    expect(body.selection).toBeUndefined();
    expect(body.spawnTerminalId).toBe(SOURCES[name].spawnTerminalId);
  });

  it('is offered with a selection too, and never from a file or a popup', () => {
    const { unmount } = sheet(SOURCES.chat);
    expect(screen.getByRole('button', { name: 'Translate the last answer to 简体中文' })).toBeTruthy();
    unmount();
    for (const name of ['file', 'popup']) {
      const view = sheet(SOURCES[name]);
      expect(screen.queryByRole('button', { name: /last answer/ })).toBeNull();
      view.unmount();
    }
  });

  // Oct 30 2026: the Mac reads a Codex answer from its rollout, so a Codex session translates it too.
  it('a Codex session translates its last answer as well', async () => {
    useSessionStore.setState({ sessions: new Map([['root', session({ cliSource: 'codex' })]]) });
    sheet(SOURCES.chat, null);
    const button = screen.getByRole('button', { name: 'Translate the last answer to 简体中文' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastBody()).toMatchObject({ originSessionId: 'root', mode: 'translate-answer' });
  });
});

describe('a project file', () => {
  it('translates the whole file: its text and path, from the file with no selection', async () => {
    sheet(SOURCES.file, null);
    expect(screen.getByRole('dialog', { name: 'Ask AI about this file' })).toBeTruthy();
    expect(screen.getByText(/Select text in the file/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Translate the whole file to 简体中文' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastBody()).toMatchObject({
      originSessionId: 'root', mode: 'translate-file', filePath: '/w/proj/docs/guide.md', fileContent: '# Guide\nRead me.',
    });
    expect(createLog).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'translate-file', fileContent: '# Guide\nRead me.', sourceFilePath: '/w/proj/docs/guide.md',
    }));
  });

  it('says why a file without text can’t be translated whole', () => {
    sheet({ kind: 'file', filePath: '/w/proj/a.pdf' }, null);
    expect(screen.getByRole('button', { name: 'Translate the whole file to 简体中文' })).toHaveAccessibleDescription(/text file/);
  });

  it('asks once whether to name the file in an explanation, and remembers the answer', async () => {
    useSettingsStore.setState({ explainAttachFilePath: 'ask' });
    sheet(SOURCES.file);
    fireEvent.click(screen.getByRole('button', { name: 'In 简体中文' }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Name the file' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastBody()).toMatchObject({ mode: 'explain-native', filePath: '/w/proj/docs/guide.md' });
    expect(useSettingsStore.getState().explainAttachFilePath).toBe('always');
  });
});

it('shows the Mac’s refusal (a session not shared with this phone) and opens nothing', async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 }));
  sheet(SOURCES.terminal);
  fireEvent.click(screen.getByRole('button', { name: 'To English' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Session not found');
  expect(useFloatingSessionsStore.getState().floats).toEqual([]);
  expect(onClose).not.toHaveBeenCalled();
});
