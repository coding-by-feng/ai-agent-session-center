import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const native = vi.hoisted(() => ({ app: false }));
vi.mock('@/lib/platform', async (orig) => ({
  ...(await orig<typeof import('@/lib/platform')>()),
  isNativeMobileApp: () => native.app,
}));
vi.mock('@/lib/deviceIdentity', async (orig) => ({
  ...(await orig<typeof import('@/lib/deviceIdentity')>()),
  getClientId: () => 'phone-1',
}));

import QueueWaitNote from './QueueWaitNote';
import { usePresenceStore } from '@/stores/presenceStore';

const props = {
  items: [{ type: 'once', disabled: false }, { type: 'once', disabled: true }],
  autoSend: true,
  automationPaused: false,
  held: false,
  sessionStatus: 'working',
  cliName: 'Claude',
  phone: true,
};

describe('QueueWaitNote', () => {
  beforeEach(() => {
    native.app = false;
    usePresenceStore.setState({ received: true, workspaceWriter: 'mac-1' } as never);
  });

  it('says the next prompt waits for the turn to end', () => {
    render(<QueueWaitNote {...props} />);
    expect(screen.getByRole('status')).toHaveTextContent('Sends the next prompt when Claude finishes this turn.');
  });

  it('is absent when the session is free to send', () => {
    render(<QueueWaitNote {...props} sessionStatus="waiting" />);
    expect(screen.queryByTestId('queue-wait-note')).toBeNull();
  });

  it('in the phone app with no Mac window (the phone is the writer), says nothing sends', () => {
    native.app = true;
    usePresenceStore.setState({ received: true, workspaceWriter: 'phone-1' } as never);
    render(<QueueWaitNote {...props} />);
    expect(screen.getByTestId('queue-wait-note')).toHaveAttribute('data-kind', 'no-sender');
  });

  it('in the phone app with a Mac window as the writer, only the turn is named', () => {
    native.app = true;
    render(<QueueWaitNote {...props} />);
    expect(screen.getByTestId('queue-wait-note')).toHaveAttribute('data-kind', 'busy');
  });

  it('never claims "no sender" before the server’s presence has arrived', () => {
    native.app = true;
    usePresenceStore.setState({ received: false, workspaceWriter: null } as never);
    render(<QueueWaitNote {...props} />);
    expect(screen.getByTestId('queue-wait-note')).toHaveAttribute('data-kind', 'busy');
  });
});
