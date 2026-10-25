// CliUpdateLog.test.tsx — a CLI update's elapsed time and live output under its row in Settings ▸
// ADVANCED ▸ Agent CLIs (Oct 26 2026). Pure render: no server, no CLI.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { CliUpdateStatus, CliVersionInfo } from '@/types/cliVersions';
import CliUpdateLog from './CliUpdateLog';

const info = (update: CliUpdateStatus): CliVersionInfo => ({
  cli: 'codex', installed: '0.163.0', latest: '0.164.0', updateAvailable: true, checkedAt: 1, update,
});

afterEach(() => vi.useRealTimers());

describe('CliUpdateLog', () => {
  it('shows nothing when no update has run', () => {
    const { container } = render(<CliUpdateLog info={info({ state: 'idle' })} name="Codex" />);
    expect(container.textContent).toBe('');
  });

  it('while running, ticks the elapsed time against the limit and shows the output so far', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    render(<CliUpdateLog info={info({ state: 'updating', startedAt: 58_000, log: ['Updating Codex via npm', 'added 1 package'] })} name="Codex" />);
    expect(screen.getByText('0:42 elapsed · stops at 5:00')).toBeTruthy();
    expect(screen.getByRole('log', { name: 'Codex update output' }).textContent).toBe('Updating Codex via npm\nadded 1 package');
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(screen.getByText('0:45 elapsed · stops at 5:00')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Codex update time' })).toBeTruthy();
  });

  it('says so while the updater has printed nothing yet', () => {
    render(<CliUpdateLog info={info({ state: 'updating', startedAt: Date.now(), log: [] })} name="Codex" />);
    expect(screen.getByText(/No output yet/)).toBeTruthy();
  });

  it('after a success, keeps the log behind Show log with its length and duration', () => {
    render(<CliUpdateLog info={info({ state: 'updated', startedAt: 1_000, at: 49_000, log: ['a', 'b', 'c'] })} name="Codex" />);
    expect(screen.queryByRole('log')).toBeNull();
    const toggle = screen.getByRole('button', { name: /Show log \(3 lines · took 0:48\)/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('log').textContent).toBe('a\nb\nc');
    expect(screen.getByRole('button', { name: /Hide log/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('opens the log by itself after a failure', () => {
    render(<CliUpdateLog info={info({ state: 'failed', startedAt: 1_000, at: 2_000, error: 'EACCES', log: ['npm ERR! EACCES'] })} name="Codex" />);
    expect(screen.getByRole('log').textContent).toBe('npm ERR! EACCES');
  });
});
