// Composer.photoView.test.tsx — an attached photo opens full screen (Oct 28 2026): tapping its
// thumbnail shows it in PhoneImageViewer inside a sheet; the thumbnail's ✕ only removes it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import type { DevicePresence, Session } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone', getWindowOriginId: () => 'phone:w' }));
vi.mock('@/lib/presenceClient', () => ({
  claimControl: vi.fn(async () => ({ ok: true, controller: null })),
  requestControl: vi.fn(async () => ({ ok: true })),
  grantControl: vi.fn(async () => ({ ok: true, controller: null })),
  releaseControl: vi.fn(async () => ({ ok: true, released: true })),
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/queueImageAttach', () => ({
  readQueueImages: vi.fn(async (files: File[]) => ({
    images: files.map((f) => ({ name: f.name, dataUrl: `data:image/png;base64,${f.name}` })),
    message: null,
  })),
}));

import Composer from './Composer';
import { usePresenceStore } from '@/stores/presenceStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { useQueueStore } from '@/stores/queueStore';
import { waitingCardModel } from '@/lib/chat/waitingCardModel';

function device(clientId: string, isLocal: boolean): DevicePresence {
  return { clientId, label: clientId === 'desk' ? 'MacBook' : 'iPhone', address: '', isLocal, connections: 1, connectedAt: 1, lastSeenAt: 1 };
}

function session(): Session {
  return {
    sessionId: 's1', status: 'waiting', cliSource: 'claude', projectName: 'agent-manager', projectPath: '/Users/me/agent-manager',
    terminalId: 'term-1', model: 'claude-opus-5-5', events: [], pendingRequest: null, pendingTool: null, pendingToolDetail: null, waitingDetail: null,
  } as unknown as Session;
}

async function attachPhoto(name = 'error.png') {
  const s = session();
  useSessionStore.setState({ sessions: new Map([[s.sessionId, s]]) });
  render(<Composer session={s} card={waitingCardModel(s)} inputRef={createRef<HTMLTextAreaElement>()} />);
  const file = new File([new Uint8Array([1])], name, { type: 'image/png' });
  fireEvent.change(screen.getByTestId('composer-photo-input'), { target: { files: [file] } });
  return screen.findByRole('button', { name: `View ${name}` });
}

beforeEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
  useQueueStore.setState({ queues: new Map(), automation: new Map() });
  usePresenceStore.setState({ pendingRequests: new Map() });
  usePresenceStore.getState().applyPresence({
    devices: [device('phone', false), device('desk', true)],
    controllers: [],
    restoreOwner: 'desk',
    workspaceWriter: 'desk',
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Composer — attached photo full screen', () => {
  it('opens the photo in the zoom viewer when its thumbnail is tapped', async () => {
    fireEvent.click(await attachPhoto());
    const sheet = await screen.findByTestId('photo-view-sheet');
    const img = sheet.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,error.png');
    expect(img?.getAttribute('alt')).toBe('error.png');
    expect(screen.getByRole('toolbar', { name: 'Zoom' })).toBeTruthy();
  });

  it('closes the viewer and keeps the photo attached', async () => {
    fireEvent.click(await attachPhoto());
    const sheet = await screen.findByTestId('photo-view-sheet');
    fireEvent.click(sheet.querySelector('button[aria-label="Close"]')!);
    await waitFor(() => expect(screen.queryByTestId('photo-view-sheet')).toBeNull());
    expect(screen.getByRole('button', { name: 'View error.png' })).toBeTruthy();
  });

  it('removes the photo from its ✕ without opening the viewer', async () => {
    await attachPhoto();
    fireEvent.click(screen.getByRole('button', { name: 'Remove error.png' }));
    expect(screen.queryByTestId('photo-view-sheet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'View error.png' })).toBeNull();
  });
});
