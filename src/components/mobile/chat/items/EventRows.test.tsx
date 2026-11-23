// EventRows.test.tsx — a slash command's row in the phone chat (Nov 23 2026): a one-line result such as /model's
// "Set model to `Opus 5.5` …" reads as a sentence with the name in code, not as a monospace box with raw backticks.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CommandItem } from '@/lib/chat/buildChatItems';
import { CommandRow } from './EventRows';

const item = (output?: string): CommandItem => ({ kind: 'command', key: 'c1', name: 'model', args: 'opus', ...(output !== undefined ? { output } : {}) } as CommandItem);

describe('CommandRow', () => {
  it('shows a one-line result as prose, with the backticked name as code and no backticks left', () => {
    const { container } = render(<CommandRow item={item('Set model to `Opus 5.5` and saved as your default for new sessions')} />);
    expect(screen.getByText('/model opus')).toBeTruthy();
    const result = screen.getByRole('note');
    expect(result.textContent).toBe('Set model to Opus 5.5 and saved as your default for new sessions');
    expect(result.querySelector('code')?.textContent).toBe('Opus 5.5');
    expect(container.querySelector('pre')).toBeNull();
  });

  it('keeps several lines of output in the monospace box', () => {
    const { container } = render(<CommandRow item={item('line one\nline two')} />);
    expect(container.querySelector('pre')?.textContent).toBe('line one\nline two');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('a lone backtick is shown as it is', () => {
    render(<CommandRow item={item('Kept model as `Sonnet 5.5')} />);
    expect(screen.getByRole('note').textContent).toBe('Kept model as `Sonnet 5.5');
  });

  it('shows the pill alone when nothing was printed', () => {
    const { container } = render(<CommandRow item={item()} />);
    expect(screen.getByText('/model opus')).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
  });
});
