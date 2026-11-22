import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DictateButton from './DictateButton';
import type { PhoneDictation } from '@/hooks/usePhoneDictation';

function dictation(over: Partial<PhoneDictation> = {}): PhoneDictation {
  return { available: true, phase: 'idle', line: null, start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), dismiss: vi.fn(), ...over };
}

describe('DictateButton (tap to start, tap to finish — Nov 22 2026)', () => {
  it('draws nothing where the app has no recorder', () => {
    const { container } = render(<DictateButton dictation={dictation({ available: false })} className="b" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a tap starts, without moving the focus, and lifting the finger does not stop it', () => {
    const d = dictation();
    render(<DictateButton dictation={d} className="b" />);
    const button = screen.getByRole('button', { name: 'Tap to dictate' });
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    fireEvent(button, down);
    expect(down.defaultPrevented).toBe(true);
    expect(d.start).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(button);
    fireEvent.pointerCancel(button);
    fireEvent.lostPointerCapture(button);
    fireEvent.blur(button);
    expect(d.stop).not.toHaveBeenCalled();
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    fireEvent(button, mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
  });

  it('a tap while recording finishes it', () => {
    const d = dictation({ phase: 'recording' });
    render(<DictateButton dictation={d} className="b" />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Recording: tap to finish' }));
    expect(d.stop).toHaveBeenCalledTimes(1);
    expect(d.start).not.toHaveBeenCalled();
  });

  it('a tap while the words are being turned into text does nothing', () => {
    const d = dictation({ phase: 'transcribing' });
    render(<DictateButton dictation={d} className="b" />);
    fireEvent.pointerDown(screen.getByTestId('dictate-button'));
    expect(d.start).not.toHaveBeenCalled();
    expect(d.stop).not.toHaveBeenCalled();
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

  it('Space or Enter on a keyboard toggles once per press', () => {
    const d = dictation();
    const { rerender } = render(<DictateButton dictation={d} className="b" />);
    const button = screen.getByTestId('dictate-button');
    fireEvent.keyDown(button, { key: ' ' });
    fireEvent.keyDown(button, { key: ' ', repeat: true });
    fireEvent.keyDown(button, { key: 'a' });
    fireEvent.keyUp(button, { key: ' ' });
    expect(d.start).toHaveBeenCalledTimes(1);
    expect(d.stop).not.toHaveBeenCalled();
    const rec = dictation({ phase: 'recording' });
    rerender(<DictateButton dictation={rec} className="b" />);
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(rec.stop).toHaveBeenCalledTimes(1);
  });

  it('says what it is doing', () => {
    const { rerender } = render(<DictateButton dictation={dictation({ phase: 'recording' })} className="b" />);
    const button = screen.getByTestId('dictate-button');
    expect(button).toHaveAccessibleName('Recording: tap to finish');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    rerender(<DictateButton dictation={dictation({ phase: 'transcribing' })} className="b" />);
    expect(button).toHaveAccessibleName('Turning your words into text');
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('the box going off mid-recording drops it, and the button still takes the finishing tap', () => {
    // A disabled <button> hears no tap: left alone, the mic would stay on until the app's own limit.
    const d = dictation({ phase: 'recording' });
    const { rerender } = render(<DictateButton dictation={d} className="b" />);
    expect(d.cancel).not.toHaveBeenCalled();
    rerender(<DictateButton dictation={d} className="b" disabled />);
    expect(d.cancel).toHaveBeenCalledTimes(1);
    const button = screen.getByTestId('dictate-button');
    expect(button).not.toBeDisabled();
    fireEvent.pointerDown(button);
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
