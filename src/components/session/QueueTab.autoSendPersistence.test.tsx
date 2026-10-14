/**
 * The whole path of "remember the Auto-send status of each session, even after
 * restarting", from the real ➤ button to the real button again.
 *
 * The pieces each have their own tests (queueStore, workspaceSnapshot,
 * useWorkspaceAutoSave). What this proves is that they are CONNECTED, which is
 * where the bug was: the toggle wrote the queue store, the restore read the
 * workspace snapshot, and nothing made the snapshot follow the toggle. A restart
 * also gives every session a new id, so the per-id rows in IndexedDB and on the
 * server cannot be looked up again; the snapshot is the only way across.
 *
 * Steps: click ➤ on one of two sessions -> the hook saves the snapshot -> the app
 * "restarts" (every store emptied) -> the snapshot is restored under new terminal
 * ids -> the CLI re-keys the cards -> each card's button says what it said before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import QueueTab from './QueueTab';
import { useWorkspaceAutoSave } from '@/hooks/useWorkspaceAutoSave';
import {
  _resetAutoSaveStateForTests,
  buildSnapshot,
  cancelAutoSave,
  importSnapshot,
  setRestorePending,
  type WorkspaceSnapshot,
} from '@/lib/workspaceSnapshot';
import { DEFAULT_AUTOMATION, useQueueStore } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { usePresenceStore } from '@/stores/presenceStore';
import type { Session } from '@/types';

// Unrelated to the toggle: keep the render to the compose box and its header.
vi.mock('@/lib/queuePopout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queuePopout')>()),
  openQueuePopout: vi.fn(),
}));
vi.mock('@/lib/terminalSend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/terminalSend')>()),
  sendPromptToTerminal: vi.fn(async () => true),
}));
vi.mock('./QueueItemEditModal', () => ({ default: () => null }));
vi.mock('./QueueMovePicker', () => ({ default: () => null, MOVE_TRIGGER_ATTR: 'data-move-trigger' }));
vi.mock('./QueueHistorySheet', () => ({ default: () => null }));
vi.mock('./LoopExcludeWindowsModal', () => ({ default: () => null }));

const ON_TITLE = /Auto-send ON — prompts sent automatically when session is waiting/;
const OFF_TITLE = 'Auto-send OFF — prompts stay in queue';

const session = (id: string): Session =>
  ({
    sessionId: id,
    status: 'idle',
    sshConfig: { host: 'localhost', port: 22, username: 'u', workingDir: `/work/${id}`, command: 'claude' },
  }) as unknown as Session;

function Board({ sessionIds }: { sessionIds: string[] }) {
  useWorkspaceAutoSave();
  return (
    <>
      {sessionIds.map((id) => (
        <div key={id} data-testid={id}>
          <QueueTab sessionId={id} sessionStatus="idle" terminalId={null} />
        </div>
      ))}
    </>
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
const lastSavedSnapshot = (): WorkspaceSnapshot => {
  const saves = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/workspace/save'));
  expect(saves.length).toBeGreaterThan(0);
  return JSON.parse(String((saves[saves.length - 1][1] as RequestInit).body)) as WorkspaceSnapshot;
};
const toggleOf = (testId: string) =>
  screen.getByTestId(testId).querySelector('button[title^="Auto-send"]') as HTMLButtonElement;

beforeEach(() => {
  _resetAutoSaveStateForTests();
  setRestorePending(false);
  useSessionStore.getState().setSessions(new Map([['old-1', session('old-1')], ['old-2', session('old-2')]]));
  useRoomStore.setState({ rooms: [] });
  useQueueStore.setState({ queues: new Map(), automation: new Map(), composeDrafts: new Map() });
  usePresenceStore.setState({ workspaceWriter: null } as never);
  fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/sessions/clear-all')) return json({ savedOutputs: [] });
    if (u.includes('/api/terminals')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { originalSessionId?: string };
      return json({ ok: true, terminalId: `term-new-${body.originalSessionId}` });
    }
    return json({ ok: true });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  cancelAutoSave();
  setRestorePending(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Auto-send survives a restart, from the ➤ button to the ➤ button', () => {
  it('a session left on OFF comes back OFF, and its neighbour left on ON comes back ON', async () => {
    vi.useFakeTimers();
    render(<Board sessionIds={['old-1', 'old-2']} />);
    expect(toggleOf('old-1')).toHaveAttribute('title', expect.stringMatching(ON_TITLE));

    // the user turns Auto-send OFF on the first session only, then leaves the board idle
    fireEvent.click(toggleOf('old-1'));
    expect(toggleOf('old-1')).toHaveAttribute('title', OFF_TITLE);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    const saved = lastSavedSnapshot();
    expect(saved.sessions.find((s) => s.originalSessionId === 'old-1')?.automation?.autoSend).toBe(false);
    expect(saved.sessions.find((s) => s.originalSessionId === 'old-2')?.automation).toBeUndefined();

    // the app restarts: every store is empty and every session will get a new id
    vi.useRealTimers();
    cleanup();
    cancelAutoSave();
    useSessionStore.getState().setSessions(new Map());
    useQueueStore.setState({ queues: new Map(), automation: new Map(), composeDrafts: new Map() });
    await importSnapshot(saved, { onSessionCreated: () => {}, onComplete: () => {} });

    // the CLI reports its own session ids and the cards are re-keyed
    useQueueStore.getState().migrateSession('term-new-old-1', 'hook-1');
    useQueueStore.getState().migrateSession('term-new-old-2', 'hook-2');

    render(<Board sessionIds={['hook-1', 'hook-2']} />);
    expect(toggleOf('hook-1')).toHaveAttribute('title', OFF_TITLE);
    expect(toggleOf('hook-2')).toHaveAttribute('title', expect.stringMatching(ON_TITLE));
  });

  it('turning it back ON is remembered too: a stale OFF does not come back', async () => {
    vi.useFakeTimers();
    render(<Board sessionIds={['old-1']} />);
    fireEvent.click(toggleOf('old-1')); // OFF
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    fireEvent.click(toggleOf('old-1')); // ON again
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    const saved = lastSavedSnapshot();
    expect(saved.sessions.find((s) => s.originalSessionId === 'old-1')?.automation).toBeUndefined();

    vi.useRealTimers();
    cleanup();
    cancelAutoSave();
    useSessionStore.getState().setSessions(new Map());
    useQueueStore.setState({ queues: new Map(), automation: new Map(), composeDrafts: new Map() });
    await importSnapshot(saved, { onSessionCreated: () => {}, onComplete: () => {} });
    useQueueStore.getState().migrateSession('term-new-old-1', 'hook-1');

    render(<Board sessionIds={['hook-1']} />);
    expect(toggleOf('hook-1')).toHaveAttribute('title', expect.stringMatching(ON_TITLE));
  });
});

// `claude --resume` keeps the session id. So for a resumed session the rows IndexedDB and the server
// hold under that id are loaded at boot, before the card (a `term-*` placeholder until the CLI reports
// in) turns back into it. These are the two ways that path could still lose what the user chose.
describe('Auto-send for a resumed session, which keeps its id', () => {
  const restoreFrom = async (snapshot: WorkspaceSnapshot) => {
    useSessionStore.getState().setSessions(new Map());
    await importSnapshot(snapshot, { onSessionCreated: () => {}, onComplete: () => {} });
  };
  const staleSnapshot = () =>
    JSON.parse(JSON.stringify(buildSnapshot(new Map([['old-1', session('old-1')]]), []))) as WorkspaceSnapshot;

  it('comes back as the row stored under that id says, even when the snapshot predates the toggle', async () => {
    const stale = staleSnapshot(); // taken before the user turned Auto-send OFF: no automation in it
    // what IndexedDB / the server hand back at boot, keyed by the same id
    useQueueStore.setState({ automation: new Map([['old-1', { ...DEFAULT_AUTOMATION, autoSend: false }]]), queues: new Map() });
    await restoreFrom(stale);

    useQueueStore.getState().migrateSession('term-new-old-1', 'old-1'); // the CLI resumed and kept its id

    render(<Board sessionIds={['old-1']} />);
    expect(toggleOf('old-1')).toHaveAttribute('title', OFF_TITLE);
  });

  it('keeps a switch the user flipped on the card while its CLI was still booting', async () => {
    const stale = staleSnapshot();
    useQueueStore.setState({ automation: new Map([['old-1', { ...DEFAULT_AUTOMATION }]]), queues: new Map() }); // row: ON
    await restoreFrom(stale);

    // the card is still the placeholder; the user turns Auto-send OFF on it
    render(<Board sessionIds={['term-new-old-1']} />);
    fireEvent.click(toggleOf('term-new-old-1'));
    expect(toggleOf('term-new-old-1')).toHaveAttribute('title', OFF_TITLE);
    cleanup();

    useQueueStore.getState().migrateSession('term-new-old-1', 'old-1'); // the re-key must not undo the click

    render(<Board sessionIds={['old-1']} />);
    expect(toggleOf('old-1')).toHaveAttribute('title', OFF_TITLE);
  });

  it('a stale value in the snapshot does not override a fresher row: the user turned it back ON just before a hard exit', async () => {
    // the snapshot says OFF (taken while it was OFF) ...
    useQueueStore.getState().setAutoSend('old-1', false);
    const offSnapshot = JSON.parse(
      JSON.stringify(buildSnapshot(new Map([['old-1', session('old-1')]]), [])),
    ) as WorkspaceSnapshot;
    // ... but the row IndexedDB holds under that id is newer: ON again
    useQueueStore.setState({ automation: new Map([['old-1', { ...DEFAULT_AUTOMATION, autoSend: true }]]), queues: new Map() });
    await restoreFrom(offSnapshot);

    useQueueStore.getState().migrateSession('term-new-old-1', 'old-1');

    render(<Board sessionIds={['old-1']} />);
    expect(toggleOf('old-1')).toHaveAttribute('title', expect.stringMatching(ON_TITLE));
  });
});
