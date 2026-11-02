// QueueTab.lite.test.tsx — the queue strip in the Lite build works as usual, but a pop-out window is not on Lite's list.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));

import QueueTab from './QueueTab';

describe('QueueTab in the Lite build', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })));
  afterEach(() => vi.unstubAllGlobals());

  it('offers no detach button and keeps the compose box', () => {
    render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" />);
    expect(screen.queryByRole('button', { name: /Detach Queue/ })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Add a prompt to the queue/i)).toBeInTheDocument();
  });
});
