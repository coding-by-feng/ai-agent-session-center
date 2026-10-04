import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';

import Tooltip from './Tooltip';

/**
 * Only the `content` prop is covered here: a small React body (rows, a bar)
 * under the label, for a tooltip with more to say than a sentence. It is added
 * to the same measured box, so the viewport flip / clamp applies to it unchanged.
 */
describe('Tooltip — rich content', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const open = () => {
    act(() => {
      screen.getByRole('button', { name: 'trigger' }).focus();
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    return screen.getByRole('tooltip');
  };

  it('shows the content under the label when the trigger is focused', () => {
    render(
      <Tooltip label="Usage" content={<ul><li>5-hour 63%</li></ul>}>
        <button>trigger</button>
      </Tooltip>,
    );
    const tip = open();
    expect(within(tip).getByText('Usage')).toBeTruthy();
    const body = within(tip).getByText('5-hour 63%');
    expect(body).toBeTruthy();
    // label first, then the body
    expect(tip.textContent?.indexOf('Usage')).toBeLessThan(tip.textContent?.indexOf('5-hour 63%') ?? -1);
  });

  it('draws nothing extra when no content is given', () => {
    render(
      <Tooltip label="Usage" description="A sentence.">
        <button>trigger</button>
      </Tooltip>,
    );
    expect(open().textContent).toBe('UsageA sentence.');
  });

  it('keeps the content up to date while the tooltip is open', () => {
    const { rerender } = render(
      <Tooltip label="Usage" content={<p>63%</p>}>
        <button>trigger</button>
      </Tooltip>,
    );
    const tip = open();
    expect(within(tip).getByText('63%')).toBeTruthy();
    rerender(
      <Tooltip label="Usage" content={<p>71%</p>}>
        <button>trigger</button>
      </Tooltip>,
    );
    expect(within(screen.getByRole('tooltip')).getByText('71%')).toBeTruthy();
  });
});
