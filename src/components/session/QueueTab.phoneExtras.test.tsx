/**
 * The queue's phone extras (AASC-20): photos from the library or the camera
 * (feature 61), within the queue's five-image limit, with 44px remove
 * controls; and the suggestion bar under the compose box (feature 70), which
 * takes over `/` from the dropdown on a phone. The desktop compose row is
 * unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import QueueTab from './QueueTab';
import { useQueueStore } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { resetPhoneSkillNotesCache } from '@/lib/phoneSuggestions';
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
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/ToastContainer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/ToastContainer')>()),
  showToast: toast,
}));
vi.mock('./QueueItemEditModal', () => ({ default: () => null }));
vi.mock('./QueueHistorySheet', () => ({ default: () => null }));
vi.mock('./LoopExcludeWindowsModal', () => ({ default: () => null }));

const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith('/api/commands')) {
    return new Response(JSON.stringify({ entries: [{ name: 'review', kind: 'command', source: 'builtin', cli: 'claude', description: '' }] }));
  }
  if (url === '/api/skill-notes/favorites') return new Response(JSON.stringify({ source: 'none', entries: [] }));
  return new Response('{}');
});

const png = (name: string) => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' });
const draftImages = () => useQueueStore.getState().composeDrafts.get('s1')?.images ?? [];
const renderTab = () => render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" fullHeight />);

beforeEach(() => {
  platform.isMobile = true;
  toast.mockClear();
  resetPhoneSkillNotesCache();
  vi.stubGlobal('fetch', fetchMock);
  useUiStore.setState({ queuePanelCollapsed: false });
  useSessionStore.setState({
    sessions: new Map([['s1', { sessionId: 's1', title: 'AASC', projectName: 'agent-manager', projectPath: '/p/extras', status: 'waiting', cliSource: 'claude' } as unknown as Session]]),
    selectedSessionId: 's1',
  });
  useQueueStore.setState({ queues: new Map([['s1', []]]), automation: new Map(), composeDrafts: new Map() });
});
afterEach(() => vi.unstubAllGlobals());

describe('photos and the camera on a phone', () => {
  it('offers the photo library and the camera, images only, the camera facing out', async () => {
    renderTab();
    expect(await screen.findByRole('button', { name: 'Attach photos (0 of 10)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeEnabled();
    const library = screen.getByTestId('queue-photo-input');
    const camera = screen.getByTestId('queue-camera-input');
    expect(library).toHaveAttribute('accept', 'image/*');
    expect(library).toHaveAttribute('multiple');
    expect(camera).toHaveAttribute('accept', 'image/*');
    expect(camera).toHaveAttribute('capture', 'environment');
    expect(screen.queryByTitle('Attach images')).toBeNull();
  });

  it('adds picked photos as thumbnails with their own remove control', async () => {
    renderTab();
    fireEvent.change(await screen.findByTestId('queue-photo-input'), { target: { files: [png('a.png'), png('b.png')] } });
    await waitFor(() => expect(draftImages().map((i) => i.name)).toEqual(['a.png', 'b.png']));
    expect(screen.getAllByRole('img').map((i) => i.getAttribute('alt'))).toEqual(['a.png', 'b.png']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove image 1 (a.png)' }));
    expect(draftImages().map((i) => i.name)).toEqual(['b.png']);
  });

  it('stops at ten images a prompt (Oct 21 2026, was five), says how many were left out, and then disables both buttons', async () => {
    renderTab();
    const shots = Array.from({ length: 12 }, (_, i) => png(`p${i}.png`));
    fireEvent.change(await screen.findByTestId('queue-camera-input'), { target: { files: shots } });
    await waitFor(() => expect(draftImages()).toHaveLength(10));
    expect(toast).toHaveBeenCalledWith('A prompt holds at most 10 images: 2 not added.', 'warning');
    expect(screen.getByRole('button', { name: 'Attach photos (10 of 10)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeDisabled();
  });
});

describe('the suggestion bar under the compose box', () => {
  it('appears with the keyboard on a phone, and `/` no longer opens the dropdown there', async () => {
    renderTab();
    const box = screen.getByPlaceholderText(/Add a prompt to the queue/) as HTMLTextAreaElement;
    act(() => box.focus());
    expect(await screen.findByRole('toolbar', { name: 'Suggestions' })).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '/re' } });
    box.setSelectionRange(3, 3);
    fireEvent.input(box);
    expect(await screen.findByRole('button', { name: '/review' })).toBeInTheDocument();
    expect(screen.queryByText(/↑↓ navigate/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '/review' }));
    expect(useQueueStore.getState().composeDrafts.get('s1')?.text).toBe('/review ');
  });

  it('is not on the desktop, which keeps its paperclip and its dropdown', async () => {
    platform.isMobile = false;
    renderTab();
    await settleLazy(
      () => import('@/components/mobile/QueuePhotoButtons'),
      () => import('@/components/mobile/PhoneSuggestionBar'),
    );
    expect(screen.getByTitle('Attach images')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Attach photos/ })).toBeNull();
    expect(screen.queryByTestId('queue-camera-input')).toBeNull();
    act(() => (screen.getByPlaceholderText(/Add a prompt to the queue/) as HTMLTextAreaElement).focus());
    expect(screen.queryByRole('toolbar', { name: 'Suggestions' })).toBeNull();
  });
});
