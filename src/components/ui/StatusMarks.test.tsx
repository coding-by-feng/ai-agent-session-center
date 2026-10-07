import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import Chip from './Chip';
import CountBadge from './CountBadge';
import EmptyState from './EmptyState';
import StaleNote from './StaleNote';
import Button from './Button';

describe('Chip', () => {
  it('is a non-interactive mark that carries its tone as a class', () => {
    render(<Chip tone="success">Idle</Chip>);
    const chip = screen.getByText('Idle');
    expect(chip.tagName).toBe('SPAN');
    expect(screen.queryByRole('button')).toBeNull();
    const neutral = render(<Chip>Ended</Chip>).getByText('Ended');
    expect(chip.className).not.toBe(neutral.className);
  });
});

describe('CountBadge', () => {
  it('shows the number and describes it for screen readers in real text', () => {
    render(
      <a href="/agenda">
        AGENDA
        <CountBadge count={32} label="32 open tasks" />
      </a>,
    );
    // The digits are for the eye; the wording is what a screen reader hears.
    expect(screen.getByText('32').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('link').textContent).toContain('32 open tasks');
    expect(screen.getByRole('link')).toHaveAccessibleName(/AGENDA\s*32 open tasks/);
  });

  it('reads the bare digits when it has no label', () => {
    render(<CountBadge count={7} />);
    expect(screen.getByText('7').getAttribute('aria-hidden')).toBeNull();
  });

  it('caps a large number', () => {
    render(<CountBadge count={1500} max={999} />);
    expect(screen.getByText('999+')).toBeTruthy();
  });
});

describe('EmptyState', () => {
  it('announces itself as a status with its title, hint and action', () => {
    render(
      <EmptyState
        title="No tasks yet"
        hint="Add your first task below."
        action={<Button>Open Sources</Button>}
      />,
    );
    const box = screen.getByRole('status');
    expect(box.textContent).toContain('No tasks yet');
    expect(box.textContent).toContain('Add your first task below.');
    expect(screen.getByRole('button', { name: 'Open Sources' })).toBeTruthy();
  });

  it('is an alert when it reports an error', () => {
    render(<EmptyState tone="error" title="Could not load prompts." />);
    expect(screen.getByRole('alert').textContent).toContain('Could not load prompts.');
  });

  it('marks a loading state busy', () => {
    render(<EmptyState busy title="Loading tasks…" />);
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
  });
});

describe('StaleNote', () => {
  it('says the rows on screen may be out of date, with a Retry that retries', () => {
    const retry = vi.fn();
    render(<StaleNote onRetry={retry} />);
    const note = screen.getByRole('alert');
    expect(note.textContent).toContain("Couldn't refresh. Showing the last results.");
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('offers no Retry when asking again cannot help', () => {
    render(<StaleNote>History is host-only.</StaleNote>);
    expect(screen.getByRole('alert').textContent).toBe('History is host-only.');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
