// PhonePairing.cloudOptional.cases.tsx — AASC-64: AASC Cloud sign-in stays strictly optional, in Full AND Lite.
//
// Shared by PhonePairing.cloudOptional.test.tsx (Full) and PhonePairing.cloudOptional.lite.test.tsx (IS_LITE
// mocked true). A Mac that isn't signed into AASC Cloud (`blocked: 'no-cloud'`, or an older server that only says
// `available: false`) shows NO account UI in Phones & computers: no switch, no "sign in" hint. Its owner sees QR
// pairing exactly as a server without account enroll showed it. A signed-in Mac blocked by pairing-off or
// no-password keeps the greyed switch with its reason, and rows that joined through the account keep their tag.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import PhonePairing from './PhonePairing';
import type { PairedPhone } from '@/lib/mobilePairingApi';

const LABEL = 'Let phones signed into my AASC Cloud account connect';

function phone(overrides: Partial<PairedPhone>): PairedPhone {
  return {
    id: 'p1', label: 'Kason iPhone', platform: 'ios', status: 'active', confirmCode: null,
    createdAt: 1, approvedAt: 1, lastSeenAt: null, ...overrides,
  };
}

export function describeCloudOptional(edition: 'Full' | 'Lite'): void {
  let phones: PairedPhone[];
  let offered: boolean;
  /** undefined: a server from before account enroll (AASC-64), which sends no accountEnroll at all. */
  let accountEnroll: Record<string, unknown> | undefined;

  beforeEach(() => {
    phones = [];
    offered = true;
    accountEnroll = undefined;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const json = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: async () => body });
      if (url === '/api/mobile/devices') {
        return json(200, { success: true, data: { devices: phones, pairingOffered: offered, ...(accountEnroll ? { accountEnroll } : {}) } });
      }
      if (url === '/api/mobile/cloud-phones') return json(200, { success: true, data: { cloud: false } });
      return json(404, { error: 'Not found' });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /** The panel once its first read has landed. */
  async function rendered(): Promise<string> {
    const { container, unmount } = render(<PhonePairing />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/mobile/devices', expect.anything()));
    await screen.findByRole('button', { name: 'Pair a phone or computer' });
    const html = container.innerHTML;
    unmount();
    return html;
  }

  describe(`PhonePairing — AASC Cloud sign-in is optional (${edition})`, () => {
    it.each([
      ['not signed in', { enabled: false, available: false, email: null, blocked: 'no-cloud' }],
      ['not signed in, and no password either', { enabled: false, available: false, email: null, blocked: 'no-cloud' }],
      ['an older server that only says unavailable', { enabled: true, available: false, email: null }],
    ])('shows no account UI when %s, exactly as before AASC-64', async (_label, state) => {
      const before = await rendered(); // no accountEnroll in the answer: the pre-AASC-64 panel
      accountEnroll = state;
      const now = await rendered();
      expect(now).toBe(before);
      render(<PhonePairing />);
      expect(await screen.findByText('No phones or computers paired.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Pair a phone or computer' })).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: LABEL })).toBeNull();
      expect(document.body.textContent).not.toMatch(/AASC Cloud/);
    });

    it.each([
      ['pairing-off', 'Phone pairing is off on this Mac'],
      ['no-password', 'Set a dashboard password first'],
    ] as const)('keeps the greyed switch with its reason for a signed-in Mac blocked by %s', async (blocked, reason) => {
      accountEnroll = { enabled: false, available: blocked !== 'no-password', email: 'me@example.com', blocked };
      phones = [phone({})]; // keeps the section when pairing is off
      render(<PhonePairing />);
      const box = (await screen.findByRole('checkbox', { name: LABEL })) as HTMLInputElement;
      expect(box.disabled).toBe(true);
      expect(screen.getByText(reason)).toBeTruthy();
    });

    it('still tags a phone that joined through the account after the Mac signed out, with no switch', async () => {
      accountEnroll = { enabled: false, available: false, email: null, blocked: 'no-cloud' };
      phones = [phone({ id: 'a1', label: 'Account Pixel', platform: 'android', origin: 'account', accountEmail: 'me@example.com' })];
      render(<PhonePairing />);
      expect(await screen.findByText('via account · me@example.com')).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: LABEL })).toBeNull();
    });
  });
}
