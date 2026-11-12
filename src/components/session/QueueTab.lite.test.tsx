// QueueTab.lite.test.tsx — the queue in the Lite build: the strip is one line while empty and opens on a click or
// when prompts are queued; the QUEUE tab stays open. A pop-out window is not on Lite's list.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));

import QueueTab from './QueueTab';
import { useUiStore } from '@/stores/uiStore';

describe('QueueTab in the Lite build', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    useUiStore.setState({ queueStripChoice: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers no detach button and keeps the compose box', () => {
    render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" alwaysOpen />);
    expect(screen.queryByRole('button', { name: /Detach Queue/ })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Add a prompt to the queue/i)).toBeInTheDocument();
  });

  it('is one line while empty, and a click opens it for typing the first prompt', () => {
    const { container } = render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" />);
    const panel = container.querySelector('[data-queue-panel]');
    expect(panel?.className).toMatch(/collapsed/);

    fireEvent.click(screen.getByRole('button', { name: /Expand the queue/i }));

    expect(panel?.className).not.toMatch(/collapsed/);
    expect(screen.getByRole('button', { name: /Collapse the queue/i })).toBeInTheDocument();
  });

  it('marks the strip\'s compose box as the one that holds the strip open', () => {
    const { container } = render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" />);
    const box = screen.getByPlaceholderText(/Add a prompt to the queue/i);
    expect(container.querySelector('[data-queue-compose="s1"]')?.contains(box)).toBe(true);
  });

  it('leaves the QUEUE tab\'s compose box out of it', () => {
    const { container } = render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" alwaysOpen />);
    expect(container.querySelector('[data-queue-compose]')).toBeNull();
  });

  it('never folds the QUEUE tab, which has nothing else to show', () => {
    const { container } = render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" alwaysOpen />);
    expect(container.querySelector('[data-queue-panel]')?.className).not.toMatch(/collapsed/);
    expect(screen.queryByRole('button', { name: /(Expand|Collapse) the queue/i })).not.toBeInTheDocument();
  });
});
