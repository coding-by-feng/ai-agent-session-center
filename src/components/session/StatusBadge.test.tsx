import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusBadge from './StatusBadge';

describe('StatusBadge', () => {
  it('shows the status in words with its glyph, coloured by status', () => {
    const { container } = render(<StatusBadge status="working" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge).toHaveTextContent('Working');
    expect(badge).toHaveAttribute('data-status', 'working');
    expect(badge.style.getPropertyValue('--status-color')).toBe('var(--accent-orange)');
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('takes other words when given, and an unknown status as it is', () => {
    render(<><StatusBadge status="idle" label="Idle · 3m" /><StatusBadge status="mystery" /></>);
    expect(screen.getByText('Idle · 3m')).toBeInTheDocument();
    expect(screen.getByText('mystery')).toBeInTheDocument();
  });

  it('is not a control', () => {
    render(<StatusBadge status="approval" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Approval needed').closest('[tabindex]')).toBeNull();
  });
});
