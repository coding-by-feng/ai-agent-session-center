import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DictateButton from './DictateButton';
import type { PhoneDictation } from '@/hooks/usePhoneDictation';

function dictation(over: Partial<PhoneDictation> = {}): PhoneDictation {
  return { available: true, phase: 'idle', line: null, start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), dismiss: vi.fn(), ...over };
}

describe('DictateButton', () => {
  it('draws nothing where the app has no recorder', () => {
    const { container } = render(<DictateButton dictation={dictation({ available: false })} className="b" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a press starts and letting go stops, without moving the focus', () => {
    const d = dictation();
    render(<DictateButton dictation={d} className="b" />);
    const button = screen.getByRole('button', { name: 'Hold to dictate' });
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    fireEvent(button, down);
    expect(down.defaultPrevented).toBe(true);
    expect(d.start).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(button);
    expect(d.stop).toHaveBeenCalledTimes(1);
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    fireEvent(button, mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
  });

  it('a cancelled touch or a lost capture also ends the hold', () => {
    const d = dictation({ phase: 'recording' });
    render(<DictateButton dictation={d} className="b" />);
    const button = screen.getByTestId('dictate-button');
    fireEvent.pointerCancel(button);
    fireEvent.lostPointerCapture(button);
    fireEvent.blur(button);
    expect(d.stop).toHaveBeenCalledTimes(3);
  });

  it('a right mouse button does not record, and the long-press menu stays closed', () => {
    const d = dictation();
    render(<DictateButton dictation={d} className="b" />);
    const button = screen.getByTestId('dictate-button');
    fireEvent.pointerDown(button, { pointerType: 'mouse', button: 2 });
    expect(d.start).not.toHaveBeenCalled();
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(button, menu);
    expect(menu.defaultPrevented).toBe(true);
  });

  it('Space held on a keyboard records once, and its release stops', () => {
    const d = dictation();
    render(<DictateButton dictation={d} className="b" />);
    const button = screen.getByTestId('dictate-button');
    fireEvent.keyDown(button, { key: ' ' });
    fireEvent.keyDown(button, { key: ' ', repeat: true });
    fireEvent.keyDown(button, { key: 'a' });
    expect(d.start).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(button, { key: ' ' });
    expect(d.stop).toHaveBeenCalledTimes(1);
  });

  it('says what it is doing', () => {
    const { rerender } = render(<DictateButton dictation={dictation({ phase: 'recording' })} className="b" />);
    const button = screen.getByTestId('dictate-button');
    expect(button).toHaveAccessibleName('Recording: let go to finish');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    rerender(<DictateButton dictation={dictation({ phase: 'transcribing' })} className="b" />);
    expect(button).toHaveAccessibleName('Turning your words into text');
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('the box going off mid-hold drops the recording, and the button still hears the release', () => {
    // A disabled <button> gets no pointerup: left alone, the mic would stay on until the app's own limit.
    const d = dictation({ phase: 'recording' });
    const { rerender } = render(<DictateButton dictation={d} className="b" />);
    expect(d.cancel).not.toHaveBeenCalled();
    rerender(<DictateButton dictation={d} className="b" disabled />);
    expect(d.cancel).toHaveBeenCalledTimes(1);
    const button = screen.getByTestId('dictate-button');
    expect(button).not.toBeDisabled();
    fireEvent.pointerUp(button);
    expect(d.stop).toHaveBeenCalled();
    rerender(<DictateButton dictation={dictation({ phase: 'idle' })} className="b" disabled />);
    expect(screen.getByTestId('dictate-button')).toBeDisabled();
  });

  it('is off while the box is', () => {
    const d = dictation();
    render(<DictateButton dictation={d} className="b" disabled />);
    const button = screen.getByTestId('dictate-button');
    expect(button).toBeDisabled();
    fireEvent.pointerDown(button);
    expect(d.start).not.toHaveBeenCalled();
  });
});
