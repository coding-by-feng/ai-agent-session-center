// AiPopupHistory.phone.test.tsx — the AI POPUPS history on a phone (AASC-20): delete confirms in a sheet,
// and a popup still running opens again in its sheet.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DbTranslationLog } from '@/lib/db';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));
const log = vi.hoisted(() => ({
  rows: [] as DbTranslationLog[],
  deleteLog: vi.fn(async () => {}),
}));
vi.mock('@/lib/translationLog', () => ({
  listByOriginSession: vi.fn(async () => log.rows),
  setArchived: vi.fn(), setNotes: vi.fn(), setFavorite: vi.fn(), setAlias: vi.fn(),
  deleteLog: log.deleteLog,
}));
vi.mock('./PopupResponse', () => ({ default: () => <div>response</div> }));

import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import AiPopupHistory from './AiPopupHistory';

const row = (uuid: string, floatTerminalId: string): DbTranslationLog => ({
  uuid, mode: 'explain-native', nativeLanguage: '中文', learningLanguage: 'English', selection: `about ${uuid}`,
  contextLine: '', filePath: '', fileContent: '', prompt: '', response: 'answer', originSessionId: 's1',
  originProjectName: 'p', originSessionTitle: 't', floatTerminalId, notes: '', archived: 0, favorite: 0,
  alias: '', sourceFilePath: '', createdAt: Date.now(), updatedAt: Date.now(),
});

beforeEach(() => {
  vi.clearAllMocks();
  platform.isMobile = true;
  log.rows = [row('live', 'term-live'), row('old', 'term-gone')];
  useFloatingSessionsStore.setState({ floats: [{ terminalId: 'term-live', label: 'Explain', originSessionId: 's1', createdAt: 1 }], phoneShown: null });
});

async function open(name: RegExp) {
  render(<AiPopupHistory sessionId="s1" />);
  fireEvent.click(await screen.findByRole('button', { name }));
}

describe('AI POPUPS on a phone', () => {
  it('with none yet, points at the chat, where a phone asks the AI (AASC-48)', async () => {
    log.rows = [];
    render(<AiPopupHistory sessionId="s1" />);
    expect(await screen.findByText('Select text in Chat and tap Ask AI.')).toBeTruthy();
  });

  it('a running popup says so and opens again in its sheet', async () => {
    await open(/about live/);
    expect(screen.getByText('● running')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(useFloatingSessionsStore.getState().phoneShown).toBe('term-live');
  });

  it('a finished popup has no Open', async () => {
    await open(/about old/);
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  it('delete confirms in a sheet, never window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    await open(/about old/);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(log.deleteLog).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete this AI popup record?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(log.deleteLog).toHaveBeenCalledWith('old'));
  });

  it('a desktop keeps its confirm and shows no Open', async () => {
    platform.isMobile = false;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await open(/about live/);
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(log.deleteLog).toHaveBeenCalledWith('live'));
  });
});
