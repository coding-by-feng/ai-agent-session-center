import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import UnknownPopoutNotice from './UnknownPopoutNotice';

describe('UnknownPopoutNotice', () => {
  it('says which view was asked for and what to do about it', () => {
    render(<UnknownPopoutNotice kind="timeline" />);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(/“timeline” view/);
    expect(notice).toHaveTextContent(/close it and open it again/i);
  });

  it('cuts a very long kind short instead of filling the window with it', () => {
    render(<UnknownPopoutNotice kind={'x'.repeat(500)} />);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain(`${'x'.repeat(40)}…`);
    expect(text).not.toContain('x'.repeat(41));
  });

  it('shows markup in the kind as text', () => {
    render(<UnknownPopoutNotice kind="<img src=x onerror=alert(1)>" />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('<img src=x onerror=alert(1)>');
  });
});
