import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import DetailTabs from './DetailTabs';

describe('DetailTabs', () => {
  const defaultProps = {
    terminalContent: <div>Terminal Content</div>,
    promptsContent: <div>Prompts Content</div>,
    projectContent: <div>Project Content</div>,
    notesContent: <div>Notes Content</div>,
    queueContent: <div>Queue Content</div>,
  };

  beforeEach(() => {
    // Clear localStorage before each test so default tab is 'terminal'
    try { localStorage.removeItem('active-tab'); } catch { /* ignore */ }
  });

  it('renders all 6 tab buttons', () => {
    render(<DetailTabs {...defaultProps} />);
    expect(screen.getByText('PROJECT')).toBeInTheDocument();
    expect(screen.getByText('TERMINAL')).toBeInTheDocument();
    expect(screen.getByText('COMMANDS')).toBeInTheDocument();
    expect(screen.getByText('PROMPTS')).toBeInTheDocument();
    expect(screen.getByText('NOTES')).toBeInTheDocument();
    expect(screen.getByText('QUEUE')).toBeInTheDocument();
  });

  it('shows terminal content by default', () => {
    render(<DetailTabs {...defaultProps} />);
    expect(screen.getByText('Terminal Content')).toBeInTheDocument();
  });

  it('switches to prompts tab on click', () => {
    render(<DetailTabs {...defaultProps} />);
    fireEvent.click(screen.getByText('PROMPTS'));
    expect(screen.getByText('Prompts Content')).toBeInTheDocument();
  });

  it('switches to notes tab on click', () => {
    render(<DetailTabs {...defaultProps} />);
    fireEvent.click(screen.getByText('NOTES'));
    expect(screen.getByText('Notes Content')).toBeInTheDocument();
  });

  it('calls onTabChange callback when tab changes', () => {
    const onTabChange = vi.fn();
    render(<DetailTabs {...defaultProps} onTabChange={onTabChange} />);
    fireEvent.click(screen.getByText('NOTES'));
    expect(onTabChange).toHaveBeenCalledWith('notes');
  });

  it('persists active tab to localStorage', () => {
    render(<DetailTabs {...defaultProps} />);
    fireEvent.click(screen.getByText('NOTES'));
    expect(localStorage.getItem('active-tab')).toBe('notes');
  });

  it('restores active tab from localStorage', () => {
    localStorage.setItem('active-tab', 'notes');
    render(<DetailTabs {...defaultProps} />);
    expect(screen.getByText('Notes Content')).toBeInTheDocument();
  });
});
