// useWorkspaceAutoSave.test.tsx — what makes the workspace snapshot get written.
//
// The snapshot is the only record a restart can read (every session gets a new
// id, so the Dexie and server queue rows keyed by the old id are unreachable).
// Auto-send / pause live in the queue store and change neither `sessions` nor
// `rooms`, so the hook has to watch them too, or a toggle on an idle board never
// reaches the snapshot.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWorkspaceAutoSave } from './useWorkspaceAutoSave';
import {
  _resetAutoSaveStateForTests,
  cancelAutoSave,
  setRestorePending,
  type WorkspaceSnapshot,
} from '@/lib/workspaceSnapshot';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { useQueueStore } from '@/stores/queueStore';
import { usePresenceStore } from '@/stores/presenceStore';
import type { Session } from '@/types';

const session = (id: string): Session =>
  ({
    sessionId: id,
    status: 'idle',
    sshConfig: { host: 'localhost', port: 22, username: 'u', workingDir: '/x', command: 'claude' },
  }) as unknown as Session;

let fetchMock: ReturnType<typeof vi.fn>;
const saves = (): WorkspaceSnapshot[] =>
  fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/api/workspace/save'))
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as WorkspaceSnapshot);
const autoSendOf = (snap: WorkspaceSnapshot, id: string) =>
  snap.sessions.find((x) => x.originalSessionId === id)?.automation?.autoSend;

beforeEach(() => {
  _resetAutoSaveStateForTests();
  setRestorePending(false);
  useSessionStore.getState().setSessions(new Map([['s1', session('s1')]]));
  useRoomStore.setState({ rooms: [] });
  useQueueStore.setState({ queues: new Map(), automation: new Map() });
  usePresenceStore.setState({ workspaceWriter: null } as never);
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }) as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cancelAutoSave();
  setRestorePending(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useWorkspaceAutoSave — an Auto-send toggle', () => {
  it('saves the workspace within about a second, with the session\'s OFF in it, before the 5 s timer', async () => {
    renderHook(() => useWorkspaceAutoSave());
    act(() => useQueueStore.getState().setAutoSend('s1', false));
    await vi.advanceTimersByTimeAsync(1_200);
    expect(saves().some((snap) => autoSendOf(snap, 's1') === false)).toBe(true);
  });

  it('still saves while sessions keep changing every 250 ms, which keeps resetting the session timer', async () => {
    renderHook(() => useWorkspaceAutoSave());
    for (let t = 0; t < 28; t++) {
      act(() => useSessionStore.getState().setSessions(new Map([['s1', { ...session('s1'), lastActivityAt: t } as Session]])));
      if (t === 8) act(() => useQueueStore.getState().setAutoSend('s1', false));
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(saves().some((snap) => autoSendOf(snap, 's1') === false)).toBe(true);
  });

  it('does not save just because the hook mounted (nothing was toggled)', async () => {
    renderHook(() => useWorkspaceAutoSave());
    await vi.advanceTimersByTimeAsync(1_500); // after the automation timer would have fired, before the 5 s one
    expect(saves()).toHaveLength(0);
  });

  it('does not save while the restore decision is pending, so boot hydration cannot overwrite the snapshot', async () => {
    _resetAutoSaveStateForTests(); // pending again
    renderHook(() => useWorkspaceAutoSave());
    act(() => useQueueStore.setState({ automation: new Map([['s1', { ...useQueueStore.getState().getAutomation('s1'), autoSend: false }]]) }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(saves()).toHaveLength(0);
  });

  it('cancels a pending save when the app unmounts it', async () => {
    const { unmount } = renderHook(() => useWorkspaceAutoSave());
    act(() => useQueueStore.getState().setAutoSend('s1', false));
    unmount();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(saves()).toHaveLength(0);
  });

  it('does not save for a re-key: the card turning into its CLI session id changes no decision, and a save then would write unresolved term-* ids', async () => {
    renderHook(() => useWorkspaceAutoSave());
    act(() => useQueueStore.getState().setAutoSend('s1', false));
    await vi.advanceTimersByTimeAsync(1_200);
    const before = saves().length;
    expect(before).toBeGreaterThan(0);
    act(() => useQueueStore.getState().migrateSession('s1', 'hook-1'));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(saves().length).toBe(before);
  });

  it('does not save when the same value comes back from the server under a new object', async () => {
    useQueueStore.setState({ automation: new Map([['s1', { ...useQueueStore.getState().getAutomation('s1'), autoSend: false }]]) });
    renderHook(() => useWorkspaceAutoSave());
    act(() => useQueueStore.setState({ automation: new Map([['s1', { ...useQueueStore.getState().getAutomation('s1'), autoSend: false }]]) }));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(saves()).toHaveLength(0);
  });
});


// A SHARE click changes `sessions`, but only the 5 s trailing timer saw it, and every
// session update resets that timer: on a busy board the share never reached the
// snapshot, and a restart brought the session back with its old share state.
describe('useWorkspaceAutoSave — a SHARE toggle', () => {
  const sharedOf = (snap: WorkspaceSnapshot, id: string) =>
    snap.sessions.find((x) => x.originalSessionId === id)?.remoteVisible;

  it('saves the workspace within about a second, with the share in it', async () => {
    renderHook(() => useWorkspaceAutoSave());
    act(() => useSessionStore.getState().toggleRemoteVisible('s1'));
    await vi.advanceTimersByTimeAsync(1_200);
    expect(saves().some((snap) => sharedOf(snap, 's1') === true)).toBe(true);
  });

  it('still saves while sessions keep changing every 250 ms', async () => {
    renderHook(() => useWorkspaceAutoSave());
    let shared = false;
    for (let t = 0; t < 28; t++) {
      if (t === 8) shared = true;
      act(() =>
        useSessionStore.getState().setSessions(
          new Map([['s1', { ...session('s1'), lastActivityAt: t, remoteVisible: shared } as Session]]),
        ),
      );
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(saves().some((snap) => sharedOf(snap, 's1') === true)).toBe(true);
  });

  it('a session update that leaves the share alone does not take the quick save', async () => {
    renderHook(() => useWorkspaceAutoSave());
    act(() => useSessionStore.getState().setSessions(new Map([['s1', { ...session('s1'), lastActivityAt: 1 } as Session]])));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(saves()).toHaveLength(0);
  });
});
