// useTextClipped.test.tsx — content that grows inside the same box is measured again (Oct 26 2026):
// a queue prompt's skill tokens are drawn after the command list arrives, and are wider than the words.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { installClipHarness } from '@/__tests__/clipHarness';
import { useTextClipped } from './useTextClipped';

function Probe({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [extra, setExtra] = useState('');
  const clipped = useTextClipped(ref, text);
  return (
    <>
      <span ref={ref}>{text}{extra}</span>
      <button type="button" onClick={() => setExtra(' /retouch-ascii-review')}>grow</button>
      <output>{clipped ? 'clipped' : 'fits'}</output>
    </>
  );
}

describe('useTextClipped', () => {
  let harness: ReturnType<typeof installClipHarness>;
  beforeEach(() => { harness = installClipHarness(200); });
  afterEach(() => harness.restore());

  it('notices text that grows past its box without the box resizing', async () => {
    render(<Probe text="add pause device" />);
    expect(screen.getByRole('status').textContent).toBe('fits');
    act(() => screen.getByRole('button').click());
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('clipped'));
  });
});
