// DevicePresenceChip.test.tsx — the two behavior changes from this pass:
//  1. The chip no longer hides at devices.length <= 1 (it used to `return null`
//     there, which was the ONLY thing standing between a solo user and any way
//     to check what's connected or learn their own address for a phone to use).
//  2. Each device row now shows its address, normalized for display —
//     `req.socket.remoteAddress` is frequently an IPv4-mapped IPv6 form
//     (`::ffff:192.168.6.42`) or bare `::1`, neither of which reads as an IP.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DevicePresenceChip from './DevicePresenceChip';
import { usePresenceStore } from '@/stores/presenceStore';
import type { DevicePresence } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({
  getClientId: () => 'me',
}));
vi.mock('@/lib/presenceClient', () => ({
  releaseAllControls: vi.fn().mockResolvedValue({ ok: true, released: [] }),
}));
vi.mock('@/components/ui/ToastContainer', () => ({
  showToast: vi.fn(),
}));

function device(overrides: Partial<DevicePresence>): DevicePresence {
  return {
    clientId: 'me',
    label: 'MacBook Pro',
    address: '::1',
    isLocal: true,
    connections: 1,
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
    ...overrides,
  };
}

function seed(devices: DevicePresence[]): void {
  usePresenceStore.setState({ devices, controllers: new Map() });
}

/** Stubs GET /api/config — every test that opens the panel triggers this
 *  fetch now, so every test needs a response, not just the ones that assert
 *  on it, or jsdom's real (unimplemented) fetch throws / React warns about a
 *  state update outside act(). */
function stubConfigFetch(localIP: string | null = '192.168.6.42') {
  const fetchMock = vi.fn().mockResolvedValue({
    json: async () => ({ localIP }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  seed([]);
  stubConfigFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('DevicePresenceChip — visible at any device count', () => {
  it('renders with exactly one device (the solo case this pass fixes)', () => {
    seed([device({ clientId: 'me', label: 'MacBook Pro' })]);
    render(<DevicePresenceChip />);
    // Previously this returned null entirely — nothing to query for. The
    // button's accessible name comes from its text content (🖥 + count), not
    // `title`, so that's what a real query has to match; `.title` is checked
    // separately below.
    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders with zero devices (before presence has registered)', () => {
    seed([]);
    render(<DevicePresenceChip />);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('renders with two devices, as before', () => {
    seed([
      device({ clientId: 'me', label: 'MacBook Pro' }),
      device({ clientId: 'phone', label: "Kason's iPhone", address: '192.168.6.42', isLocal: false }),
    ]);
    render(<DevicePresenceChip />);
    expect(screen.getByRole('button').title).toBe('2 devices connected');
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});

describe('DevicePresenceChip — address display', () => {
  // Opening the panel now also triggers the /api/config fetch (network URL
  // section) — awaiting its resolution via waitFor is what keeps that state
  // update inside React's act() scope; a bare synchronous assertion after
  // fireEvent.click would warn even though these tests don't care about that
  // fetch's result.
  it('shows a remote LAN address unchanged', async () => {
    seed([
      device({ clientId: 'me' }),
      device({ clientId: 'phone', label: "Kason's iPhone", address: '192.168.6.42', isLocal: false }),
    ]);
    render(<DevicePresenceChip />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText('192.168.6.42')).toBeInTheDocument());
  });

  it('strips the IPv4-mapped IPv6 prefix', async () => {
    seed([device({ clientId: 'me', address: '::ffff:127.0.0.1' })]);
    render(<DevicePresenceChip />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText('127.0.0.1')).toBeInTheDocument());
    expect(screen.queryByText('::ffff:127.0.0.1')).not.toBeInTheDocument();
  });

  it('shows bare ::1 loopback as 127.0.0.1', async () => {
    seed([device({ clientId: 'me', address: '::1' })]);
    render(<DevicePresenceChip />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText('127.0.0.1')).toBeInTheDocument());
  });

  it('shows a placeholder rather than a blank line when the address is empty', async () => {
    seed([device({ clientId: 'me', address: '' })]);
    render(<DevicePresenceChip />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText('—')).toBeInTheDocument());
  });
});

describe('DevicePresenceChip — title pluralization', () => {
  it('is singular at exactly one device', () => {
    seed([device({ clientId: 'me' })]);
    render(<DevicePresenceChip />);
    expect(screen.getByRole('button').title).toBe('1 device connected');
  });

  it('is plural at zero and at two+', () => {
    seed([]);
    const { unmount } = render(<DevicePresenceChip />);
    expect(screen.getByRole('button').title).toBe('0 devices connected');
    unmount();

    seed([device({ clientId: 'a' }), device({ clientId: 'b' })]);
    render(<DevicePresenceChip />);
    expect(screen.getByRole('button').title).toBe('2 devices connected');
  });
});

describe('DevicePresenceChip — network URL for phone usage', () => {
  it('fetches /api/config only once the panel is opened, not on mount', async () => {
    const fetchMock = stubConfigFetch();
    seed([device({ clientId: 'me' })]);
    render(<DevicePresenceChip />);

    // Mounted (always-visible chip, per the Aug 2026 change), but not opened.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button'));
    expect(fetchMock).toHaveBeenCalledWith('/api/config', expect.anything());
    // Let the resulting state update land inside act()'s scope before this
    // test returns — its own assertions don't need the resolved value, but
    // leaving the promise dangling past the test boundary is what warns.
    await waitFor(() => expect(screen.getByText(/^http:\/\//)).toBeInTheDocument());
  });

  it('shows the LAN URL, combining the fetched IP with the page\'s own port', async () => {
    stubConfigFetch('192.168.6.42');
    seed([device({ clientId: 'me' })]);
    render(<DevicePresenceChip />);
    fireEvent.click(screen.getByRole('button'));

    // window.location.port (not the config file's nominal port) is what this
    // page actually loaded from — see the component's own docblock for why
    // that matters (a port-conflict retry can make the two diverge).
    await waitFor(() => {
      expect(screen.getByText(/^http:\/\/192\.168\.6\.42:/)).toBeInTheDocument();
    });
  });

  it('shows nothing when this machine has no reachable LAN interface', async () => {
    stubConfigFetch(null);
    seed([device({ clientId: 'me' })]);
    render(<DevicePresenceChip />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(screen.getByText('Connected devices')).toBeInTheDocument());
    expect(screen.queryByText(/^http:\/\//)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Copy address')).not.toBeInTheDocument();
  });

  it('does not refetch on close + reopen — the value is cached', async () => {
    const fetchMock = stubConfigFetch();
    seed([device({ clientId: 'me' })]);
    render(<DevicePresenceChip />);
    // Grabbed once, while it's still the ONLY button — once the panel opens,
    // its own "Copy address" button also matches role "button", so a repeat
    // screen.getByRole('button') becomes ambiguous.
    const trigger = screen.getByRole('button');

    fireEvent.click(trigger); // open
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(trigger); // close
    fireEvent.click(trigger); // reopen

    await waitFor(() => {
      expect(screen.getByText(/^http:\/\/192\.168\.6\.42:/)).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('copying writes the URL to the clipboard', async () => {
    stubConfigFetch('192.168.6.42');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    seed([device({ clientId: 'me' })]);
    render(<DevicePresenceChip />);
    fireEvent.click(screen.getByRole('button'));

    const copyBtn = await waitFor(() => screen.getByLabelText('Copy address'));
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/192\.168\.6\.42:/));
    });
  });
});
