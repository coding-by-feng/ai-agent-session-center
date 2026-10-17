// ModelEffortSheet — pick a model (with its version) and an effort in one visit, then Apply once
// (Oct 2026, by request). Taps select; Apply sends only what changed, model first.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { Session } from '@/types';
import ModelEffortSheet from './ModelEffortSheet';

function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1', status: 'waiting', projectName: 'p', projectPath: '/p', title: 't',
    model: 'opus', effortLevel: 'medium', startedAt: 1, lastActivityAt: 1,
    sshCommand: 'claude', startupCommand: 'claude',
    ...over,
  } as unknown as Session;
}

function renderSheet(onApply = vi.fn(), s = session()) {
  render(<ModelEffortSheet open onClose={() => {}} session={s} onApply={onApply} />);
  return onApply;
}

const sheet = () => screen.getByTestId('model-sheet');
const row = (name: RegExp) => within(sheet()).getAllByRole('button', { name })[0];
const apply = () => within(sheet()).getByRole('button', { name: /^Apply/ });

describe('ModelEffortSheet', () => {
  it('names the version each "newest" model is today', () => {
    renderSheet();
    expect(row(/^Opus/)).toHaveTextContent('Newest · Opus 5.5');
    expect(row(/^Sonnet/)).toHaveTextContent('Newest · Sonnet 5.5');
    expect(row(/^Fable/)).toHaveTextContent('Newest · Fable 5.1');
  });

  it('lists the fixed versions right under the models, today\'s first', () => {
    renderSheet();
    fireEvent.click(within(sheet()).getByRole('button', { name: /Fixed versions/ }));
    const pinned = within(sheet()).getByRole('region', { name: 'Fixed versions' });
    const names = within(pinned).getAllByRole('button').map((b) => b.textContent);
    expect(names.slice(0, 4)).toEqual(['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(names).toContain('Opus 4.8');
  });

  it('selects without sending, and Apply is off until something changes', () => {
    const onApply = renderSheet();
    expect(apply()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(row(/^Sonnet/));
    expect(onApply).not.toHaveBeenCalled();
    expect(apply()).not.toHaveAttribute('aria-disabled');
  });

  it('applies the model, then the effort, in one go', () => {
    const onApply = renderSheet();
    fireEvent.click(row(/^Sonnet/));
    fireEvent.click(row(/^High/));
    expect(apply()).toHaveTextContent('Apply · Sonnet 5.5 · High');
    fireEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith(['/model sonnet', '/effort high']);
  });

  it('sends only what changed', () => {
    const onApply = renderSheet();
    fireEvent.click(row(/^High/));
    fireEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith(['/effort high']);
  });

  it('opens the fixed versions by itself when the session runs one, ticking it', () => {
    renderSheet(vi.fn(), session({ model: 'claude-opus-5-5' }));
    const pinned = within(sheet()).getByRole('region', { name: 'Fixed versions' });
    expect(within(pinned).getByRole('button', { name: /Opus 5\.5/ })).toContainElement(within(pinned).getByLabelText('Current'));
  });

  it('pins a fixed version', () => {
    const onApply = renderSheet();
    fireEvent.click(within(sheet()).getByRole('button', { name: /Fixed versions/ }));
    fireEvent.click(within(within(sheet()).getByRole('region', { name: 'Fixed versions' })).getByRole('button', { name: 'Opus 4.8' }));
    fireEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith(['/model claude-opus-4-8']);
  });
});
