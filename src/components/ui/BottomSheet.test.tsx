// BottomSheet.test.tsx — AASC-18: the phone's dialog and destructive-action confirm.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BottomSheet, { ConfirmSheet } from './BottomSheet';

describe('BottomSheet', () => {
  it('renders nothing while closed', () => {
    render(<BottomSheet open={false} onClose={() => {}} title="Actions">body</BottomSheet>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a named dialog on <body> that takes focus', () => {
    const { container } = render(<BottomSheet open onClose={() => {}} title="Actions"><button>First</button></BottomSheet>);
    const dialog = screen.getByRole('dialog', { name: 'Actions' });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(document.activeElement?.textContent).toBe('×');
  });

  it('takes a host class on its panel: portaled to <body>, it is out of reach of the host’s scoped rules otherwise', () => {
    render(<BottomSheet open onClose={() => {}} title="Filters" className="phone-dress">x</BottomSheet>);
    expect(screen.getByRole('dialog', { name: 'Filters' }).className).toContain('phone-dress');
  });

  it('closes on Escape, on the backdrop and on the close button, never on a tap inside', () => {
    const onClose = vi.fn();
    render(<BottomSheet open onClose={onClose} title="Actions"><p>inside</p></BottomSheet>);
    fireEvent.click(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('bottom-sheet-backdrop'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('keeps Tab inside the sheet', () => {
    render(<BottomSheet open onClose={() => {}} title="Actions"><button>Last</button></BottomSheet>);
    screen.getByRole('button', { name: 'Last' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });
});

describe('ConfirmSheet', () => {
  it('confirms or cancels, and blocks a second tap while busy', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmSheet open title="Kill session?" message="The agent stops now." confirmLabel="Kill" danger onConfirm={onConfirm} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(<ConfirmSheet open busy title="Kill session?" message="x" confirmLabel="Kill" onConfirm={onConfirm} onCancel={onCancel} />);
    expect((screen.getByRole('button', { name: 'Working…' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
