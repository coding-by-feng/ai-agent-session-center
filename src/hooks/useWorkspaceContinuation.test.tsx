import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useWsStore } from '@/stores/wsStore';
import { useQueueStore } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useWorkspaceContinuation, useContinuationState } from './useWorkspaceContinuation';
import type { Session } from '@/types';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('keeps the unsaved-draft close guard while the WebSocket is offline', async () => {
  useWsStore.setState({ connected: true, snapshotReceived: true });
  useSessionStore.setState({
    sessions: new Map([['s', { sessionId: 's' } as Session]]),
    selectedSessionId: 's',
  });
  useQueueStore.setState({ composeDrafts: new Map() });
  vi.stubGlobal(
    'fetch',
    async (_url: string, init?: RequestInit) =>
      new Response(
        JSON.stringify(init?.method === 'PUT' ? { error: 'offline' } : { records: [] }),
        {
          status: init?.method === 'PUT' ? 503 : 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
  );
  renderHook(() => useWorkspaceContinuation());
  await waitFor(() => expect(useContinuationState.getState().ready).toBe(true));
  act(() => {
    useQueueStore.getState().setComposeDraft('s', { text: 'offline draft' });
    useWsStore.setState({ connected: false });
  });
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(useQueueStore.getState().getComposeDraft('s').text).toBe('offline draft');
});
