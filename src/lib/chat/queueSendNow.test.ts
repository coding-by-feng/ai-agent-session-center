// queueSendNow.test.ts — ⚡ "Send now" from the phone's Queue tab (AASC-47). The
// terminal write is mocked: nothing here reaches a real terminal or process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session } from '@/types';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/terminalSend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/terminalSend')>()),
  sendPromptToTerminal: vi.fn(async () => true),
}));
vi.mock('@/stores/queueSentStore', () => ({ recordQueueSent: vi.fn() }));

import { sendQueueItemNow } from './queueSendNow';
import { DEFAULT_AUTOMATION, useQueueStore, type QueueItem } from '@/stores/queueStore';
import { sendPromptToTerminal, IMAGE_SUBMIT_ENTER_DELAY_MS, SUBMIT_ENTER_DELAY_MS } from '@/lib/terminalSend';
import { recordQueueSent } from '@/stores/queueSentStore';
import { showToast } from '@/components/ui/ToastContainer';

const session = (over: Partial<Session> = {}) => ({ sessionId: 's1', status: 'waiting', terminalId: 'term-1', ...over }) as Session;
const item = (over: Partial<QueueItem> = {}): QueueItem => ({ id: 7, sessionId: 's1', text: 'run it\\nplease', position: 0, createdAt: 0, ...over });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ paths: ['/tmp/a.png'] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(sendPromptToTerminal).mockReset().mockResolvedValue(true);
  vi.mocked(recordQueueSent).mockClear();
  vi.mocked(showToast).mockClear();
  useQueueStore.setState({ queues: new Map([['s1', [item()]]]), automation: new Map() });
});

afterEach(() => vi.unstubAllGlobals());

describe('sendQueueItemNow', () => {
  it('types a plain prompt with a separate Enter, records it and takes it off the queue', async () => {
    await expect(sendQueueItemNow(session(), item())).resolves.toBe(true);
    expect(sendPromptToTerminal).toHaveBeenCalledWith('term-1', 'run it\nplease', true, SUBMIT_ENTER_DELAY_MS);
    expect(recordQueueSent).toHaveBeenCalledWith('s1', expect.objectContaining({ text: 'run it\nplease' }));
    expect(useQueueStore.getState().queues.get('s1')).toEqual([]);
  });

  it('uploads photos first and waits longer before Enter', async () => {
    const withPhoto = item({ images: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AA' }] });
    await sendQueueItemNow(session(), withPhoto);
    expect(fetchMock).toHaveBeenCalledWith('/api/queue-images', expect.objectContaining({ method: 'POST' }));
    expect(sendPromptToTerminal).toHaveBeenCalledWith('term-1', 'run it\nplease\n/tmp/a.png', true, IMAGE_SUBMIT_ENTER_DELAY_MS);
  });

  it('types without Enter when Auto-Enter is off, and records nothing', async () => {
    useQueueStore.setState({ automation: new Map([['s1', { ...DEFAULT_AUTOMATION, autoEnter: false }]]) });
    await sendQueueItemNow(session(), item());
    expect(sendPromptToTerminal).toHaveBeenCalledWith('term-1', 'run it\nplease', false, SUBMIT_ENTER_DELAY_MS);
    expect(recordQueueSent).not.toHaveBeenCalled();
  });

  it('keeps the prompt when the Mac refuses the write, and says so', async () => {
    vi.mocked(sendPromptToTerminal).mockResolvedValue(false);
    await expect(sendQueueItemNow(session(), item())).resolves.toBe(false);
    expect(useQueueStore.getState().queues.get('s1')).toHaveLength(1);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/Couldn’t send it/), 'error');
  });

  it('needs a terminal to type into', async () => {
    await expect(sendQueueItemNow(session({ terminalId: null }), item())).resolves.toBe(false);
    expect(sendPromptToTerminal).not.toHaveBeenCalled();
  });

  it('hands a loop or a chain to the Mac\'s scheduler instead of typing it', async () => {
    const loop = item({ type: 'loop', intervalMs: 60_000, execState: 'idle' as never });
    useQueueStore.setState({ queues: new Map([['s1', [loop]]]) });
    await expect(sendQueueItemNow(session(), loop)).resolves.toBe(true);
    expect(sendPromptToTerminal).not.toHaveBeenCalled();
    expect(useQueueStore.getState().queues.get('s1')?.[0]).toMatchObject({ forceStart: true });
  });

  it('refuses a paused prompt and a paused session\'s loop', async () => {
    await expect(sendQueueItemNow(session(), item({ disabled: true }))).resolves.toBe(false);
    useQueueStore.setState({ automation: new Map([['s1', { ...DEFAULT_AUTOMATION, paused: true }]]) });
    await expect(sendQueueItemNow(session(), item({ type: 'loop' }))).resolves.toBe(false);
    expect(sendPromptToTerminal).not.toHaveBeenCalled();
  });
});
