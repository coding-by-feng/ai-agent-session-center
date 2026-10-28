// Oct 28 2026: a remote browser (e.g. http://<tailnet address>:3333/) is blocked for 15 minutes
// after 5 wrong passwords. The screen says how many tries are left, counts the block down,
// and unlocks itself when it ends.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import LoginScreen from './LoginScreen';
import type { LoginResult } from '@/hooks/useAuth';

function submit(password = 'nope') {
  fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: password } });
  fireEvent.submit(screen.getByRole('button').closest('form')!);
}

async function settle() {
  await act(async () => { await Promise.resolve(); });
}

describe('LoginScreen — wrong passwords and the block', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says how many tries are left after a wrong password, with no hint yet', async () => {
    const onLogin = vi.fn(async (): Promise<LoginResult> => ({ success: false, error: 'Wrong password', attemptsLeft: 2 }));
    render(<LoginScreen onLogin={onLogin} />);
    submit();
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong password · 2 tries left');
    expect(screen.queryByText(/npm run set-password/)).toBeNull();
  });

  it('warns on the last try, in the singular, and shows the recovery hint', async () => {
    const onLogin = vi.fn(async (): Promise<LoginResult> => ({ success: false, error: 'Wrong password', attemptsLeft: 1 }));
    render(<LoginScreen onLogin={onLogin} />);
    submit();
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong password · 1 try left');
    expect(screen.getByText('npm run set-password')).toBeInTheDocument();
  });

  it('locks the form with a countdown, then unlocks itself when the block ends', async () => {
    const onLogin = vi.fn(async (): Promise<LoginResult> => ({
      success: false, error: 'Too many wrong passwords. Try again in 15 minutes.', retryAfter: 900,
    }));
    render(<LoginScreen onLogin={onLogin} />);
    submit();
    await settle();

    const field = screen.getByPlaceholderText('Password');
    const button = screen.getByRole('button');
    expect(screen.getByRole('alert')).toHaveTextContent('Too many wrong passwords.');
    expect(screen.getByText('15:00')).toBeInTheDocument();
    expect(field).toBeDisabled();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Locked');
    expect(screen.getByText('npm run set-password')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('14:59')).toBeInTheDocument();

    // A submit while blocked (Enter in a disabled form) never reaches the server.
    fireEvent.submit(button.closest('form')!);
    expect(onLogin).toHaveBeenCalledTimes(1);

    act(() => { vi.advanceTimersByTime(899 * 1000); });
    expect(field).toBeEnabled();
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent('Login');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field).toHaveFocus();
  });

  it('starts locked when the page loads during a block', () => {
    render(<LoginScreen onLogin={vi.fn()} lockedFor={65} />);
    expect(screen.getByText('1:05')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Password')).toBeDisabled();
  });

  it('still shows the server sentence for other failures', async () => {
    const onLogin = vi.fn(async (): Promise<LoginResult> => ({ success: false, error: 'Connection error -- is the server running?' }));
    render(<LoginScreen onLogin={onLogin} />);
    submit();
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Connection error -- is the server running?');
  });
});
