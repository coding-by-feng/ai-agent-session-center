// PhonePairing.account.test.tsx — plan 17: the device panel's account switch and "via account" rows.
//
// "Let phones signed into my AASC Cloud account connect" is a checkbox under the Pair button, with the account's
// email under it; disabled with the reason when a signed-in Mac can't let them in (pairing off, no password).
// A Mac not signed into AASC Cloud shows no account UI at all: PhonePairing.cloudOptional.cases.tsx.
// A phone that enrolled through the account shows "via account · <email>" on its row, and revoking it warns
// that the Mac also signs it out of AASC Cloud (review H1).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import PhonePairing from './PhonePairing';
import type { AccountEnrollState, PairedPhone } from '@/lib/mobilePairingApi';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

let phones: PairedPhone[];
let offered: boolean;
let accountEnroll: AccountEnrollState | undefined;
let putBodies: unknown[];
let putAnswer: { status: number; body: unknown } | null;
let releasePut: (() => void) | null;

const LABEL = 'Let phones signed into my AASC Cloud account connect';

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body });
}

function phone(overrides: Partial<PairedPhone>): PairedPhone {
  return {
    id: 'p1', label: 'Kason iPhone', platform: 'ios', status: 'active', confirmCode: null,
    createdAt: Date.now(), approvedAt: Date.now(), lastSeenAt: null, ...overrides,
  };
}

beforeEach(() => {
  phones = [];
  offered = true;
  accountEnroll = { enabled: true, available: true, email: 'me@example.com', blocked: null };
  putBodies = [];
  putAnswer = null;
  releasePut = null;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/mobile/devices') {
      return json(200, { success: true, data: { devices: phones, pairingOffered: offered, ...(accountEnroll ? { accountEnroll } : {}) } });
    }
    if (url === '/api/mobile/pairing/account-enroll' && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as { enabled: boolean };
      putBodies.push(body);
      if (putAnswer) return json(putAnswer.status, putAnswer.body);
      const answer = () => {
        accountEnroll = { ...accountEnroll!, enabled: body.enabled };
        return { ok: true, status: 200, json: async () => ({ success: true, data: { accountEnroll } }) };
      };
      return new Promise((resolve) => { releasePut = () => resolve(answer()); });
    }
    if (url === '/api/mobile/cloud-phones') return json(200, { success: true, data: { cloud: false } });
    return json(404, { error: 'Not found' });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('PhonePairing — account enroll (plan 17)', () => {
  it('shows the switch on, with the account it lets in', async () => {
    render(<PhonePairing />);
    const box = await screen.findByRole('checkbox', { name: LABEL });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect((box as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText('me@example.com')).toBeTruthy();
  });

  it('turns it off, holding the box while the Mac saves', async () => {
    render(<PhonePairing />);
    const box = (await screen.findByRole('checkbox', { name: LABEL })) as HTMLInputElement;
    box.focus();
    fireEvent.click(box);
    await waitFor(() => expect(putBodies).toEqual([{ enabled: false }]));
    expect(box.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(box); // ignored while the first is saving
    expect(putBodies).toHaveLength(1);
    expect(document.activeElement).toBe(box); // keyboard focus stays on the box
    releasePut?.();
    await waitFor(() => expect(box.checked).toBe(false));
    expect(box.getAttribute('aria-busy')).toBe('false');
  });

  it('says why when the Mac refuses, and keeps the box as it was', async () => {
    putAnswer = { status: 409, body: { error: 'AASC_PHONE_ACCOUNT_ENROLL is set in this Mac’s environment, so it decides this setting.' } };
    render(<PhonePairing />);
    const box = (await screen.findByRole('checkbox', { name: LABEL })) as HTMLInputElement;
    fireEvent.click(box);
    expect(await screen.findByText(/AASC_PHONE_ACCOUNT_ENROLL is set/)).toBeTruthy();
    expect(box.checked).toBe(true);
  });

  it.each([
    ['no-password', 'Set a dashboard password first'],
    ['pairing-off', 'Phone pairing is off on this Mac'],
  ] as const)('is disabled with a reason when blocked by %s', async (blocked, reason) => {
    accountEnroll = { enabled: false, available: blocked !== 'no-password', email: 'me@example.com', blocked };
    phones = [phone({})]; // keeps the section when pairing is off
    render(<PhonePairing />);
    const box = (await screen.findByRole('checkbox', { name: LABEL })) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(box.getAttribute('aria-describedby')).toBe(screen.getByText(reason).id);
    expect(screen.queryByText('me@example.com')).toBeNull();
    fireEvent.click(box);
    expect(putBodies).toEqual([]);
  });

  it('shows no switch and no sign-in hint when this Mac isn’t signed into AASC Cloud (AASC-64)', async () => {
    accountEnroll = { enabled: false, available: false, email: null, blocked: 'no-cloud' };
    render(<PhonePairing />);
    await screen.findByText('No phones or computers paired.');
    expect(screen.queryByRole('checkbox', { name: LABEL })).toBeNull();
    expect(screen.queryByText('Sign in to AASC Cloud first')).toBeNull();
  });

  it('shows no switch from a server without it', async () => {
    accountEnroll = undefined;
    render(<PhonePairing />);
    await screen.findByText('No phones or computers paired.');
    expect(screen.queryByRole('checkbox', { name: LABEL })).toBeNull();
  });

  it('shows nothing about phones when pairing is off and none are paired: account phones can’t connect either (review M1)', async () => {
    offered = false;
    accountEnroll = { enabled: false, available: true, email: 'me@example.com', blocked: 'pairing-off' };
    const { container } = render(<PhonePairing />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/mobile/devices', expect.anything()));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe('');
  });

  it('warns that revoking an account phone also signs it out of AASC Cloud, and says nothing for a code phone', async () => {
    phones = [
      phone({ id: 'a1', label: 'Account Pixel', platform: 'android', origin: 'account', accountEmail: 'me@example.com' }),
      phone({ id: 'c1', label: 'Code iPhone', origin: 'code', accountEmail: null }),
    ];
    render(<PhonePairing />);
    await screen.findByText('Account Pixel');
    const row = (label: string) => screen.getByText(label).closest('li') as HTMLElement;
    fireEvent.click(within(row('Code iPhone')).getByRole('button', { name: 'Revoke…' }));
    expect(screen.queryByText(/signs it out of AASC Cloud/)).toBeNull();
    fireEvent.click(within(row('Code iPhone')).getByRole('button', { name: 'Keep' }));
    fireEvent.click(within(row('Account Pixel')).getByRole('button', { name: 'Revoke…' }));
    const note = screen.getByText(
      'This also signs it out of AASC Cloud. Signing in with Google on that phone again lets it connect again unless you turn off account phones here.',
    );
    const confirm = within(row('Account Pixel')).getByRole('button', { name: 'Revoke' });
    expect(confirm.getAttribute('aria-describedby')).toBe(note.id);
  });

  it('tags a phone that enrolled through the account, and no other', async () => {
    phones = [
      phone({ id: 'a1', label: 'Account Pixel', platform: 'android', origin: 'account', accountEmail: 'me@example.com' }),
      phone({ id: 'c1', label: 'Code iPhone', origin: 'code', accountEmail: null }),
      phone({ id: 'a2', label: 'No-email Pixel', platform: 'android', origin: 'account', accountEmail: null }),
    ];
    render(<PhonePairing />);
    expect(await screen.findByText('via account · me@example.com')).toBeTruthy();
    expect(screen.getAllByText(/^via account/)).toHaveLength(2);
    expect(screen.getByText('via account')).toBeTruthy();
  });
});
