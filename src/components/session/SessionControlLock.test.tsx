// SessionControlLock.test.tsx — what "Release" tells the user.
//
// Release frees the control baton; it does not make the session visible. A
// device that is not this machine (an iPad on the LAN) only ever sees sessions
// switched to SHARED (server/sessionVisibility.ts), so releasing a HOST ONLY
// session hands nothing to it. The toast used to say "any device can take this
// session now" regardless, and the user went to the iPad to find nothing
// there. Now the message is true, and the missing step is one explicit click
// away. Sharing is never done automatically: it is the visibility opt-in.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { DevicePresence, Session } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'mac', getClientLabel: () => 'Mac · Desktop App' }));
vi.mock('@/lib/presenceClient', () => ({
  claimControl: vi.fn(),
  requestControl: vi.fn(),
  grantControl: vi.fn(),
  releaseControl: vi.fn(async () => ({ ok: true, released: true })),
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import SessionControlLock from './SessionControlLock';
import { usePresenceStore } from '@/stores/presenceStore';
import { useSessionStore } from '@/stores/sessionStore';
import { releaseControl } from '@/lib/presenceClient';
import { showToast } from '@/components/ui/ToastContainer';

const SID = 'sess-1';

function device(clientId: string, label: string, isLocal: boolean): DevicePresence {
  return { clientId, label, address: isLocal ? '::1' : '192.168.4.50', isLocal, connections: 1, connectedAt: 1, lastSeenAt: 1 };
}

function setup(opts: { remoteVisible?: boolean; others: DevicePresence[] }) {
  usePresenceStore.getState().applyPresence({
    devices: [device('mac', 'Mac · Desktop App', true), ...opts.others],
    controllers: [{ sessionId: SID, clientId: 'mac', label: 'Mac · Desktop App', since: 1, lastActivityAt: 1, online: true }],
    restoreOwner: null,
    workspaceWriter: null,
  });
  const session = { sessionId: SID, title: 'SMS Requirements', status: 'idle', remoteVisible: opts.remoteVisible } as unknown as Session;
  useSessionStore.setState({ sessions: new Map([[SID, session]]) });
}

/** The toast shown after Release: [message, type, duration, action?]. */
async function releaseAndReadToast() {
  fireEvent.click(screen.getByRole('button', { name: 'Release' }));
  await waitFor(() => expect(showToast).toHaveBeenCalled());
  expect(releaseControl).toHaveBeenCalledWith(SID);
  return vi.mocked(showToast).mock.calls.at(-1)!;
}

beforeEach(() => {
  vi.mocked(showToast).mockClear();
  vi.mocked(releaseControl).mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

describe('SessionControlLock — Release', () => {
  it('a shared session: any device can take it now', async () => {
    setup({ remoteVisible: true, others: [device('ipad', 'iPad · Safari', false)] });
    render(<SessionControlLock sessionId={SID} />);
    const [message, , , action] = await releaseAndReadToast();
    expect(message).toBe('Released — any device can take this session now');
    expect(action).toBeUndefined();
  });

  it('a host-only session with only this machine\'s other windows around: they can take it', async () => {
    setup({ remoteVisible: false, others: [device('chrome', 'Mac · Chrome', true)] });
    render(<SessionControlLock sessionId={SID} />);
    const [message, , , action] = await releaseAndReadToast();
    expect(message).toBe('Released — any device can take this session now');
    expect(action).toBeUndefined();
  });

  it('a host-only session with an iPad connected: says the iPad cannot see it, and offers Share', async () => {
    setup({ remoteVisible: false, others: [device('ipad', 'iPad · Safari', false)] });
    render(<SessionControlLock sessionId={SID} />);
    const [message, , duration, action] = await releaseAndReadToast();
    expect(message).toMatch(/HOST ONLY/);
    expect(message).toMatch(/iPad · Safari can't see it/);
    expect(message).not.toMatch(/any device can take/);
    expect(duration).toBeGreaterThanOrEqual(8000); // long enough to read and press Share
    expect(action?.label).toBe('Share');
    // Nothing was shared by releasing.
    expect(useSessionStore.getState().sessions.get(SID)?.remoteVisible).toBeFalsy();

    action!.onClick();
    expect(useSessionStore.getState().sessions.get(SID)?.remoteVisible).toBe(true);
    expect(vi.mocked(showToast).mock.calls.at(-1)?.[0]).toBe('Shared — iPad · Safari can open it now');
  });

  // The store only offers a toggle: pressing Share after the session was shared
  // another way (the SHARED button) must not flip it back to host-only.
  it('Share leaves an already-shared session shared', async () => {
    setup({ remoteVisible: false, others: [device('ipad', 'iPad · Safari', false)] });
    render(<SessionControlLock sessionId={SID} />);
    const [, , , action] = await releaseAndReadToast();
    const s = useSessionStore.getState().sessions.get(SID)!;
    useSessionStore.setState({ sessions: new Map([[SID, { ...s, remoteVisible: true }]]) });
    action!.onClick();
    expect(useSessionStore.getState().sessions.get(SID)?.remoteVisible).toBe(true);
  });

  it('several remote devices are named as a group', async () => {
    setup({ remoteVisible: false, others: [device('ipad', 'iPad · Safari', false), device('phone', 'iPhone · Safari', false)] });
    render(<SessionControlLock sessionId={SID} />);
    const [message, , , action] = await releaseAndReadToast();
    expect(message).toMatch(/your other devices can't see it/);
    action!.onClick();
    expect(vi.mocked(showToast).mock.calls.at(-1)?.[0]).toBe('Shared — your other devices can open it now');
  });
});
