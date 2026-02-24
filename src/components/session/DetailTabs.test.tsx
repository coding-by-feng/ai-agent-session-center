import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import DetailTabs from './DetailTabs';

describe('DetailTabs', () => {
  const defaultProps = {
    terminalContent: <div>Terminal Content</div>,
    promptsContent: <div>Prompts Content</div>,
    projectContent: <div>Project Content</div>,
    notesContent: <div>Notes Content</div>,
    activityContent: <div>Activity Content</div>,
    summaryContent: <div>Summary Content</div>,
    queueContent: <div>Queue Content</div>,
  };

  beforeEach(() => {
    // Clear localStorage before each test so default tab is 'terminal'
    try { localStorage.removeItem('active-tab'); } catch { /* ignore */ }
  });

  it('renders all 7 tab buttons', () => {
    render(<DetailTabs {...defaultProps} />);
    expect(screen.getByText('TERMINAL')).toBeInTheDocument();
    expect(screen.getByText('PROMPTS')).toBeInTheDocument();
    expect(screen.getByText('PROJECT')).toBeInTheDocument();
    expect(screen.getByText('QUEUE')).toBeInTheDocument();
    expect(screen.getByText('NOTES')).toBeInTheDocument();
    expect(screen.getByText('ACTIVITY')).toBeInTheDocument();
    expect(screen.getByText('SUMMARY')).toBeInTheDocument();
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

  it('switches to activity tab on click', () => {
    render(<DetailTabs {...defaultProps} />);
    fireEvent.click(screen.getByText('ACTIVITY'));
    expect(screen.getByText('Activity Content')).toBeInTheDocument();
  });

  it('switches to summary tab on click', () => {
    render(<DetailTabs {...defaultProps} />);
    fireEvent.click(screen.getByText('SUMMARY'));
    expect(screen.getByText('Summary Content')).toBeInTheDocument();
  });

  it('calls onTabChange callback when tab changes', () => {
    const onTabChange = vi.fn();
    render(<DetailTabs {...defaultProps} onTabChange={onTabChange} />);
    fireEvent.click(screen.getByText('NOTES'));
    expect(onTabChange).toHaveBeenCalledWith('notes');
  });

  it('persists active tab to localStorage', () => {
    render(<DetailTabs {...defaultProps} />);
    fireEvent.click(screen.getByText('ACTIVITY'));
    expect(localStorage.getItem('active-tab')).toBe('activity');
  });

  it('restores active tab from localStorage', () => {
    localStorage.setItem('active-tab', 'summary');
    render(<DetailTabs {...defaultProps} />);
    // Summary tab content should be visible (active class applied)
    expect(screen.getByText('Summary Content')).toBeInTheDocument();
  });
});
