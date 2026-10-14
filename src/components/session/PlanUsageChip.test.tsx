import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, within, fireEvent } from '@testing-library/react';

const syncPlanUsage = vi.hoisted(() => vi.fn());
vi.mock('@/lib/planUsageApi', () => ({ syncPlanUsage }));

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
    syncPlanUsage.mockReset();
    syncPlanUsage.mockResolvedValue({ cli: 'claude', checkedAt: NOW, asOf: NOW - MIN, changed: false });
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
      expect(screen.getByRole('button', { name: /^Codex plan usage:/ })).toBeTruthy();
    });
  });

  describe('with numbers', () => {
    it('says the window, the percentage and, for a screen reader, one full sentence', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 63)]) })} />);
      const group = screen.getByRole('button', {
        name: 'Claude plan usage: 63% of the 5-hour limit used, resets in 1 hour 12 minutes. Sync now.',
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

    it('shows the countdown for the rail, behind a clock rather than the refresh arrow the click now owns', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 63)]) })} />);
      const reset = chip().querySelector('[class*="planUsageReset"]') as HTMLElement;
      expect(reset.textContent).toBe('1h 12m');
      expect(reset.textContent).not.toContain('↻');
      expect(reset.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
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
        'Claude plan usage unavailable: Plan usage is read from Claude sessions started in this dashboard — none has reported yet. Sync now.',
      );
    });

    it('shows "—" and says why for Codex', () => {
      render(<PlanUsageChip session={makeSession({ cliSource: 'codex', model: 'gpt-5' })} />);
      expect(chip().getAttribute('aria-label')).toBe(
        'Codex plan usage unavailable: Plan usage appears once Codex has made a request. Sync now.',
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
      expect(chip().querySelector('[class*="planUsageReset"]')?.textContent).toBe('1h 12m');
      act(() => {
        vi.advanceTimersByTime(MIN);
      });
      expect(chip().querySelector('[class*="planUsageReset"]')?.textContent).toBe('1h 11m');
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
    it('is a real button, so keyboard and touch can sync with it', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 63)]) })} />);
      expect(screen.getAllByRole('button')).toHaveLength(1);
      expect(chip().tagName).toBe('BUTTON');
      expect(chip().getAttribute('type')).toBe('button');
      expect(chip().tabIndex).toBe(0);
    });
  });

  describe('syncing', () => {
    const click = () => act(() => { fireEvent.click(chip()); });
    const settle = (ms = 700) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    const withUsage = (over: Partial<PlanUsage> = {}, sessionOver: Partial<Session> = {}) =>
      makeSession({ planUsage: usage([win(300, 63)], over), ...sessionOver });

    it('asks the server to re-read the CLI the report names', () => {
      render(<PlanUsageChip session={withUsage()} />);
      click();
      expect(syncPlanUsage).toHaveBeenCalledWith('claude', expect.any(AbortSignal));
    });

    it('syncs a Codex session as Codex', () => {
      render(<PlanUsageChip session={makeSession({ cliSource: 'codex', planUsage: usage([win(300, 63)], { cli: 'codex' }) })} />);
      click();
      expect(syncPlanUsage).toHaveBeenCalledWith('codex', expect.any(AbortSignal));
    });

    it('also syncs when there is nothing to show yet: that is how a first report is found', () => {
      render(<PlanUsageChip session={makeSession()} />);
      click();
      expect(syncPlanUsage).toHaveBeenCalledWith('claude', expect.any(AbortSignal));
    });

    it('says it is busy without losing focus or the click: aria-busy, never disabled', () => {
      render(<PlanUsageChip session={withUsage()} />);
      expect(chip().getAttribute('aria-busy')).toBe('false');
      click();
      expect(chip().getAttribute('aria-busy')).toBe('true');
      expect(chip().getAttribute('data-syncing')).toBe('true');
      expect((chip() as HTMLButtonElement).disabled).toBe(false);
    });

    it('swaps the CLI mark for a spinner while it works, and back after', async () => {
      render(<PlanUsageChip session={withUsage()} />);
      expect(chip().querySelector('[class*="planUsageSpinner"]')).toBeNull();
      click();
      expect(chip().querySelector('[class*="planUsageSpinner"]')).not.toBeNull();
      await settle();
      expect(chip().querySelector('[class*="planUsageSpinner"]')).toBeNull();
      expect(chip().querySelector('[class*="planUsageMark"]')).not.toBeNull();
    });

    it('does not fire a second request while one is in flight', async () => {
      render(<PlanUsageChip session={withUsage()} />);
      click();
      click();
      click();
      expect(syncPlanUsage).toHaveBeenCalledTimes(1);
      await settle();
    });

    it('offers the click in the panel until it has been used', () => {
      render(<PlanUsageChip session={withUsage()} />);
      expect(within(showTooltip()).getByText('Click to sync')).toBeTruthy();
    });

    it('says in the panel that it is syncing', () => {
      render(<PlanUsageChip session={withUsage()} />);
      click();
      expect(within(showTooltip()).getByText('Syncing…')).toBeTruthy();
    });

    it('says when nothing newer was found', async () => {
      render(<PlanUsageChip session={withUsage()} />);
      click();
      await settle();
      expect(chip().getAttribute('data-sync')).toBe('done');
      expect(within(showTooltip()).getByText('Up to date · checked just now')).toBeTruthy();
    });

    it('says when the numbers were updated', async () => {
      syncPlanUsage.mockResolvedValue({ cli: 'claude', checkedAt: NOW, asOf: NOW, changed: true });
      render(<PlanUsageChip session={withUsage()} />);
      click();
      await settle();
      expect(within(showTooltip()).getByText('Updated just now')).toBeTruthy();
    });

    it('says it failed, and the next click tries again', async () => {
      syncPlanUsage.mockRejectedValueOnce(new Error('Rate limit exceeded'));
      render(<PlanUsageChip session={withUsage()} />);
      click();
      await settle();
      expect(chip().getAttribute('data-sync')).toBe('failed');
      expect(within(showTooltip()).getByText("Couldn't sync · click to retry")).toBeTruthy();
      click();
      await settle();
      expect(chip().getAttribute('data-sync')).toBe('done');
      expect(syncPlanUsage).toHaveBeenCalledTimes(2);
    });

    it('announces the outcome to a screen reader, and says nothing before anyone asked', async () => {
      render(<PlanUsageChip session={withUsage()} />);
      const live = () => document.querySelector('[role="status"]') as HTMLElement;
      expect(live().textContent).toBe('');
      click();
      expect(live().textContent).toBe('Syncing plan usage');
      await settle();
      expect(live().textContent).toBe('Plan usage is up to date');
    });

    it('goes back to offering the click once the answer is as old as a stale report', async () => {
      render(<PlanUsageChip session={withUsage()} />);
      click();
      await settle();
      await settle(11 * 60_000);
      expect(chip().getAttribute('data-sync')).toBe('done'); // the state is kept…
      expect(within(showTooltip()).getByText('Click to sync')).toBeTruthy(); // …the footer is not
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

    it('says how old the reading is beside the clock time', () => {
      render(<PlanUsageChip session={makeSession({ planUsage: usage([win(300, 63)], { asOf: NOW - 105 * MIN }) })} />);
      expect(showTooltip().textContent).toMatch(/as of .*· 1h 45m ago/);
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
