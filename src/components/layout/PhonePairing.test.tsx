// PhonePairing.test.tsx — AASC-15: the desktop half of pairing a phone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PhonePairing from './PhonePairing';
import type { PairedPhone } from '@/lib/mobilePairingApi';
import { qrSvg } from '@/lib/qrSvg';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

let phones: PairedPhone[] = [];
let calls: Array<{ url: string; method: string }> = [];

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body });
}

function phone(overrides: Partial<PairedPhone>): PairedPhone {
  return {
    id: 'p1', label: 'Kason iPhone', platform: 'ios', status: 'pending', confirmCode: '123456',
    createdAt: Date.now(), approvedAt: null, lastSeenAt: null, ...overrides,
  };
}

beforeEach(() => {
  phones = [];
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (url === '/api/mobile/devices') return json(200, { success: true, data: { devices: phones } });
    if (url === '/api/mobile/pairing') {
      return json(200, {
        success: true,
        data: { code: 'ABCDEFGHJK', expiresAt: Date.now() + 120_000, link: 'https://aasc.work/pair#v=2&mc=ABCDEFGHJK', backendIncluded: false },
      });
    }
    if (url.endsWith('/approve')) { phones = phones.map((p) => ({ ...p, status: 'active', confirmCode: null })); return json(200, { success: true }); }
    if (method === 'DELETE') { phones = []; return json(200, { success: true }); }
    return json(404, { error: 'Not found' });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('PhonePairing', () => {
  it('starts with no phones and a Pair button', async () => {
    render(<PhonePairing />);
    expect(await screen.findByText('No phones paired.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pair a phone' })).toBeTruthy();
  });

  it('shows a QR, the code in two halves and a countdown after Pair', async () => {
    render(<PhonePairing />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pair a phone' }));
    expect(await screen.findByRole('img', { name: 'QR code to pair a phone' })).toBeTruthy();
    expect(screen.getByText('ABCDE-FGHJK')).toBeTruthy();
    expect(screen.getByText(/Expires in [12]:\d\d/)).toBeTruthy();
    expect(screen.getByText(/Notifications need the AASC backend/)).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/mobile/pairing' && c.method === 'POST')).toBe(true);
  });

  it('asks before letting a pending phone in, showing its confirmation code', async () => {
    phones = [phone({})];
    render(<PhonePairing />);
    expect(await screen.findByText('123 456')).toBeTruthy();
    expect(screen.getByText(/Allow only if your phone shows the same code/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/mobile/devices/p1/approve' && c.method === 'POST')).toBe(true));
    expect(await screen.findByText('Kason iPhone')).toBeTruthy();
  });

  it('denies a pending phone', async () => {
    phones = [phone({})];
    render(<PhonePairing />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/mobile/devices/p1' && c.method === 'DELETE')).toBe(true));
  });

  it('revokes an approved phone only after a second click', async () => {
    phones = [phone({ status: 'active', confirmCode: null, lastSeenAt: Date.now() })];
    render(<PhonePairing />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke…' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/mobile/devices/p1' && c.method === 'DELETE')).toBe(true));
  });

  it('shows the server’s reason when pairing is refused (no password)', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/mobile/pairing'
      ? json(409, { error: 'Set a dashboard password first', code: 'PASSWORD_REQUIRED' })
      : json(200, { success: true, data: { devices: [] } }))));
    render(<PhonePairing />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pair a phone' }));
    expect(await screen.findByText('Set a dashboard password first')).toBeTruthy();
  });
});

describe('qrSvg', () => {
  it('encodes a pairing link into a square grid with a quiet zone', () => {
    const qr = qrSvg('https://aasc.work/pair#v=2&name=Mac&p=3333&mc=ABCDEFGHJK');
    expect(qr.size).toBeGreaterThanOrEqual(21 + 8);
    expect((qr.size - 8 - 17) % 4).toBe(0); // QR sizes are 17 + 4·version
    expect(qr.path).toMatch(/^M\d+ \d+h1v1h-1z/);
    // The quiet zone stays light: no module starts in the first 4 rows/columns.
    expect(qr.path).not.toMatch(/M[0-3] /);
  });
});
