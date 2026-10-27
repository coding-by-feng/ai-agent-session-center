// CommandMenuDropdown.test.tsx — each row shows how often it was used (Oct 26 2026), so the
// list's order explains itself; an unused or uncounted row shows nothing.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import CommandMenuDropdown from './CommandMenuDropdown';

describe('CommandMenuDropdown use counts', () => {
  it('shows a used row’s count and leaves an unused row bare', () => {
    render(
      <CommandMenuDropdown
        items={[
          { label: '/rar', insert: '/rar', kind: 'command', uses: 104 },
          { label: '/ultrareview', insert: '/ultrareview', kind: 'command' },
        ]}
        selectedIdx={0}
        style={{}}
        onPick={() => {}}
        keysHint=""
      />,
    );
    const count = screen.getByTitle('Used 104 times in the last 90 days');
    expect(count.textContent).toBe('104×');
    expect(screen.getAllByRole('option')[1].textContent).not.toMatch(/×/);
  });
});
