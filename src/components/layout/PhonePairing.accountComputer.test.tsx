// PhonePairing.accountComputer.test.tsx — plan 18, stage 2: a computer that connected through the AASC Cloud
// account, in "Phones & computers".
//
// While it waits it is an ordinary pending computer: Allow / Deny with the code both screens show. Once in, its
// row reads "via account · <email>" like an account phone's. Revoking it is NOT what revoking an account phone
// is: the computer is refused here and stays signed in to AASC Cloud, so the note before Revoke must say that.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import PhonePairing from './PhonePairing';
import type { PairedPhone } from '@/lib/mobilePairingApi';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

let phones: PairedPhone[];

const PHONE_NOTE =
  'This also signs it out of AASC Cloud. Signing in with Google on that phone again lets it connect again unless you turn off account phones here.';
const COMPUTER_NOTE =
  'It stays signed in to AASC Cloud, and can connect through your account again only after it signs in there anew. A pairing link still works.';

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body });
}

function device(overrides: Partial<PairedPhone>): PairedPhone {
  return {
    id: 'd1', label: 'MacBook Pro', platform: 'desktop', status: 'active', confirmCode: null,
    createdAt: Date.now(), approvedAt: Date.now(), lastSeenAt: null, origin: 'account', accountEmail: 'me@example.com',
    ...overrides,
  };
}

beforeEach(() => {
  phones = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/mobile/devices') {
      return json(200, {
        success: true,
        data: {
          devices: phones, pairingOffered: true,
          accountEnroll: { enabled: true, available: true, email: 'me@example.com', blocked: null },
        },
      });
    }
    if (url === '/api/mobile/cloud-phones') return json(200, { success: true, data: { cloud: false } });
    return json(404, { error: 'Not found' });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('PhonePairing — a computer through the account (plan 18)', () => {
  it('asks to allow a waiting one like any computer, with its code', async () => {
    phones = [device({ status: 'pending', confirmCode: '482913', approvedAt: null })];
    render(<PhonePairing />);
    const prompt = await screen.findByRole('alert');
    expect(prompt.textContent).toContain('Allow MacBook Pro (Computer)?');
    expect(prompt.textContent).toContain('482 913');
    expect(within(prompt).getByRole('button', { name: 'Allow' })).toBeTruthy();
    expect(within(prompt).getByRole('button', { name: 'Deny' })).toBeTruthy();
  });

  it('tags its row "via account" once it is in', async () => {
    phones = [device({})];
    render(<PhonePairing />);
    expect(await screen.findByText('via account · me@example.com')).toBeTruthy();
  });

  it('says what revoking it does: refused here, still signed in to AASC Cloud', async () => {
    phones = [
      device({}),
      device({ id: 'p1', label: 'Account Pixel', platform: 'android' }),
      device({ id: 'l1', label: 'Old NUC', origin: 'code', accountEmail: null }),
    ];
    render(<PhonePairing />);
    await screen.findByText('MacBook Pro');
    const row = (label: string) => screen.getByText(label).closest('li') as HTMLElement;

    fireEvent.click(within(row('MacBook Pro')).getByRole('button', { name: 'Revoke…' }));
    const note = screen.getByText(COMPUTER_NOTE);
    expect(screen.queryByText(PHONE_NOTE)).toBeNull();
    expect(within(row('MacBook Pro')).getByRole('button', { name: 'Revoke' }).getAttribute('aria-describedby')).toBe(note.id);
    fireEvent.click(within(row('MacBook Pro')).getByRole('button', { name: 'Keep' }));

    fireEvent.click(within(row('Account Pixel')).getByRole('button', { name: 'Revoke…' }));
    expect(screen.getByText(PHONE_NOTE)).toBeTruthy();
    expect(screen.queryByText(COMPUTER_NOTE)).toBeNull();
    fireEvent.click(within(row('Account Pixel')).getByRole('button', { name: 'Keep' }));

    fireEvent.click(within(row('Old NUC')).getByRole('button', { name: 'Revoke…' }));
    expect(screen.queryByText(COMPUTER_NOTE)).toBeNull();
    expect(screen.queryByText(PHONE_NOTE)).toBeNull();
  });
});
