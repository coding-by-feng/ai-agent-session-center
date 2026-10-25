// queueSendNow.test.ts — ⚡ "Send now" from the phone's Queue tab (AASC-47). A plain
// prompt goes through the Mac's confirmed prompt route (mocked here: nothing
// reaches a real terminal), never as raw keystrokes: typed into an open approval
// dialog, a prompt's Enter would answer "Yes".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '@/types';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/chat/promptApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/promptApi')>()),
  sendPrompt: vi.fn(async () => ({ ok: true, key: 'k1' })),
  waitForPrompt: vi.fn(async () => 'submitted'),
}));
vi.mock('@/lib/terminalSend', () => ({
  sendPromptToTerminal: vi.fn(async () => { throw new Error('a phone never types a queued prompt as raw keystrokes'); }),
}));
vi.mock('@/stores/queueSentStore', () => ({ recordQueueSent: vi.fn() }));

import { sendQueueItemNow } from './queueSendNow';
import { DEFAULT_AUTOMATION, useQueueStore, type QueueItem } from '@/stores/queueStore';
import { sendPrompt, waitForPrompt } from '@/lib/chat/promptApi';
import { sendPromptToTerminal } from '@/lib/terminalSend';
import { recordQueueSent } from '@/stores/queueSentStore';
import { showToast } from '@/components/ui/ToastContainer';

const session = (over: Partial<Session> = {}) => ({ sessionId: 's1', status: 'waiting', terminalId: 'term-1', ...over }) as Session;
const item = (over: Partial<QueueItem> = {}): QueueItem => ({ id: 7, sessionId: 's1', text: 'run it\\nplease', position: 0, createdAt: 0, ...over });
const photo = (name: string) => ({ name, dataUrl: 'data:image/png;base64,AA' });
const queued = () => useQueueStore.getState().queues.get('s1') ?? [];

beforeEach(() => {
  vi.mocked(sendPrompt).mockReset().mockResolvedValue({ ok: true, key: 'k1' });
  vi.mocked(waitForPrompt).mockReset().mockResolvedValue('submitted');
  vi.mocked(sendPromptToTerminal).mockClear();
  vi.mocked(recordQueueSent).mockClear();
  vi.mocked(showToast).mockClear();
  useQueueStore.setState({ queues: new Map([['s1', [item()]]]), automation: new Map() });
});

describe('sendQueueItemNow', () => {
  it('sends a plain prompt through the Mac\'s confirmed route, then takes it off the queue', async () => {
    await expect(sendQueueItemNow(session(), item())).resolves.toBe(true);
    expect(sendPrompt).toHaveBeenCalledWith('s1', { text: 'run it\nplease', images: [], mode: 'now' });
    expect(waitForPrompt).toHaveBeenCalledWith('s1', 'k1');
    expect(recordQueueSent).toHaveBeenCalledWith('s1', expect.objectContaining({ text: 'run it\nplease' }));
    expect(queued()).toEqual([]);
    expect(sendPromptToTerminal).not.toHaveBeenCalled();
  });

  it('takes it off the queue it moved to when the session re-keyed meanwhile', async () => {
    vi.mocked(waitForPrompt).mockImplementation(async () => {
      useQueueStore.getState().migrateSession('s1', 's1b');
      return 'submitted';
    });
    await expect(sendQueueItemNow(session(), item())).resolves.toBe(true);
    expect(useQueueStore.getState().queues.get('s1b') ?? []).toEqual([]);
  });

  it('never sends while the session waits on an approval: the text would answer it', async () => {
    await expect(sendQueueItemNow(session({ status: 'approval' }), item())).resolves.toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(sendPromptToTerminal).not.toHaveBeenCalled();
    expect(queued()).toHaveLength(1);
    expect(showToast).toHaveBeenCalledWith('Answer the waiting approval first.', 'info');
  });

  it('never sends while a question waits, by status or by its structured request', async () => {
    await expect(sendQueueItemNow(session({ status: 'input' }), item())).resolves.toBe(false);
    await expect(sendQueueItemNow(session({ status: 'working', pendingRequest: { kind: 'permission' } as never }), item())).resolves.toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(queued()).toHaveLength(1);
  });

  it('keeps the prompt when the Mac finds an answer waiting, in plain words', async () => {
    vi.mocked(sendPrompt).mockResolvedValue({ ok: false, error: { code: 'awaiting_answer', message: 'The agent is waiting for an answer. Answer it first.' } });
    await expect(sendQueueItemNow(session(), item())).resolves.toBe(false);
    expect(queued()).toHaveLength(1);
    expect(showToast).toHaveBeenCalledWith('Answer the waiting question first.', 'error');
    expect(waitForPrompt).not.toHaveBeenCalled();
  });

  it('passes the Mac\'s other refusals on as they are', async () => {
    vi.mocked(sendPrompt).mockResolvedValue({ ok: false, error: { code: 'control_held', message: 'MacBook is driving this session. Take control to send.' } });
    await expect(sendQueueItemNow(session(), item())).resolves.toBe(false);
    expect(showToast).toHaveBeenCalledWith('MacBook is driving this session. Take control to send.', 'error');
    expect(queued()).toHaveLength(1);
  });

  it('takes it off only once the Mac says it was sent', async () => {
    vi.mocked(waitForPrompt).mockResolvedValue('unconfirmed');
    await expect(sendQueueItemNow(session(), item())).resolves.toBe(true);
    expect(queued()).toEqual([]);

    useQueueStore.setState({ queues: new Map([['s1', [item()]]]) });
    for (const result of ['stopped', 'gave-up', 'failed', 'timeout', 'unknown'] as const) {
      vi.mocked(waitForPrompt).mockResolvedValue(result);
      await expect(sendQueueItemNow(session(), item())).resolves.toBe(false);
      expect(queued(), result).toHaveLength(1);
    }
    expect(recordQueueSent).toHaveBeenCalledTimes(1);
  });

  it('sends its photos with it, and refuses more than the route takes', async () => {
    const withPhotos = item({ images: [photo('a.png'), photo('b.png')] });
    await sendQueueItemNow(session(), withPhotos);
    expect(sendPrompt).toHaveBeenCalledWith('s1', { text: 'run it\nplease', images: withPhotos.images, mode: 'now' });

    vi.mocked(sendPrompt).mockClear();
    // The route takes 10 since Oct 21 2026 (was 4).
    const tooMany = item({ images: Array.from({ length: 11 }, (_, n) => photo(`${n}.png`)) });
    await expect(sendQueueItemNow(session(), tooMany)).resolves.toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('needs some words: the route won\'t send photos alone', async () => {
    await expect(sendQueueItemNow(session(), item({ text: '  ', images: [photo('a.png')] }))).resolves.toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('hands a loop or a chain to the Mac\'s scheduler instead of sending it', async () => {
    const loop = item({ type: 'loop', intervalMs: 60_000 });
    useQueueStore.setState({ queues: new Map([['s1', [loop]]]) });
    await expect(sendQueueItemNow(session(), loop)).resolves.toBe(true);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(queued()[0]).toMatchObject({ forceStart: true });
  });

  it('refuses a paused prompt and a paused session\'s loop', async () => {
    await expect(sendQueueItemNow(session(), item({ disabled: true }))).resolves.toBe(false);
    useQueueStore.setState({ automation: new Map([['s1', { ...DEFAULT_AUTOMATION, paused: true }]]) });
    await expect(sendQueueItemNow(session(), item({ type: 'loop' }))).resolves.toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
