// PhonePairing.test.tsx — AASC-15: the desktop half of pairing a phone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PhonePairing from './PhonePairing';
import type { PairedPhone } from '@/lib/mobilePairingApi';
import { qrSvg } from '@/lib/qrSvg';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

let phones: PairedPhone[] = [];
let offered = true;
let calls: Array<{ url: string; method: string }> = [];
/** What GET /api/mobile/cloud-phones answers (AASC-52), and what removing them leaves. */
let cloudPhones: { cloud: boolean; unlinked?: number };
let removal: { removed: number; failed: number };

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
  offered = true;
  calls = [];
  cloudPhones = { cloud: true, unlinked: 0 };
  removal = { removed: 0, failed: 0 };
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (url === '/api/mobile/devices') return json(200, { success: true, data: { devices: phones, pairingOffered: offered } });
    if (url === '/api/mobile/cloud-phones') return json(200, { success: true, data: cloudPhones });
    if (url === '/api/mobile/cloud-phones/remove-unlinked' && method === 'POST') {
      cloudPhones = { cloud: true, unlinked: removal.failed };
      return json(200, { success: true, data: removal });
    }
    if (url === '/api/mobile/pairing') {
      return json(200, {
        success: true,
        data: { code: 'ABCDEFGHJK', expiresAt: Date.now() + 120_000, link: 'https://aasc.work/pair#v=2&mc=ABCDEFGHJK' },
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
    // AASC-52: the QR never carries a backend code, so there is no "pair again for notifications" note.
    expect(screen.queryByText(/Notifications need the AASC backend/)).toBeNull();
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

  it('says what an approved phone may do here (AASC-28)', async () => {
    phones = [phone({ label: 'Work phone', status: 'active', confirmCode: null, lastSeenAt: Date.now(), access: 'sessions-only' })];
    render(<PhonePairing />);
    expect(await screen.findByText(/^iPhone · shared sessions only · last seen/)).toBeTruthy();
    expect(screen.getByText(/can’t run other commands, change files or change this Mac’s settings/)).toBeTruthy();
  });

  // The name line already said "iPhone 13"; a meta line starting "iPhone ·"
  // under it repeated the word on every row.
  it('does not repeat the platform when the phone’s name already says it', async () => {
    phones = [
      phone({ id: 'p1', label: 'iPhone 13', status: 'active', confirmCode: null, lastSeenAt: Date.now() }),
      phone({ id: 'p2', label: 'Kason’s iPad', status: 'active', confirmCode: null, lastSeenAt: Date.now() }),
      phone({ id: 'p3', label: 'Pixel', platform: 'android', status: 'active', confirmCode: null, lastSeenAt: Date.now() }),
    ];
    render(<PhonePairing />);
    await screen.findByText('iPhone 13');
    const metas = screen.getAllByText(/shared sessions only · last seen/).map((el) => el.textContent);
    expect(metas).toEqual([
      'shared sessions only · last seen just now',
      'shared sessions only · last seen just now',
      'Android · shared sessions only · last seen just now',
    ]);
  });

  it('asks "Allow iPhone 13?" without a repeated "(iPhone)"', async () => {
    phones = [phone({ label: 'iPhone 13' }), phone({ id: 'p2', label: 'Work phone' })];
    render(<PhonePairing />);
    const asks = (await screen.findAllByText(/^Allow .*\?$/)).map((el) => el.textContent);
    expect(asks).toEqual(['Allow iPhone 13?', 'Allow Work phone (iPhone)?']);
  });

  it('shows the server’s reason when pairing is refused (no password)', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/mobile/pairing'
      ? json(409, { error: 'Set a dashboard password first', code: 'PASSWORD_REQUIRED' })
      : json(200, { success: true, data: { devices: [], pairingOffered: true } }))));
    render(<PhonePairing />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pair a phone' }));
    expect(await screen.findByText('Set a dashboard password first')).toBeTruthy();
  });

  it('before the phone app ships: nothing about phones when none are paired (AASC-30)', async () => {
    offered = false;
    const { container } = render(<PhonePairing />);
    await waitFor(() => expect(calls.some((c) => c.url === '/api/mobile/devices')).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('button', { name: 'Pair a phone' })).toBeNull();
  });

  it('before the phone app ships: phones paired before still list and can be revoked, with no Pair button', async () => {
    offered = false;
    phones = [phone({ status: 'active', confirmCode: null })];
    render(<PhonePairing />);
    expect(await screen.findByText('Kason iPhone')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pair a phone' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('a server that doesn’t say counts as not offered: no Pair button while unsure', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/mobile/devices'
      ? json(200, { success: true, data: { devices: [] } })
      : json(404, { error: 'Not found' }))));
    render(<PhonePairing />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('button', { name: 'Pair a phone' })).toBeNull();
  });
});

