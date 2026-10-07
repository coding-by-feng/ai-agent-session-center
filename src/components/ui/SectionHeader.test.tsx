import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import SectionHeader from './SectionHeader';

describe('SectionHeader', () => {
  it('is a plain heading with its count when it does not collapse', () => {
    render(<SectionHeader label="Wed, Oct 7, 2026" count={12} />);
    const heading = screen.getByRole('heading', { name: /Wed, Oct 7, 2026/ });
    expect(heading.textContent).toContain('12');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('collapses through a real button that reports aria-expanded', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <SectionHeader label="Urgent" count={10} collapsed={false} onToggle={onToggle} />,
    );
    const btn = screen.getByRole('button', { name: /Urgent/ });
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<SectionHeader label="Urgent" count={10} collapsed onToggle={onToggle} />);
    expect(screen.getByRole('button', { name: /Urgent/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('puts the count right after the label, not at the far edge', () => {
    render(<SectionHeader label="Urgent" count={10} collapsed={false} onToggle={() => {}} aside="10 shown" />);
    const btn = screen.getByRole('button', { name: /Urgent/ });
    const label = screen.getByText('Urgent');
    const badge = label.nextElementSibling;
    // label and count badge are adjacent siblings inside the toggle; the aside follows the rule
    expect(badge?.textContent).toBe('10');
    expect(btn.contains(badge)).toBe(true);
    expect(screen.getByText('10 shown')).toBeTruthy();
  });

  it('controls the region it names', () => {
    render(<SectionHeader label="Urgent" collapsed={false} onToggle={() => {}} controls="group-urgent" />);
    expect(screen.getByRole('button', { name: /Urgent/ }).getAttribute('aria-controls')).toBe('group-urgent');
  });
});
