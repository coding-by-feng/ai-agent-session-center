import { afterEach, expect, it, vi } from 'vitest';
import { startContinuation } from './continuationClient';
import { useSessionStore } from '@/stores/sessionStore';
import { useQueueStore, DEFAULT_COMPOSE_DRAFT } from '@/stores/queueStore';
import type { Session } from '@/types';
afterEach(() => vi.unstubAllGlobals());
it('restores after snapshot and flushes current drafts without creating or clearing sessions', async () => {
  const session = { sessionId: 's', terminalId: 'pty-original', remoteVisible: true } as Session;
  useSessionStore.setState({
    sessions: new Map([['s', session]]),
    selectedSessionId: null,
    lastSelectedSessionId: null,
  });
  useQueueStore.setState({ composeDrafts: new Map() });
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/workspace/continuation');
    if (init?.method === 'PUT') {
      const body = JSON.parse(init.body as string);
      writes.push(body);
      return new Response(JSON.stringify({ revision: body.revision + 1 }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        records: [
          {
            sourceId: 'before',
            revision: 1,
            updatedAt: 1,
            selectedSessionId: 's',
            drafts: [{ sessionId: 's', draft: { ...DEFAULT_COMPOSE_DRAFT, text: 'keep me' } }],
          },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  const controller = await startContinuation(new AbortController().signal, () => {});
  expect(useSessionStore.getState().selectedSessionId).toBe('s');
  expect(useQueueStore.getState().getComposeDraft('s').text).toBe('keep me');
  useQueueStore.getState().setComposeDraft('s', { text: 'latest edit' });
  await controller!.flush();
  controller!.stop();
  expect((writes.at(-1)?.drafts as Array<{ draft: { text: string } }>)[0].draft.text).toBe(
    'latest edit',
  );
  expect(useSessionStore.getState().sessions.get('s')).toBe(session);
});
it('refuses a switch flush when the server cannot save, retaining the local draft', async () => {
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
  const controller = await startContinuation(new AbortController().signal, () => {});
  useQueueStore.getState().setComposeDraft('s', { text: 'do not lose' });
  await expect(controller!.flush()).rejects.toThrow();
  controller!.stop();
  expect(useQueueStore.getState().getComposeDraft('s').text).toBe('do not lose');
});