describe('cloud phone devices not linked to a paired phone (AASC-52)', () => {
  const active = () => phone({ status: 'active', confirmCode: null, lastSeenAt: Date.now() });

  it('says how many, and removes them only after a second click', async () => {
    phones = [active()];
    cloudPhones = { cloud: true, unlinked: 2 };
    removal = { removed: 2, failed: 0 };
    render(<PhonePairing />);
    expect(await screen.findByText('2 cloud phone devices aren’t linked to a paired phone.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove them' }));
    expect(calls.some((c) => c.url === '/api/mobile/cloud-phones/remove-unlinked')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove them' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 2' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/mobile/cloud-phones/remove-unlinked' && c.method === 'POST')).toBe(true));
    await waitFor(() => expect(screen.queryByText(/aren’t linked to a paired phone/)).toBeNull());
    expect(screen.getByText('Kason iPhone')).toBeTruthy(); // the paired phone stays
  });

  it('says it in the singular, and what couldn’t be removed', async () => {
    phones = [active()];
    cloudPhones = { cloud: true, unlinked: 1 };
    removal = { removed: 0, failed: 1 };
    render(<PhonePairing />);
    expect(await screen.findByText('1 cloud phone device isn’t linked to a paired phone.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove them' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 1' }));
    expect(await screen.findByText('1 couldn’t be removed. Try again later.')).toBeTruthy();
  });

  it('shows nothing when there are none, or no cloud connection', async () => {
    phones = [active()];
    render(<PhonePairing />);
    await screen.findByText('Kason iPhone');
    await waitFor(() => expect(calls.some((c) => c.url === '/api/mobile/cloud-phones')).toBe(true));
    expect(screen.queryByText(/linked to a paired phone/)).toBeNull();
    cleanupAndRender({ cloud: false });
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/mobile/cloud-phones')).toHaveLength(2));
    expect(screen.queryByText(/linked to a paired phone/)).toBeNull();
  });

  it('asks the cloud once when the panel opens, not on every 2-second refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      phones = [active()];
      render(<PhonePairing />);
      await screen.findByText('Kason iPhone');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls.filter((c) => c.url === '/api/mobile/devices').length).toBeGreaterThan(3);
      expect(calls.filter((c) => c.url === '/api/mobile/cloud-phones')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the line even with no phone paired and pairing not offered: they are leftovers', async () => {
    offered = false;
    cloudPhones = { cloud: true, unlinked: 3 };
    render(<PhonePairing />);
    expect(await screen.findByText('3 cloud phone devices aren’t linked to a paired phone.')).toBeTruthy();
  });
});

function cleanupAndRender(next: { cloud: boolean; unlinked?: number }) {
  document.body.replaceChildren();
  cloudPhones = next;
  render(<PhonePairing />);
}

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

describe('loadPhonePairing', () => {
  it('reads an answer without a device list as no phones, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(200, { ok: true, success: true, data: [] })));
    const { loadPhonePairing } = await import('@/lib/mobilePairingApi');
    await expect(loadPhonePairing()).resolves.toEqual({ devices: [], pairingOffered: false });
  });
});
