import { describe, it, expect, beforeEach } from 'vitest';
import { useQueueStore } from '@/stores/queueStore';
import { appendPromptToQueue, canQueuePromptFor } from './queueAppend';
import type { Session } from '@/types';

const session = (over: Partial<Session> = {}): Session => ({ sessionId: 's1', status: 'idle', ...over }) as Session;

describe('canQueuePromptFor', () => {
  it('takes a live session', () => {
    expect(canQueuePromptFor(session())).toBe(true);
    expect(canQueuePromptFor(session({ status: 'working' }))).toBe(true);
  });

  it('refuses no session, an ended one and a floating fork', () => {
    expect(canQueuePromptFor(undefined)).toBe(false);
    expect(canQueuePromptFor(session({ status: 'ended' }))).toBe(false);
    expect(canQueuePromptFor(session({ isFloating: true }))).toBe(false);
  });
});

describe('appendPromptToQueue', () => {
  beforeEach(() => {
    useQueueStore.setState({ queues: new Map() });
  });

  it('appends the text at the end of the session’s queue, as a one-shot item', () => {
    const first = appendPromptToQueue('s1', 'first');
    const second = appendPromptToQueue('s1', 'run the tests again');
    const items = useQueueStore.getState().queues.get('s1') ?? [];
    expect(items.map((i) => i.text)).toEqual(['first', 'run the tests again']);
    expect(items[1]).toMatchObject({ sessionId: 's1', position: 1, type: 'once', nextFireAt: 0 });
    expect(items[0].id).not.toBe(items[1].id);
    // How many now wait, for the toast.
    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it('keeps queues apart', () => {
    appendPromptToQueue('s1', 'a');
    appendPromptToQueue('s2', 'b');
    expect(useQueueStore.getState().queues.get('s2')?.map((i) => i.text)).toEqual(['b']);
  });
});
