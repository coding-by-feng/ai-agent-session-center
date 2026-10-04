import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';

import PlanUsageChip from './PlanUsageChip';
import type { PlanUsage, PlanUsageWindow, Session } from '@/types';

const NOW = Date.UTC(2026, 9, 3, 13, 8, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const win = (minutes: number, usedPercent: number, resetsAt: number | null = NOW + 72 * MIN): PlanUsageWindow => ({
  minutes,
  usedPercent,
  resetsAt,
});
const usage = (windows: PlanUsageWindow[], over: Partial<PlanUsage> = {}): PlanUsage => ({
  cli: 'claude',
  windows,
  asOf: NOW - MIN,
  ...over,
});
const makeSession = (over: Partial<Session> = {}): Session =>
  ({
    sessionId: 's1',
    title: 'Queue float',
    projectName: 'agent-manager',
    projectPath: '/Users/me/agent-manager',
    status: 'idle',
    cliSource: 'claude',
    model: 'claude-opus-5-5',
    ...over,
  }) as Session;

const chip = () => document.querySelector('[class*="planUsageChip"]') as HTMLElement;
const showTooltip = () => {
  act(() => {
    chip().focus();
  });
  act(() => {
    vi.advanceTimersByTime(600);
  });
  return screen.getByRole('tooltip');
};

describe('PlanUsageChip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('which sessions get one', () => {
    it('renders nothing when the session is neither Claude nor Codex', () => {
      const { container } = render(
        <PlanUsageChip session={makeSession({ cliSource: undefined, model: '', startupCommand: 'zsh' })} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('renders for a Claude session even before any numbers have arrived', () => {
      render(<PlanUsageChip session={makeSession()} />);
      expect(chip()).toBeTruthy();
    });

    it('renders for a Codex session', () => {
      render(<PlanUsageChip session={makeSession({ cliSource: 'codex', model: 'gpt-5' })} />);
      expect(chip().getAttribute('data-cli')).toBe('codex');
    });

    it('trusts the CLI named in the report over its own guess', () => {
      const s = makeSession({ cliSource: 'claude', planUsage: usage([win(10080, 26)], { cli: 'codex' }) });
      render(<PlanUsageChip session={s} />);
      expect(chip().getAttribute('data-cli')).toBe('codex');
      expect(screen.getByRole('group', { name: /^Codex plan usage:/ })).toBeTruthy();
    });
  });

  describe('with numbers', () => {
    it('says the window, the percentage and, for a screen reader, one full sentence', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 63)]) })} />);
      const group = screen.getByRole('group', {
        name: 'Claude plan usage: 63% of the 5-hour limit used, resets in 1 hour 12 minutes',
      });
      expect(within(group).getByText('5h')).toBeTruthy();
      expect(within(group).getByText('63%')).toBeTruthy();
      expect(chip().getAttribute('data-state')).toBe('ready');
      expect(chip().getAttribute('data-severity')).toBe('warn');
      expect(chip().getAttribute('data-stale')).toBe('false');
    });

    it('headlines the more-used window', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 10), win(10080, 80, NOW + 3 * DAY)]) })} />);
      expect(within(chip()).getByText('wk')).toBeTruthy();
      expect(within(chip()).getByText('80%')).toBeTruthy();
    });

    it('draws the bar from the percentage, as a custom property rather than inline layout', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 63)]) })} />);
      const bar = chip().querySelector('[class*="planUsageBar"]') as HTMLElement;
      expect(bar.style.getPropertyValue('--pct')).toBe('63%');
      expect(bar.getAttribute('aria-hidden')).toBe('true');
    });

    it('shows the countdown for the rail', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 63)]) })} />);
      expect(chip().querySelector('[class*="planUsageReset"]')?.textContent).toBe('↻ 1h 12m');
    });

    it('has no countdown when the CLI gave no reset time', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 63, null)]) })} />);
      expect(chip().querySelector('[class*="planUsageReset"]')).toBeNull();
    });

    it('adds a ▲ — never colour alone — from 85%, and not before', () => {
      const { rerender } = render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 84)]) })} />);
      expect(chip().textContent).not.toContain('▲');
      expect(chip().getAttribute('data-severity')).toBe('warn');
      rerender(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 85)]) })} />);
      expect(chip().textContent).toContain('▲');
      expect(chip().getAttribute('data-severity')).toBe('high');
    });

    it('is high, with the ▲, when the CLI reports a limit hit at a low percentage', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 12)], { limitReached: true }) })} />);
      expect(chip().getAttribute('data-severity')).toBe('high');
      expect(chip().textContent).toContain('▲');
    });

    it('marks a report older than ten minutes as stale, and says how old', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 63)], { asOf: NOW - 11 * MIN }) })} />);
      expect(chip().getAttribute('data-stale')).toBe('true');
      expect(chip().getAttribute('aria-label')).toMatch(/as of /);
    });

    it('updates when a newer report arrives', () => {
      const { rerender } = render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 63)]) })} />);
      rerender(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 71)]) })} />);
      expect(within(chip()).getByText('71%')).toBeTruthy();
    });
  });

  describe('with nothing to show', () => {
    it('shows "—" and says why for Claude', () => {
      render(<PlanUsageChip session={makeSession()} />);
      expect(chip().getAttribute('data-state')).toBe('empty');
      expect(within(chip()).getByText('—')).toBeTruthy();
      expect(chip().getAttribute('aria-label')).toBe(
        'Claude plan usage unavailable: Plan usage is read from Claude sessions started in this dashboard — none has reported yet.',
      );
    });

    it('shows "—" and says why for Codex', () => {
      render(<PlanUsageChip session={makeSession({ cliSource: 'codex', model: 'gpt-5' })} />);
      expect(chip().getAttribute('aria-label')).toBe(
        'Codex plan usage unavailable: Plan usage appears once Codex has made a request.',
      );
    });

    it('shows "—" when every window has reset since the report', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 95, NOW - MIN)]) })} />);
      expect(chip().getAttribute('data-state')).toBe('expired');
      expect(within(chip()).getByText('—')).toBeTruthy();
      expect(chip().getAttribute('aria-label')).toContain('The usage window has reset since the last report.');
    });

    it('does not mark a dash as stale — there is no figure to be out of date', () => {
      // The report that expired is old (so "stale" is true of the report), but nothing is drawn from it.
      render(
        <PlanUsageChip session={makeSession({ planUsage: usage([win(300, 95, NOW - MIN)], { asOf: NOW - 2 * HOUR }) })} />,
      );
      expect(chip().getAttribute('data-state')).toBe('expired');
      expect(chip().getAttribute('data-stale')).toBe('false');
    });
  });

  describe('the clock', () => {
    it('counts down once a minute without a new report', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 63, NOW + 72 * MIN)]) })} />);
      expect(chip().querySelector('[class*="planUsageReset"]')?.textContent).toBe('↻ 1h 12m');
      act(() => {
        vi.advanceTimersByTime(MIN);
      });
      expect(chip().querySelector('[class*="planUsageReset"]')?.textContent).toBe('↻ 1h 11m');
    });

    it('gives up a window the moment it resets, even if no report says so', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 63, NOW + 30_000)]) })} />);
      expect(chip().getAttribute('data-state')).toBe('ready');
      act(() => {
        vi.advanceTimersByTime(MIN);
      });
      expect(chip().getAttribute('data-state')).toBe('expired');
    });

    it('stops ticking when it unmounts', () => {
      const { unmount } = render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 63)]) })} />);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('as a control', () => {
    it('is a readout, not a button — but keyboard users can reach it', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 63)]) })} />);
      expect(screen.queryByRole('button')).toBeNull();
      expect(chip().getAttribute('role')).toBe('group');
      expect(chip().tabIndex).toBe(0);
    });
  });

  describe('tooltip', () => {
    it('opens on keyboard focus with the title and one row per running window', () => {
      render(
        <PlanUsageChip session={makeSession({ planUsage: usage([win(10080, 21, NOW + 3 * DAY), win(300, 63)]) })} />,
      );
      const tip = showTooltip();
      expect(within(tip).getByText('Claude Code · plan usage')).toBeTruthy();
      const rows = tip.querySelectorAll('[class*="planUsageTipRow"]');
      expect(rows).toHaveLength(2);
      expect(rows[0].textContent).toContain('5-hour');
      expect(rows[0].textContent).toContain('63%');
      expect(rows[0].textContent).toMatch(/resets .*\(in 1h 12m\)/);
      expect(rows[1].textContent).toContain('weekly');
      expect(rows[1].textContent).toContain('21%');
      // three days out: a date or weekday, never a countdown printed beside it
      expect(rows[1].textContent).not.toMatch(/\(in /);
    });

    it('names the Codex plan and says when the report was made', () => {
      render(
        <PlanUsageChip
          session={makeSession({
            cliSource: 'codex',
            planUsage: usage([win(10080, 26, NOW + 5 * DAY)], { cli: 'codex', plan: 'prolite' }),
          })}
        />,
      );
      const tip = showTooltip();
      expect(within(tip).getByText('Codex · prolite')).toBeTruthy();
      expect(tip.textContent).toMatch(/as of /i);
    });

    it('says a limit was reached', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 100)], { limitReached: true }) })} />);
      expect(within(showTooltip()).getByText('Limit reached')).toBeTruthy();
    });

    it('gives the reason instead of rows when there is nothing to show', () => {
      render(<PlanUsageChip session={makeSession()} />);
      const tip = showTooltip();
      expect(tip.querySelectorAll('[class*="planUsageTipRow"]')).toHaveLength(0);
      expect(tip.textContent).toContain('Plan usage is read from Claude sessions started in this dashboard');
    });
  });
});
