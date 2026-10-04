import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import QueueItemText from './QueueItemText';
import { installClipHarness, CHAR_PX } from '@/__tests__/clipHarness';
import { useSettingsStore } from '@/stores/settingsStore';

// 200px wide → a text longer than 25 characters is clipped (see clipHarness).
const SHORT = 'run the tests';
const LONG = 'Okay, so as we can see that um, we have a testing real Android form named Kason test.';
const SHOW = /show full prompt/i;
const HIDE = /collapse prompt/i;

let harness: ReturnType<typeof installClipHarness>;
beforeEach(() => { harness = installClipHarness(200); });
afterEach(() => { harness.restore(); });

describe('QueueItemText', () => {
  it('shows the prompt, and no toggle while the text fits', async () => {
    render(<QueueItemText text={SHORT} expanded={false} onToggle={() => undefined} />);
    expect(screen.getByText(SHORT)).toBeInTheDocument();
    await harness.fireResize();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers to expand a prompt that is cut off', async () => {
    render(<QueueItemText text={LONG} expanded={false} onToggle={() => undefined} />);
    const toggle = await screen.findByRole('button', { name: SHOW });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(LONG)).toHaveAttribute('data-expanded', 'false');
  });

  it('asks its owner to toggle, once per click, without letting the click reach the row', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <QueueItemText text={LONG} expanded={false} onToggle={onToggle} />
      </div>,
    );
    await user.click(await screen.findByRole('button', { name: SHOW }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('can be driven from the keyboard', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<QueueItemText text={LONG} expanded={false} onToggle={onToggle} />);
    const toggle = await screen.findByRole('button', { name: SHOW });
    toggle.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('when expanded: marks the text, flips the label, and keeps the toggle even though nothing is cut off any more', async () => {
    harness.setClientWidth(LONG.length * CHAR_PX + 100); // wide enough that the text is NOT clipped
    render(<QueueItemText text={LONG} expanded onToggle={() => undefined} />);
    const toggle = await screen.findByRole('button', { name: HIDE });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(LONG)).toHaveAttribute('data-expanded', 'true');
    await harness.fireResize();
    expect(screen.getByRole('button', { name: HIDE })).toBeInTheDocument();
  });

  it('re-measures when it is folded again: a prompt opened already-expanded must get its toggle back', async () => {
    // Expanded, nothing is cut off, so the measurement says "fits"; once folded the same
    // text IS cut off, and the toggle has to still be there to open it again.
    const { rerender } = render(<QueueItemText text={LONG} expanded onToggle={() => undefined} />);
    expect(await screen.findByRole('button', { name: HIDE })).toBeInTheDocument();
    rerender(<QueueItemText text={LONG} expanded={false} onToggle={() => undefined} />);
    expect(await screen.findByRole('button', { name: SHOW })).toBeInTheDocument();
  });

  it('puts the expanded styling on the text, and takes it off again', async () => {
    const { rerender } = render(<QueueItemText text={LONG} expanded={false} onToggle={() => undefined} />);
    await screen.findByRole('button', { name: SHOW });
    expect(screen.getByText(LONG).className).not.toMatch(/queueTextExpanded/);
    rerender(<QueueItemText text={LONG} expanded onToggle={() => undefined} />);
    expect(screen.getByText(LONG).className).toMatch(/queueTextExpanded/);
  });

  it('is a plain button: it cannot submit a form it happens to sit in', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <QueueItemText text={LONG} expanded={false} onToggle={() => undefined} />
      </form>,
    );
    await user.click(await screen.findByRole('button', { name: SHOW }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('follows the panel being resized: the toggle appears when the text gets cut off and goes when it fits again', async () => {
    harness.setClientWidth(LONG.length * CHAR_PX + 100);
    render(<QueueItemText text={LONG} expanded={false} onToggle={() => undefined} />);
    await harness.fireResize();
    expect(screen.queryByRole('button')).toBeNull();

    harness.setClientWidth(120);
    await harness.fireResize();
    expect(await screen.findByRole('button', { name: SHOW })).toBeInTheDocument();

    harness.setClientWidth(LONG.length * CHAR_PX + 100);
    await harness.fireResize();
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });

  it('re-measures when the prompt itself changes', async () => {
    const { rerender } = render(<QueueItemText text={SHORT} expanded={false} onToggle={() => undefined} />);
    await harness.fireResize();
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<QueueItemText text={LONG} expanded={false} onToggle={() => undefined} />);
    expect(await screen.findByRole('button', { name: SHOW })).toBeInTheDocument();
    rerender(<QueueItemText text={SHORT} expanded={false} onToggle={() => undefined} />);
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });

  it('stops observing when it unmounts', async () => {
    const { unmount } = render(<QueueItemText text={LONG} expanded={false} onToggle={() => undefined} />);
    await screen.findByRole('button', { name: SHOW });
    expect(harness.liveObservers()).toBe(1);
    unmount();
    expect(harness.liveObservers()).toBe(0);
  });

  it('copes with an environment that has no ResizeObserver: the prompt shows, there is just no toggle', () => {
    harness.restore();
    vi.stubGlobal('ResizeObserver', undefined);
    try {
      render(<QueueItemText text={LONG} expanded={false} onToggle={() => undefined} />);
      expect(screen.getByText(LONG)).toBeInTheDocument();
      expect(screen.queryByRole('button')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the prompt out of the accessible name of the toggle (a screen reader should not read it twice)', async () => {
    render(<QueueItemText text={LONG} expanded={false} onToggle={() => undefined} />);
    const toggle = await screen.findByRole('button', { name: SHOW });
    expect(toggle.getAttribute('aria-label')).not.toContain('Kason');
  });
});

/**
 * What the real ResizeObserver does that a synchronous stand-in hides: it reports AFTER layout, in a later
 * task. A reading taken while the prompt is expanded says "fits", and the first report after a fold has not
 * arrived yet — so for a moment the toggle had no reason to exist, was removed, and came back as a NEW node.
 * Keyboard focus dropped to <body> in between, every fold.
 */
describe('QueueItemText — folding keeps the toggle', () => {
  const noop = () => undefined;

  beforeEach(() => {
    harness.restore();
    harness = installClipHarness(200, { deferred: true });
  });

  it('is the same button through expand and fold, even before the observer has reported again', async () => {
    const { rerender } = render(<QueueItemText text={LONG} expanded={false} onToggle={noop} />);
    await harness.deliver(); // cut off → the toggle
    const toggle = screen.getByRole('button', { name: SHOW });

    rerender(<QueueItemText text={LONG} expanded onToggle={noop} />);
    await harness.deliver(); // a reading taken while expanded: "fits"
    expect(screen.getByRole('button', { name: HIDE })).toBe(toggle);

    rerender(<QueueItemText text={LONG} expanded={false} onToggle={noop} />);
    // Folded; the observer has not reported. The toggle must not have gone in the meantime.
    expect(screen.getByRole('button', { name: SHOW })).toBe(toggle);
    await harness.deliver();
    expect(screen.getByRole('button', { name: SHOW })).toBe(toggle);
  });

  it('keeps focus on it across the fold', async () => {
    const { rerender } = render(<QueueItemText text={LONG} expanded={false} onToggle={noop} />);
    await harness.deliver();
    const toggle = screen.getByRole('button', { name: SHOW });
    toggle.focus();
    rerender(<QueueItemText text={LONG} expanded onToggle={noop} />);
    await harness.deliver();
    rerender(<QueueItemText text={LONG} expanded={false} onToggle={noop} />);
    expect(document.activeElement).toBe(toggle);
  });

  it('does not hold a reading taken while expanded: folded again, a wider panel still removes the toggle', async () => {
    const { rerender } = render(<QueueItemText text={LONG} expanded={false} onToggle={noop} />);
    await harness.deliver();
    expect(screen.getByRole('button', { name: SHOW })).toBeInTheDocument();
    rerender(<QueueItemText text={LONG} expanded onToggle={noop} />);
    await harness.deliver();
    harness.setClientWidth(LONG.length * CHAR_PX + 100); // the panel was widened while it was open
    rerender(<QueueItemText text={LONG} expanded={false} onToggle={noop} />);
    await harness.deliver();
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });

  it('keeps a FOCUSED toggle even when nothing is cut off, and lets it go on blur', async () => {
    harness.setClientWidth(LONG.length * CHAR_PX + 100); // wide: the text fits when folded
    const { rerender } = render(<QueueItemText text={LONG} expanded onToggle={noop} />); // mounted expanded
    await harness.deliver();
    const toggle = screen.getByRole('button', { name: HIDE });
    toggle.focus();
    rerender(<QueueItemText text={LONG} expanded={false} onToggle={noop} />);
    await harness.deliver();
    expect(document.activeElement).toBe(toggle);
    expect(screen.getByRole('button', { name: SHOW })).toBe(toggle);
    act(() => toggle.blur());
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });
});

describe('QueueItemText — a font change is not a resize', () => {
  it('re-measures when the theme changes, because a theme swaps the font and the box may not move', async () => {
    harness.setClientWidth(LONG.length * CHAR_PX + 100); // fits
    render(<QueueItemText text={LONG} expanded={false} onToggle={() => undefined} />);
    expect(screen.queryByRole('button')).toBeNull();
    harness.setClientWidth(100); // the same box, but the new font's glyphs are wider than it can hold
    act(() => useSettingsStore.setState({ themeName: 'monokai' }));
    expect(await screen.findByRole('button', { name: SHOW })).toBeInTheDocument();
    act(() => useSettingsStore.setState({ themeName: 'windows-xp' }));
  });
});

/**
 * `scrollWidth` and `clientWidth` are rounded to whole pixels on their own, so a text that overflows by a sliver
 * can read "equal" while the ellipsis still hides characters. The hook also reads the unrounded widths (a Range
 * over the text, the element's own rect); the harness has none until `setSliver()` provides them.
 */
describe('QueueItemText — a sliver of overflow', () => {
  // 25 characters × 8px = 200px in a 200px box: scrollWidth === clientWidth, so whole pixels say "fits".
  const FITS_BY_WHOLE_PIXELS = 'x'.repeat(25);

  it('gets its toggle although the whole-pixel metrics round the overflow away', async () => {
    harness.setSliver(0.41); // the text is really 200.41px in a 200px box — an ellipsis is showing
    render(<QueueItemText text={FITS_BY_WHOLE_PIXELS} expanded={false} onToggle={() => undefined} />);
    expect(await screen.findByRole('button', { name: SHOW })).toBeInTheDocument();
  });

  it('does not, when the unrounded widths agree it fits', async () => {
    harness.setSliver(0);
    render(<QueueItemText text={FITS_BY_WHOLE_PIXELS} expanded={false} onToggle={() => undefined} />);
    await harness.fireResize();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not, for layout noise below the tolerance', async () => {
    harness.setSliver(0.05);
    render(<QueueItemText text={FITS_BY_WHOLE_PIXELS} expanded={false} onToggle={() => undefined} />);
    await harness.fireResize();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is not consulted for an element with no layout (a box width of 0)', async () => {
    harness.setClientWidth(0);
    harness.setSliver(0.41);
    render(<QueueItemText text="" expanded={false} onToggle={() => undefined} />);
    await harness.fireResize();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
