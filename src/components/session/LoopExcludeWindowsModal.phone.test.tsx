/**
 * Session quiet hours on a phone (AASC-20, feature 67): the editor takes the
 * screen like the item editor, each window is two native time pickers, and the
 * stored `HH:MM` format is what comes back out.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import LoopExcludeWindowsModal from './LoopExcludeWindowsModal';

vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => true,
}));

describe('LoopExcludeWindowsModal on a phone', () => {
  it('edits each window with native time pickers and saves HH:MM 24-hour', () => {
    const onSave = vi.fn();
    render(
      <LoopExcludeWindowsModal
        windows={[{ id: 1, startHHMM: '23:00', endHHMM: '07:00' }]}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Session quiet hours' });
    expect(dialog.parentElement?.className).toMatch(/chainModalPhone/);
    const start = screen.getByLabelText('Window start', { selector: 'input' }) as HTMLInputElement;
    const end = screen.getByLabelText('Window end', { selector: 'input' }) as HTMLInputElement;
    expect([start.type, start.value, end.value]).toEqual(['time', '23:00', '07:00']);
    fireEvent.change(start, { target: { value: '22:30' } });
    expect(screen.getByRole('button', { name: 'Delete quiet hours 22:30 to 07:00' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith([{ id: 1, startHHMM: '22:30', endHHMM: '07:00' }]);
  });
});
