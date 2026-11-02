// SceneOverlay.lite.test.tsx — the LIVE HUD in the Lite build: it has no 3D scene to switch on.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));
vi.mock('@/lib/soundEngine', () => ({ soundEngine: { unlock: vi.fn() } }));

import SceneOverlay from './SceneOverlay';

describe('SceneOverlay in the Lite build', () => {
  it('keeps the sound toggle and the count, without the 3D toggle', () => {
    render(<SceneOverlay sessionCount={2} />);
    expect(screen.getByRole('button', { name: 'Sound' })).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '3D scene' })).not.toBeInTheDocument();
  });
});
