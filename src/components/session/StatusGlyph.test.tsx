// StatusGlyph.test.tsx — the per-status icon is shared by the panel's rail and
// the LIVE board. Each status must keep a shape of its own: waiting and
// prompting share a colour, so colour alone cannot tell them apart.
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import StatusGlyph from './StatusGlyph';

const STATUSES = ['working', 'prompting', 'approval', 'input', 'waiting', 'idle', 'connecting', 'ended'];

function markup(status: string): string {
  const { container, unmount } = render(<StatusGlyph status={status} />);
  const html = container.innerHTML;
  unmount();
  return html;
}

describe('StatusGlyph', () => {
  it('draws an icon for every status', () => {
    for (const status of STATUSES) {
      expect(markup(status)).toContain('<svg');
    }
  });

  it('gives every status a different shape', () => {
    const shapes = new Set(STATUSES.map(markup));
    expect(shapes.size).toBe(STATUSES.length);
  });

  it('draws an unknown status like idle rather than nothing', () => {
    expect(markup('mystery')).toBe(markup('idle'));
  });

  it('takes its colour from the surrounding text (currentColor)', () => {
    expect(markup('approval')).toContain('currentColor');
  });

  it('is decorative: the status words carry the meaning for screen readers', () => {
    const { container } = render(<StatusGlyph status="working" />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
