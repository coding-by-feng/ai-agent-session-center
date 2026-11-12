// ProjectTab.lite.test.tsx — the AI popup from a Markdown selection, and where a saved highlight opens. Lite has no
// REVIEW, so a highlight opens in the session's AI POPUPS tab; a phone or a window with no session has no such tab.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

const edition = vi.hoisted(() => ({ lite: true }));
vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  get IS_LITE() { return edition.lite; },
}));
const platform = vi.hoisted(() => ({ phone: false }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.phone,
}));
const selection = vi.hoisted(() => ({ enabled: [] as boolean[] }));
vi.mock('@/hooks/useSelectionPopup', () => ({
  useSelectionPopup: ({ enabled }: { enabled: boolean }) => {
    selection.enabled.push(enabled);
    return { active: null, dismiss: () => {} };
  },
}));
const records = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock('@/lib/translationLog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/translationLog')>()),
  listFavoritedByFile: async () => [{ selection: 'saved words', uuid: 'u1', alias: '' }],
  findByUuid: records.find,
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/ToastContainer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/ToastContainer')>()),
  showToast: toast,
}));

import ProjectTab from './ProjectTab';
import { setFileSystemProvider, type FileSystemProvider } from '@/lib/fileSystemProvider';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { tooltips } from '@/lib/tooltips';

function Address() {
  return <div data-testid="address">{useLocation().search}</div>;
}

function mount(originSessionId?: string) {
  return render(
    <MemoryRouter>
      <Address />
      <ProjectTab projectPath="/p" persistId="lite-test" initialPath="a.md" initialIsFile preferInitialFile originSessionId={originSessionId} />
    </MemoryRouter>,
  );
}

const highlight = async () => {
  await screen.findByText('saved words');
  return screen.getByText('saved words');
};

describe('ProjectTab: AI popups and saved highlights', () => {
  const switched = vi.fn();
  const onSwitch = (event: Event) => switched((event as CustomEvent<{ tabId: string }>).detail.tabId);

  beforeEach(() => {
    edition.lite = true;
    platform.phone = false;
    selection.enabled = [];
    switched.mockReset();
    toast.mockReset();
    records.find.mockReset();
    records.find.mockResolvedValue({ uuid: 'u1' });
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const readFile = vi.fn(async (_root: string, rel: string) => ({ path: rel, name: rel, content: 'some saved words here', ext: 'md' }));
    setFileSystemProvider(new Proxy({ readFile } as unknown as FileSystemProvider, {
      get: (t, k) => (k in t ? (t as never)[k] : vi.fn(async () => ({ path: '', items: [], results: [], indexing: false, matches: [] }))),
    }));
    useSettingsStore.setState({ translationEnabled: true } as never);
    useUiStore.setState({ focusedAiPopup: null });
    document.addEventListener('detailTabs:switchTab', onSwitch);
  });
  afterEach(() => {
    document.removeEventListener('detailTabs:switchTab', onSwitch);
    vi.unstubAllGlobals();
  });

  it('Lite offers the AI popup on a Markdown selection', async () => {
    mount('s1');
    await highlight();
    expect(selection.enabled).toContain(true);
  });

  it('Lite opens a highlight in the session\'s AI POPUPS tab', async () => {
    mount('s1');
    fireEvent.click(await highlight());
    await waitFor(() => expect(switched).toHaveBeenCalledWith('aiPopups'));
    expect(useUiStore.getState().focusedAiPopup).toEqual({ sessionId: 's1', uuid: 'u1', fresh: true });
    expect(screen.getByTestId('address').textContent).toBe('');
  });

  it('Lite tells the reader the highlight opens in AI POPUPS', async () => {
    mount('s1');
    expect((await highlight()).title).toMatch(/AI POPUPS/);
  });

  it('closes the full-screen view, or the tab it opens would stay hidden behind it', async () => {
    mount('s1');
    await highlight();
    fireEvent.click(screen.getByRole('button', { name: tooltips.projFullscreen.label }));
    expect(screen.getByRole('button', { name: tooltips.projFullscreenClose.label })).toBeInTheDocument();

    fireEvent.click(await highlight());

    await waitFor(() => expect(switched).toHaveBeenCalledWith('aiPopups'));
    expect(screen.queryByRole('button', { name: tooltips.projFullscreenClose.label })).not.toBeInTheDocument();
  });

  it('says so when the record behind a highlight is gone, and stays put', async () => {
    records.find.mockResolvedValue(undefined);
    mount('s1');
    fireEvent.click(await highlight());
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0]).toMatch(/deleted/i);
    expect(switched).not.toHaveBeenCalled();
    expect(useUiStore.getState().focusedAiPopup).toBeNull();
  });

  it('clicking the same highlight again asks again, so a closed record reopens', async () => {
    mount('s1');
    fireEvent.click(await highlight());
    await waitFor(() => expect(switched).toHaveBeenCalledTimes(1));
    act(() => useUiStore.getState().markFocusedAiPopupOpened());
    expect(useUiStore.getState().focusedAiPopup?.fresh).toBe(false);

    fireEvent.click(await highlight());
    await waitFor(() => expect(switched).toHaveBeenCalledTimes(2));
    expect(useUiStore.getState().focusedAiPopup?.fresh).toBe(true);
  });

  it.each([
    ['a phone paired to Lite', true, 's1'],
    ['a window with no session', false, undefined],
  ])('leaves it as plain text on %s, which has no such tab', async (_name, phone, session) => {
    platform.phone = phone;
    mount(session);
    fireEvent.click(await highlight());
    await waitFor(() => expect(screen.getByText('saved words').tagName).toBe('MARK'));
    const mark = screen.getByText('saved words');
    expect(mark).not.toHaveAttribute('role', 'button');
    expect(mark).not.toHaveAttribute('title');
    expect(mark).not.toHaveClass('saved-selection');
    expect(useUiStore.getState().focusedAiPopup).toBeNull();
    expect(switched).not.toHaveBeenCalled();
  });

  it('Full still opens it in REVIEW', async () => {
    edition.lite = false;
    mount('s1');
    fireEvent.click(await highlight());
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe('?uuid=u1'));
    expect((await highlight()).title).toMatch(/REVIEW/);
    expect(useUiStore.getState().focusedAiPopup).toBeNull();
    expect(switched).not.toHaveBeenCalled();
  });
});
