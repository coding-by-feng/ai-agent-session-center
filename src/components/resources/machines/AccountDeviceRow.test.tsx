// AccountDeviceRow.test.tsx — the row's guard against sending a sign-out twice must never outlive the sign-out
// (code review, Nov 20 2026). The row is drawn under a cloud session the test holds, so it can stand at the two
// moments the real provider only passes through: a session that has just moved on, and one that moves mid-request.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CloudContext, type CloudSession } from '@/components/resources/cloud/cloudSession';
import AccountDeviceRow from './AccountDeviceRow';
import { CONNECTION, installCloud, mini, type FakeCloud } from './AccountDevices.fixtures';

let cloud: FakeCloud;
const onSignedOut = vi.fn();
const onSettled = vi.fn();

beforeEach(() => {
  cloud = installCloud();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function session(over: Partial<CloudSession> = {}): CloudSession {
  return {
    status: { connection: CONNECTION, state: 'connected', lastError: null },
    epoch: 0, current: () => 0, refresh: vi.fn(), changed: false, apply: vi.fn(), loaded: true, error: null, ...over,
  };
}

function showRow(value: CloudSession) {
  const tree = (v: CloudSession) => (
    <CloudContext.Provider value={v}>
      <table>
        <tbody>
          <AccountDeviceRow device={mini()} fallbackFocus={{ current: null }} onSignedOut={onSignedOut} onStale={vi.fn()} onSettled={onSettled} />
        </tbody>
      </table>
    </CloudContext.Provider>
  );
  const view = render(tree(value));
  return { ...view, update: (v: CloudSession) => view.rerender(tree(v)) };
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('AccountDeviceRow — the double-press guard', () => {
  it('a press that is refused before anything is sent leaves the next press free to work', async () => {
    // The session moved on a moment ago and this render has not caught up: nothing is started.
    let now = 5;
    showRow(session({ epoch: 0, current: () => now }));
    fireEvent.click(button('Sign out Mac mini…'));
    fireEvent.click(button('Sign out'));
    expect((await screen.findByRole('alert')).textContent).toBe('Connection changed. Refresh and review again.');
    expect(cloud.signOuts()).toHaveLength(0);
    expect(onSettled).not.toHaveBeenCalled();

    now = 0;
    fireEvent.click(button('Sign out'));
    await waitFor(() => expect(cloud.signOuts()).toHaveLength(1));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledWith('dev-mini'));
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('Cancel frees it too: after a sign-out that never answered, the row can ask and send again', async () => {
    cloud.onSignOut = () => new Promise<Response>(() => {});
    const view = showRow(session());
    fireEvent.click(button('Sign out Mac mini…'));
    fireEvent.click(button('Sign out'));
    await waitFor(() => expect(cloud.signOuts()).toHaveLength(1));
    // The connection is read again: the first request is given up on, and Cancel is there to press.
    view.update(session({ epoch: 1, current: () => 1 }));
    await waitFor(() => expect(button('Cancel').disabled).toBe(false));
    fireEvent.click(button('Cancel'));
    fireEvent.click(button('Sign out Mac mini…'));
    fireEvent.click(button('Sign out'));
    await waitFor(() => expect(cloud.signOuts()).toHaveLength(2));
  });
});
