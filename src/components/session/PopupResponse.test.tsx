import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PopupResponse from './PopupResponse';

describe('PopupResponse', () => {
  it('renders a captured answer as markdown, not raw source', () => {
    const { container } = render(
      <PopupResponse response={'# pullback\n\n**词性** 名词\n\n- one\n- two'} />,
    );
    // Markdown structure exists...
    expect(container.querySelector('h1')?.textContent).toBe('pullback');
    expect(container.querySelector('strong')?.textContent).toBe('词性');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    // ...and the raw markdown punctuation is gone from the text.
    expect(container.textContent).not.toContain('# pullback');
    expect(container.textContent).not.toContain('**词性**');
  });

  it('shows the empty hint when nothing was captured', () => {
    render(<PopupResponse response="" emptyHint="nothing here" />);
    expect(screen.getByText('nothing here')).toBeTruthy();
  });

  it('falls back to raw output with a note when the capture is only chrome', () => {
    render(
      <PopupResponse
        response={"quote>  =prompt\n7 8ClaudeCode\nWelcome back Kason!"}
      />,
    );
    expect(screen.getByText(/No readable answer in this capture/)).toBeTruthy();
    // The raw text is still reachable.
    expect(screen.getByText(/Welcome back Kason!/)).toBeTruthy();
  });

  it('offers a raw ⇆ formatted toggle when there is a formatted answer', () => {
    render(<PopupResponse response={'# Title\n\nBody.'} />);
    const toggle = screen.getByRole('button', { name: /raw/i });
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle);
    // After switching to raw, the raw markdown source is shown verbatim.
    expect(screen.getByText(/# Title/)).toBeTruthy();
  });

  it('uses the provided section label', () => {
    render(<PopupResponse response="hello" label="Conversation" />);
    expect(screen.getByText('Conversation')).toBeTruthy();
  });
});
