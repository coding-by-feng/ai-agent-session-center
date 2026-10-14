import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SessionRuntimeChip from './SessionRuntimeChip';
import type { Session } from '@/types';

const session = (p: Partial<Session> = {}): Session =>
  ({ sessionId: 's', model: 'claude-opus-5-5', cliSource: 'claude', ...p }) as unknown as Session;

describe('SessionRuntimeChip', () => {
  it('shows the current model and effort, and says both aloud', () => {
    render(<SessionRuntimeChip session={session({ runtime: { model: 'Opus 5.5', modelAt: 1, effort: 'high', effortAt: 1 } })} />);
    const chip = screen.getByRole('status', { name: 'Model Opus 5.5, effort high' });
    expect(chip.textContent).toContain('Opus 5.5');
    expect(chip.textContent).toContain('high');
  });

  it('follows a change: re-rendered with a new runtime it shows the new values', () => {
    const { rerender } = render(<SessionRuntimeChip session={session({ runtime: { model: 'Opus 5.5', modelAt: 1, effort: 'high', effortAt: 1 } })} />);
    rerender(<SessionRuntimeChip session={session({ runtime: { model: 'Haiku 4.5', modelAt: 2, effort: 'low', effortAt: 2 } })} />);
    expect(screen.getByRole('status', { name: 'Model Haiku 4.5, effort low' })).toBeTruthy();
  });

  it('drops the effort half while the effort is unknown', () => {
    render(<SessionRuntimeChip session={session({ runtime: { model: 'Haiku 4.5', modelAt: 2, effortAt: 2 } })} />);
    const chip = screen.getByRole('status', { name: 'Model Haiku 4.5' });
    expect(chip.querySelector('[data-part="effort"]')).toBeNull();
  });

  it('marks a launch-time value as not yet confirmed by the CLI', () => {
    render(<SessionRuntimeChip session={session({ effortLevel: 'max' })} />);
    expect(screen.getByRole('status').getAttribute('data-live')).toBe('false');
  });

  it('is not a control: nothing to click, nothing to tab to', () => {
    render(<SessionRuntimeChip session={session({ runtime: { model: 'Opus 5.5', modelAt: 1 } })} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('status').getAttribute('tabindex')).toBeNull();
  });

  it('renders nothing for a Codex session', () => {
    const { container } = render(<SessionRuntimeChip session={session({ cliSource: 'codex', model: 'gpt-5-codex' })} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the context-window % as its own segment, banded, and says it aloud', () => {
    render(<SessionRuntimeChip session={session({ runtime: {
      model: 'Opus 5.5', modelAt: 1, effort: 'high', effortAt: 1, context: { pct: 91, size: 200000, tokens: 182000 }, contextAt: 1,
    } })} />);
    const chip = screen.getByRole('status', { name: 'Model Opus 5.5, effort high, context 91% used' });
    const part = chip.querySelector('[data-part="context"]');
    expect(part?.textContent).toContain('91%');
    expect(part?.getAttribute('data-level')).toBe('high');
  });

  it('has no context segment until Claude Code reports one', () => {
    render(<SessionRuntimeChip session={session({ runtime: { model: 'Opus 5.5', modelAt: 1 } })} />);
    expect(screen.getByRole('status').querySelector('[data-part="context"]')).toBeNull();
  });
});
