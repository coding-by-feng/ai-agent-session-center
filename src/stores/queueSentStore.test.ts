// queueSentStore.test.ts — AASC-20: the QUEUE badge record comes from the Mac, per session.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useQueueSentStore, recordQueueSent } from './queueSentStore';

const T = 1_700_000_000_000;

beforeEach(() => {
  useQueueSentStore.setState({ bySession: new Map() });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('queueSentStore', () => {
  it('loads one session’s records from the Mac, normalized, dropping malformed ones', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sent: [{ text: '  two\n words ', sentAt: T }, { text: 1 }, 'junk'] })));
    vi.stubGlobal('fetch', fetchMock);
    await useQueueSentStore.getState().load('s 1');
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s%201/queue/sent');
    expect(useQueueSentStore.getState().bySession.get('s 1')).toEqual([{ text: 'two words', sentAt: T }]);
  });

  it('keeps what it has when the Mac can’t be reached or refuses', async () => {
    useQueueSentStore.getState().add('s1', { text: 'kept', sentAt: T });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await useQueueSentStore.getState().load('s1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    await useQueueSentStore.getState().load('s1');
    expect(useQueueSentStore.getState().bySession.get('s1')).toEqual([{ text: 'kept', sentAt: T }]);
  });

  it('adds broadcast records to the right session without touching others', () => {
    const before = useQueueSentStore.getState().bySession;
    useQueueSentStore.getState().add('s1', { text: 'one', sentAt: T });
    useQueueSentStore.getState().add('s2', { text: 'two', sentAt: T });
    const after = useQueueSentStore.getState().bySession;
    expect(after).not.toBe(before);
    expect(after.get('s1')).toEqual([{ text: 'one', sentAt: T }]);
    expect(after.get('s2')).toEqual([{ text: 'two', sentAt: T }]);
  });

  it('records a send on the Mac and never throws', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('offline'); });
    vi.stubGlobal('fetch', fetchMock);
    expect(() => recordQueueSent('s1', { text: 'hello', sentAt: T })).not.toThrow();
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/queue/sent', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ text: 'hello', sentAt: T }),
    }));
  });
});
