import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import Modal from './Modal';
import { useUiStore } from '@/stores/uiStore';

// CSS module mock is handled by Vitest's built-in CSS module handling (returns identity proxy)

describe('Modal', () => {
  beforeEach(() => {
    useUiStore.setState({ activeModal: null });
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <Modal modalId="test">
        <p>Content</p>
      </Modal>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders children when open', () => {
    useUiStore.setState({ activeModal: 'test' });
    render(
      <Modal modalId="test">
        <p>Hello Modal</p>
      </Modal>,
    );
    expect(screen.getByText('Hello Modal')).toBeInTheDocument();
  });

  it('renders title when provided', () => {
    useUiStore.setState({ activeModal: 'test' });
    render(
      <Modal modalId="test" title="My Title">
        <p>Content</p>
      </Modal>,
    );
    expect(screen.getByText('My Title')).toBeInTheDocument();
  });

  it('does not render for a different modalId', () => {
    useUiStore.setState({ activeModal: 'other' });
    const { container } = render(
      <Modal modalId="test">
        <p>Content</p>
      </Modal>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('closes on close button click', () => {
    const onClose = vi.fn();
    useUiStore.setState({ activeModal: 'test' });
    render(
      <Modal modalId="test" title="Title" onClose={onClose}>
        <p>Content</p>
      </Modal>,
    );
    fireEvent.click(screen.getByLabelText('Close'));
    expect(useUiStore.getState().activeModal).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape key', () => {
    useUiStore.setState({ activeModal: 'test' });
    render(
      <Modal modalId="test" title="Title">
        <p>Content</p>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useUiStore.getState().activeModal).toBeNull();
  });

  it('closes on overlay click', () => {
    useUiStore.setState({ activeModal: 'test' });
    render(
      <Modal modalId="test" title="Title">
        <p>Content</p>
      </Modal>,
    );
    // The overlay is the outermost div with the dialog inside it
    const overlay = screen.getByRole('dialog').parentElement!;
    fireEvent.click(overlay);
    expect(useUiStore.getState().activeModal).toBeNull();
  });

  it('has role="dialog" with aria-modal', () => {
    useUiStore.setState({ activeModal: 'test' });
    render(
      <Modal modalId="test" title="Dialog Title">
        <p>Content</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Dialog Title');
  });

  // A confirm button that stays disabled until a field is filled in used to be
  // the trap's `last`: focus could never equal it, so Tab walked out of the
  // dialog to the page behind the overlay.
  it('keeps Tab inside when the last button is disabled', () => {
    useUiStore.setState({ activeModal: 'test' });
    render(
      <>
        <button type="button">Outside</button>
        <Modal modalId="test">
          <input aria-label="Name" />
          <button type="button">Cancel</button>
          <button type="button" disabled>Confirm</button>
        </Modal>
      </>,
    );
    screen.getByRole('button', { name: 'Cancel' }).focus();
    const tab = fireEvent.keyDown(document, { key: 'Tab' });
    expect(tab).toBe(false); // default prevented: the trap handled it
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
  });

  it('wraps Shift+Tab from the first control to the last ENABLED one', () => {
    useUiStore.setState({ activeModal: 'test' });
    render(
      <Modal modalId="test">
        <input aria-label="Name" />
        <button type="button">Cancel</button>
        <button type="button" disabled>Confirm</button>
      </Modal>,
    );
    screen.getByRole('textbox', { name: 'Name' }).focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });
});
