import { afterEach, expect, it, vi } from 'vitest';
import { startContinuation } from './continuationClient';
import { useSessionStore } from '@/stores/sessionStore';
import { useQueueStore, DEFAULT_COMPOSE_DRAFT } from '@/stores/queueStore';
import type { Session } from '@/types';
import type { ContinuationWrite, WorkspaceContinuation } from '@/types/workspaceContinuation';
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
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
  await expect(controller!.prepareSwitch()).rejects.toThrow();
  controller!.stop();
  expect(useQueueStore.getState().getComposeDraft('s').text).toBe('do not lose');
});

it.each(['own draft', ''])(
  'hands the current window across editions even when another window saves later (%j)',
  async (text) => {
    const session = { sessionId: 's', terminalId: 'original' } as Session;
    const reset = () => {
      useSessionStore.setState({
        sessions: new Map([
          ['s', session],
          ['other', { sessionId: 'other' } as Session],
        ]),
        selectedSessionId: null,
        lastSelectedSessionId: null,
      });
      useQueueStore.setState({ composeDrafts: new Map() });
    };
    reset();
    let records: WorkspaceContinuation[] = [];
    const writes: ContinuationWrite[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as ContinuationWrite;
        writes.push(body);
        return new Response(JSON.stringify({ revision: body.revision + 1 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ records }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const original = await startContinuation(new AbortController().signal, () => {});
    useSessionStore.getState().selectSession('s');
    useQueueStore.getState().setComposeDraft('s', { text });
    await original!.flush();
    const savesBeforeSwitch = writes.length;
    await original!.prepareSwitch();
    expect(writes).toHaveLength(savesBeforeSwitch + 1);
    const handoff = writes.at(-1)!;
    expect(handoff.handoff).toBe(true);
    expect(sessionStorage.getItem('aasc.workspace-continuation.resume')).toBe(handoff.sourceId);
    original!.stop();
    records = [
      { ...handoff, revision: handoff.revision + 1, updatedAt: 1 } as WorkspaceContinuation,
      {
        sourceId: 'other-window',
        revision: 1,
        updatedAt: 100,
        selectedSessionId: 'other',
        drafts: [
          { sessionId: 's', draft: { ...DEFAULT_COMPOSE_DRAFT, text: 'newer other draft' } },
        ],
      },
    ];
    reset();
    const changes: Array<{ conflicts?: WorkspaceContinuation['drafts'] }> = [];
    const destination = await startContinuation(new AbortController().signal, (state) =>
      changes.push(state),
    );
    expect(useSessionStore.getState().selectedSessionId).toBe('s');
    expect(useQueueStore.getState().getComposeDraft('s').text).toBe(text);
    expect(changes[0].conflicts?.[0].draft.text).toBe('newer other draft');
    await destination!.flush();
    destination!.stop();
    expect(writes.at(-1)?.resumeSourceId).toBe(handoff.sourceId);
    expect(writes.at(-1)?.adopt).toEqual([
      { sourceId: handoff.sourceId, revision: handoff.revision + 1 },
    ]);
    expect(sessionStorage.getItem('aasc.workspace-continuation.resume')).toBeNull();
    expect(useSessionStore.getState().sessions.get('s')).toBe(session);
  },
);
