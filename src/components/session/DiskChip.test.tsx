// DiskChip.test.tsx — the session panel's disk readout (Nov 26 2026).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DiskChip from './DiskChip';

const GB = 1024 ** 3;

function stub(reply: { status: number; body: unknown }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DiskChip', () => {
  it('shows the free space of the session’s disk, red and named when it is almost full', async () => {
    const calls = stub({ status: 200, body: { ok: true, freeBytes: 3.8 * GB, totalBytes: 494 * GB, path: '/work/proj' } });
    render(<DiskChip sessionId="s 1" />);
    const chip = await screen.findByTestId('disk-chip');
    expect(chip.textContent).toBe('3.8 GB');
    expect(chip).toHaveAttribute('data-tone', 'critical');
    expect(chip).toHaveAccessibleName('Disk: Almost full. 3.8 GB free of 494 GB · 99% used. Read it again.');
    expect(calls).toEqual(['/api/sessions/s%201/disk']);
  });

  it('is plain with room to spare', async () => {
    stub({ status: 200, body: { ok: true, freeBytes: 200 * GB, totalBytes: 500 * GB, path: '/w' } });
    render(<DiskChip sessionId="s1" />);
    const chip = await screen.findByTestId('disk-chip');
    expect(chip).toHaveAttribute('data-tone', 'ok');
    expect(chip).toHaveAccessibleName('Disk: 200 GB free of 500 GB · 60% used. Read it again.');
  });

  it('renders nothing when the route answers 404 (another device, another SSH host)', async () => {
    const calls = stub({ status: 404, body: { ok: false } });
    const { container } = render(<DiskChip sessionId="s1" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(container.innerHTML).toBe('');
  });

  it('reads the disk again on a click', async () => {
    const calls = stub({ status: 200, body: { ok: true, freeBytes: 30 * GB, totalBytes: 500 * GB, path: '/w' } });
    render(<DiskChip sessionId="s1" />);
    fireEvent.click(await screen.findByTestId('disk-chip'));
    await waitFor(() => expect(calls).toHaveLength(2));
  });
});
