// RecentPutDownMenu.test.tsx — RECENT's put-down chip and its Put back menu (Nov 23 2026).
import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import RecentPutDownMenu from './RecentPutDownMenu';
import { useRecentPutDownStore } from '@/stores/recentPutDownStore';
import { putDownToday } from '@/lib/recentPutDown';
import type { Session } from '@/types';

const s = (sessionId: string, title: string) => ({ sessionId, title, status: 'waiting' }) as Session;
const today = () => putDownToday(useRecentPutDownStore.getState().putDown, Date.now());

describe('RecentPutDownMenu', () => {
  beforeEach(() => {
    act(() => {
      useRecentPutDownStore.getState().putBackAll();
      useRecentPutDownStore.getState().putDownSession('a');
      useRecentPutDownStore.getState().putDownSession('b');
    });
  });

  it('draws nothing while no session is put down', () => {
    const { container } = render(<RecentPutDownMenu sessions={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the count and puts one back', () => {
    render(<RecentPutDownMenu sessions={[s('a', 'Exmouth KRT'), s('b', 'AASC Codex')]} />);
    const chip = screen.getByRole('button', { name: '2 put down from Recent today' });
    expect(chip.textContent).toBe('2');
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('menuitem', { name: /Exmouth KRT/ }));
    expect(today()).toEqual(['b']);
  });

  it('puts all back', () => {
    render(<RecentPutDownMenu sessions={[s('a', 'Exmouth KRT'), s('b', 'AASC Codex')]} />);
    fireEvent.click(screen.getByRole('button', { name: /put down from Recent/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Put all back' }));
    expect(today()).toEqual([]);
  });

  it('remembers what was put down across a reload (localStorage)', () => {
    expect(JSON.parse(localStorage.getItem('recent-put-down') ?? '{}').ids).toEqual(['a', 'b']);
  });
});
