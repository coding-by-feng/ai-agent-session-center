import { describe, it, expect } from 'vitest';
import { isPasteKey, readPasteData, stripTrailingNewlines } from './terminalPaste';

const transfer = (text: string, items: Array<{ kind: string; type: string; file?: File | null }> = []) =>
  ({
    items: items.map((i) => ({ kind: i.kind, type: i.type, getAsFile: () => i.file ?? null })),
    getData: (type: string) => (type === 'text/plain' ? text : ''),
  }) as unknown as DataTransfer;

describe('readPasteData', () => {
  it('reads the text and only image files', () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const out = readPasteData(transfer('hello', [
      { kind: 'file', type: 'image/png', file: png },
      { kind: 'file', type: 'application/pdf', file: pdf },
      { kind: 'string', type: 'text/html' },
      { kind: 'file', type: 'image/jpeg', file: null },
    ]));
    expect(out).toEqual({ text: 'hello', images: [png] });
  });

  it('is empty with no clipboard data', () => {
    expect(readPasteData(null)).toEqual({ text: '', images: [] });
  });
});

describe('stripTrailingNewlines', () => {
  it('drops only trailing line breaks', () => {
    expect(stripTrailingNewlines('code\r\n\n')).toBe('code');
    expect(stripTrailingNewlines('a\nb')).toBe('a\nb');
    expect(stripTrailingNewlines('\n')).toBe('');
  });
});

describe('isPasteKey', () => {
  const k = (over: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) =>
    ({ key: 'v', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over });

  it('is ⌘V on macOS and Ctrl+V elsewhere, Caps Lock too', () => {
    expect(isPasteKey(k({ metaKey: true }), true)).toBe(true);
    expect(isPasteKey(k({ metaKey: true, key: 'V' }), true)).toBe(true);
    expect(isPasteKey(k({ ctrlKey: true }), false)).toBe(true);
    expect(isPasteKey(k({ ctrlKey: true, key: 'V' }), false)).toBe(true);
  });

  it('leaves Ctrl+V on macOS (^V), ⌘V elsewhere, and Shift/Alt chords alone', () => {
    expect(isPasteKey(k({ ctrlKey: true }), true)).toBe(false);
    expect(isPasteKey(k({ metaKey: true }), false)).toBe(false);
    expect(isPasteKey(k({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isPasteKey(k({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isPasteKey(k({ metaKey: true, key: 'c' }), true)).toBe(false);
  });
});
