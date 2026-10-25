/**
 * The queue compose thumbnails open the image full size, so a pasted screenshot can be checked
 * before it is queued. Their ✕ still only removes the image.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import QueueTab from './QueueTab';
import { useQueueStore } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { Session } from '@/types';

vi.mock('@/lib/terminalSend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/terminalSend')>()),
  sendPromptToTerminal: vi.fn(async () => true),
}));
vi.mock('./QueueItemEditModal', () => ({ default: () => null }));
vi.mock('./QueueHistorySheet', () => ({ default: () => null }));
vi.mock('./LoopExcludeWindowsModal', () => ({ default: () => null }));

const IMAGES = [
  { name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' },
  { name: 'b.png', dataUrl: 'data:image/png;base64,BBBB' },
];
const draftImages = () => useQueueStore.getState().composeDrafts.get('s1')?.images ?? [];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  useUiStore.setState({ queuePanelCollapsed: false });
  useSessionStore.setState({
    sessions: new Map([['s1', { sessionId: 's1', title: 'AASC', projectPath: '/p', status: 'waiting', cliSource: 'claude' } as unknown as Session]]),
    selectedSessionId: 's1',
  });
  useQueueStore.setState({ queues: new Map([['s1', []]]), automation: new Map(), composeDrafts: new Map() });
  useQueueStore.getState().setComposeDraft('s1', { images: IMAGES });
});
afterEach(() => vi.unstubAllGlobals());

const renderTab = () => render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" fullHeight />);

describe('queue compose thumbnails', () => {
  it('a click on a thumbnail opens that image full size; Esc closes it', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'View b.png' }));
    const dialog = screen.getByRole('dialog', { name: 'b.png' });
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(IMAGES[1].dataUrl);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'b.png' })).toBeNull();
    expect(draftImages()).toHaveLength(2);
  });

  it('✕ removes the image and opens nothing', () => {
    renderTab();
    fireEvent.click(screen.getAllByTitle('Remove image')[0]);
    expect(draftImages().map((i) => i.name)).toEqual(['b.png']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
