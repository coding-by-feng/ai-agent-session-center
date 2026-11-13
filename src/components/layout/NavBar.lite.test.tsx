// NavBar.lite.test.tsx — the Lite desktop build shows LIVE and HISTORY only (lib/edition.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));
vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'me', getClientLabel: () => 'Test Device' }));

import NavBar from './NavBar';
import { usePresenceStore } from '@/stores/presenceStore';

describe('NavBar in the Lite build', () => {
  beforeEach(() => {
    usePresenceStore.setState({ devices: [{ clientId: 'me', isLocal: true }] } as never);
  });

  it('shows LIVE and HISTORY, even on the machine that could open the rest', () => {
    render(<MemoryRouter><NavBar /></MemoryRouter>);
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['LIVE', 'HISTORY']);
  });

  it('shows LIVE only to a remote Lite Client, which the host refuses history', () => {
    usePresenceStore.setState({ devices: [{ clientId: 'me', isLocal: false }] } as never);
    render(<MemoryRouter><NavBar /></MemoryRouter>);
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['LIVE']);
  });
});
