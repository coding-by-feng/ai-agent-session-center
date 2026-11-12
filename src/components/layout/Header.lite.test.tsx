// Header.lite.test.tsx — the app header in the Lite build: its own name, no memory chip, no workspace export/import.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
  APP_DISPLAY_NAME: 'AI Agent Session Center Lite',
}));
vi.mock('./MemoryChip', () => ({ default: () => <div data-testid="memory-chip" /> }));
vi.mock('./DevicePresenceChip', () => ({ default: () => <div data-testid="devices-chip" /> }));

import Header from './Header';

describe('Header in the Lite build', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })));
  afterEach(() => vi.unstubAllGlobals());

  it('says which edition this is', () => {
    render(<Header />);
    expect(screen.getByText('AI AGENT SESSION CENTER LITE')).toBeInTheDocument();
  });

  it('hides the memory chip and workspace export/import', () => {
    render(<Header />);
    expect(screen.queryByTestId('memory-chip')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Export workspace')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Import workspace')).not.toBeInTheDocument();
  });

  it('keeps the devices chip, which holds phone pairing and the password setting', () => {
    render(<Header />);
    expect(screen.getByTestId('devices-chip')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });
});
