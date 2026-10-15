// GalleryScreen.test.tsx — More → About → UI kit (AASC-38): every kit component is
// on show, and the samples work (sheets open and close, the confirm runs busy).
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GalleryScreen from './GalleryScreen';

describe('GalleryScreen', () => {
  it('shows every kit component group', () => {
    render(<GalleryScreen />);
    for (const group of ['Buttons', 'Segmented control', 'Chips', 'Status rings', 'Banners', 'Swipe and long press', 'Sheets', 'Empty state']) {
      expect(screen.getByRole('region', { name: group }), group).toBeTruthy();
    }
    expect(screen.getByRole('region', { name: 'List rows' })).toBeTruthy();
    expect(screen.getAllByRole('tablist')).toHaveLength(2);
    const rings = within(screen.getByRole('region', { name: 'Status rings' }));
    for (const words of ['Waiting for approval', 'Has a question', 'Working', 'Finished', 'Idle', 'Ended', 'Interrupted']) {
      expect(rings.getAllByText(words).length, words).toBeGreaterThan(0);
    }
    expect(screen.getByRole('alert')).toHaveTextContent('The Mac refused that');
  });

  it('opens a sheet at its detent and closes it', async () => {
    const user = userEvent.setup();
    render(<GalleryScreen />);
    await user.click(screen.getByRole('button', { name: 'Large sheet' }));
    const sheet = screen.getByRole('dialog', { name: 'Large sheet' });
    expect(sheet).toHaveAttribute('data-detent', 'large');
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('confirms a destructive sample in a sheet', async () => {
    const user = userEvent.setup();
    render(<GalleryScreen />);
    await user.click(screen.getByRole('button', { name: 'Confirm sheet' }));
    const confirm = screen.getByRole('dialog', { name: 'Kill agent-manager-2?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
