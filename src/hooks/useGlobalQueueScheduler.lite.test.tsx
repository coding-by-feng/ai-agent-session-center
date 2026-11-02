/**
 * Auto-resume types into a session on its own, and Lite shows its switch only inside QUEUE, which
 * shows only while the session has queued prompts. So without any, Lite must not type at all.
 * Driven through the real hook; only the PTY write is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

const edition = vi.hoisted(() => ({ lite: true }));
vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  get IS_LITE() { return edition.lite; },
}));
vi.mock('@/lib/terminalSend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/terminalSend')>()),
  sendPromptToTerminal: vi.fn(async () => true),
  pressEnterInTerminal: vi.fn(async () => true),
}));
vi.mock('@/stores/presenceStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/presenceStore')>()),
  firesQueue: () => true,
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/stores/queueSentStore', () => ({ recordQueueSent: vi.fn() }));

import { useGlobalQueueScheduler } from './useGlobalQueueScheduler';
import { sendPromptToTerminal } from '@/lib/terminalSend';
import { DEFAULT_RESUME_PROMPT } from '@/lib/resumeWatchdog';
import { useSessionStore } from '@/stores/sessionStore';
import { useQueueStore, DEFAULT_AUTOMATION, type QueueItem } from '@/stores/queueStore';
import type { Session } from '@/types';

const T0 = 1_800_000_000_000;
const send = vi.mocked(sendPromptToTerminal);

function Harness() {
  useGlobalQueueScheduler();
  return null;
}

function setQueue(items: QueueItem[]): void {
  useQueueStore.setState({ queues: new Map(items.length ? [['s1', items]] : []), automation: new Map() });
}

/** Past the settle time, the first backoff and any jitter (a minute is more than all three). */
async function waitForResume(): Promise<void> {
  render(<Harness />);
  for (let t = 0; t < 60_000; t += 500) {
    await act(async () => { vi.advanceTimersByTime(500); });
  }
}

const resumed = () => send.mock.calls.some(([, prompt]) => prompt === DEFAULT_RESUME_PROMPT);

describe('auto-resume and the Lite build', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    send.mockReset();
    send.mockImplementation(async () => true);
    const session = {
      sessionId: 's1', title: 'Work', status: 'waiting', terminalId: 'term-1', lastActivityAt: T0,
      subagentCount: 0, userCancelledAt: null,
      interruption: { kind: 'api_error', line: 'API Error: 529 Overloaded', detectedAt: T0 },
    } as unknown as Session;
    useSessionStore.setState({ sessions: new Map([['s1', session]]) } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Full rescues a session with an empty queue', async () => {
    edition.lite = false;
    setQueue([]);
    await waitForResume();
    expect(resumed()).toBe(true);
  });

  it('Lite types nothing into a session with an empty queue', async () => {
    edition.lite = true;
    setQueue([]);
    await waitForResume();
    expect(send).not.toHaveBeenCalled();
  });

  it('Lite still rescues a session with queued prompts, whose QUEUE tab holds the switch', async () => {
    edition.lite = true;
    setQueue([{ id: 1, sessionId: 's1', text: 'next', position: 0, createdAt: T0, type: 'once' }]);
    // Auto-send off so the prompt stays queued: with it on, the queue sends first and then is empty.
    useQueueStore.setState({ automation: new Map([['s1', { ...DEFAULT_AUTOMATION, autoSend: false }]]) });
    await waitForResume();
    expect(resumed()).toBe(true);
    expect(useQueueStore.getState().queues.get('s1')).toHaveLength(1);
  });
});
