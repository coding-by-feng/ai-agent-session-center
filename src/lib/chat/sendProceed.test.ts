// sendProceed.test.ts — the desktop rail's P sends "proceed" in one click (Nov 17 2026).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/chat/promptApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/promptApi')>()),
  sendPrompt: vi.fn(),
  waitForPrompt: vi.fn(),
}));

import { sendProceed, PROCEED_TEXT } from './sendProceed';
import { sendPrompt, waitForPrompt } from '@/lib/chat/promptApi';
import { showToast } from '@/components/ui/ToastContainer';

const post = vi.mocked(sendPrompt);
const wait = vi.mocked(waitForPrompt);
const toast = vi.mocked(showToast);

beforeEach(() => {
  post.mockReset();
  wait.mockReset();
  toast.mockReset();
});

describe('sendProceed', () => {
  it('sends "proceed" through the confirmed prompt route and says so', async () => {
    post.mockResolvedValue({ ok: true, key: 'k1' });
    wait.mockResolvedValue('submitted');
    await expect(sendProceed('s1')).resolves.toBe(true);
    expect(PROCEED_TEXT).toBe('proceed');
    expect(post).toHaveBeenCalledWith('s1', { text: 'proceed', mode: 'now' });
    expect(wait).toHaveBeenCalledWith('s1', 'k1');
    expect(toast).toHaveBeenCalledWith('Sent “proceed”', 'success');
  });

  it('shows the Mac’s reason when it refuses, and sends nothing else', async () => {
    post.mockResolvedValue({ ok: false, error: { code: 'busy', message: 'Another device is driving this session.' } as never });
    await expect(sendProceed('s1')).resolves.toBe(false);
    expect(wait).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Another device is driving this session.', 'error');
  });

  it('says so when the CLI never took it', async () => {
    post.mockResolvedValue({ ok: true, key: 'k2' });
    wait.mockResolvedValue('gave-up');
    await expect(sendProceed('s1')).resolves.toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('ignores a second click while the first is still in flight', async () => {
    let release!: (v: { ok: true; key: string }) => void;
    post.mockReturnValue(new Promise((r) => { release = r; }));
    wait.mockResolvedValue('submitted');
    const first = sendProceed('s1');
    await expect(sendProceed('s1')).resolves.toBe(false);
    release({ ok: true, key: 'k3' });
    await expect(first).resolves.toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
