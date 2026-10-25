// ImagePreview.test.tsx — the full-size view of an attached image.
//
// The queue compose strip showed 44px thumbnails you couldn't open: a pasted screenshot couldn't
// be checked before it was queued. The preview lives in <body>, so a docked panel or a pop-out
// can't clip it, and every usual way out closes it: Esc, Android Back, the backdrop, ✕.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ImagePreview from './ImagePreview';
import { closeTopBackLayer } from '@/lib/backLayers';

const IMG = { name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' };

function setup() {
  const onClose = vi.fn();
  render(<div data-testid="panel"><ImagePreview src={IMG.dataUrl} name={IMG.name} onClose={onClose} /></div>);
  return { onClose, dialog: screen.getByRole('dialog', { name: 'shot.png' }) };
}

describe('ImagePreview', () => {
  it('shows the image at full size in <body>, outside the panel that opened it', () => {
    const { dialog } = setup();
    expect(screen.getByTestId('panel').contains(dialog)).toBe(false);
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(IMG.dataUrl);
    expect(dialog.textContent).toContain('shot.png');
  });

  it('Esc closes it', () => {
    const { onClose } = setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the backdrop and ✕ close it; a click on the image does not', () => {
    const { onClose, dialog } = setup();
    fireEvent.click(dialog.querySelector('img')!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('image-preview-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Android Back closes the preview, not the screen under it', () => {
    const { onClose } = setup();
    expect(closeTopBackLayer()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
