// TabBar.test.tsx — the phone frame's bottom tabs (AASC-39): which one is current,
// the badge (shown, capped, spoken), and hiding.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TabBar from './TabBar';

const items = (badge = 0) => [
  { id: 'sessions', label: 'Sessions', icon: <span /> },
  { id: 'inbox', label: 'Inbox', icon: <span />, badge, badgeLabel: (n: number) => `${n} waiting for you` },
  { id: 'queue', label: 'Queue', icon: <span /> },
  { id: 'more', label: 'More', icon: <span /> },
];

describe('TabBar', () => {
  it('draws four tabs and marks the current one', () => {
    render(<TabBar items={items()} active="inbox" onSelect={() => {}} />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const tabs = Array.from(nav.querySelectorAll('button'));
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual(['Sessions', 'Inbox', 'Queue', 'More']);
    expect(screen.getByRole('button', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Sessions' })).not.toHaveAttribute('aria-current');
  });

  it('reports a tap, the current tab included', async () => {
    const onSelect = vi.fn();
    render(<TabBar items={items()} active="sessions" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(onSelect.mock.calls).toEqual([['queue'], ['sessions']]);
  });

  it('badges a count and says it aloud', () => {
    render(<TabBar items={items(3)} active="sessions" onSelect={() => {}} />);
    expect(screen.getByTestId('tab-badge-inbox')).toHaveTextContent('3');
    expect(screen.getByRole('button', { name: 'Inbox, 3 waiting for you' })).toBeTruthy();
  });

  it('caps a big count and shows no badge for zero', () => {
    const { rerender } = render(<TabBar items={items(250)} active="sessions" onSelect={() => {}} />);
    expect(screen.getByTestId('tab-badge-inbox')).toHaveTextContent('99+');
    rerender(<TabBar items={items(0)} active="sessions" onSelect={() => {}} />);
    expect(screen.queryByTestId('tab-badge-inbox')).toBeNull();
  });

  it('leaves the page (and the accessibility tree) when hidden', () => {
    render(<TabBar items={items()} active="sessions" onSelect={() => {}} hidden />);
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
