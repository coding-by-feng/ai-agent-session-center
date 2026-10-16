// PhoneReview.popups.test.tsx — AASC-57: popups made on the phone appear in Review, as on the desktop.
// Real IndexedDB (fake-indexeddb) and the real log writer: a popup started from the phone's sheets (Chat,
// Terminal, a file) is listed in the phone's Review with its mode and source, and its captured answer.
// fetch is mocked: nothing reaches a PTY.
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Session } from '@/types';

configure({ asyncUtilTimeout: 8000 });
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import { db } from '@/lib/db';
import { captureResponse } from '@/lib/translationLog';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import PhoneAiPopupSheet from '../PhoneAiPopupSheet';
import PhoneReview from './PhoneReview';

let n = 0;

beforeEach(async () => {
  await db.translationLogs.clear();
  useSessionStore.setState({
    sessions: new Map([['root', { sessionId: 'root', title: 'AASC', projectName: 'proj', projectPath: '/w/proj', cliSource: 'claude', status: 'waiting', events: [] } as unknown as Session]]),
  });
  useSettingsStore.setState({
    translationEnabled: true, translationTrigger: 'auto', translationNativeLanguage: '简体中文',
    translationLearningLanguage: 'English', translationInheritContext: true, explainAttachFilePath: 'never',
    selectionSpawnModel: '', selectionSpawnCodexModel: '', selectionSpawnEffort: '',
  });
  useFloatingSessionsStore.setState({ floats: [], phoneShown: null });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, terminalId: `term-${(n += 1)}`, label: 'AI popup' }))));
});

afterEach(() => vi.unstubAllGlobals());

async function spawnFromSheet(props: Parameters<typeof PhoneAiPopupSheet>[0], button: string) {
  const view = render(<PhoneAiPopupSheet {...props} />);
  fireEvent.click(screen.getByRole('button', { name: button }));
  await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  view.unmount();
}

describe('Review lists the popups made on the phone', () => {
  it('a terminal explanation and a file translation, with their source and answer', async () => {
    await spawnFromSheet({
      open: true, selection: { text: 'the baton' }, originSessionId: 'root',
      source: { kind: 'terminal', spawnTerminalId: 'term-main' }, onClose: vi.fn(),
    }, 'In 简体中文');
    await spawnFromSheet({
      open: true, selection: null, originSessionId: 'root',
      source: { kind: 'file', filePath: '/w/proj/docs/guide.md', fileContent: '# Guide\nRead me first.' }, onClose: vi.fn(),
    }, 'Translate the whole file to 简体中文');
    // The 6 s capture (FloatingTerminalRoot → captureNow) fills the answer in.
    await waitFor(async () => expect(await db.translationLogs.count()).toBe(2));
    const explain = (await db.translationLogs.toArray()).find((r) => r.mode === 'explain-native')!;
    await captureResponse(explain.floatTerminalId, 'A baton is a token one device holds.');

    render(<MemoryRouter initialEntries={['/review']}><PhoneReview /></MemoryRouter>);
    expect(await screen.findByText('2 entries saved on this device')).toBeTruthy();
    expect(screen.getByText('Explain (native)')).toBeTruthy();
    expect(screen.getByText('the baton')).toBeTruthy();
    expect(screen.getByText('Translate file')).toBeTruthy();
    expect(screen.getByText(/# Guide/)).toBeTruthy();

    const rows = await db.translationLogs.toArray();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: 'explain-native', originSessionId: 'root', originSessionTitle: 'AASC', response: expect.stringContaining('A baton is a token') }),
      expect.objectContaining({ mode: 'translate-file', filePath: '/w/proj/docs/guide.md', sourceFilePath: '/w/proj/docs/guide.md' }),
    ]));
  });

  it('says how a phone makes one: Chat, Terminal or a file', async () => {
    render(<MemoryRouter initialEntries={['/review']}><PhoneReview /></MemoryRouter>);
    expect(await screen.findByText('No saved entries yet')).toBeTruthy();
    expect(screen.getByText(/Select text in a session’s Chat, Terminal or a project file and tap Ask AI/)).toBeTruthy();
  });
});
