import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import FileOpenChooser from './FileOpenChooser';
import { useUiStore } from '@/stores/uiStore';

const providerMocks = vi.hoisted(() => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
  reveal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/fileSystemProvider', () => ({
  getFileSystemProvider: () => providerMocks,
}));

function openChooser(filePath = 'docs/report.pdf', projectPath = '/Users/me/proj') {
  act(() => {
    useUiStore.getState().openFileChooser(filePath, projectPath, { x: 100, y: 100 });
  });
}

describe('FileOpenChooser', () => {
  beforeEach(() => {
    useUiStore.setState({ pendingFileChooser: null, pendingFileOpen: null });
    providerMocks.openExternal.mockClear();
    providerMocks.reveal.mockClear();
  });

  it('renders nothing when no chooser is pending', () => {
    render(<FileOpenChooser />);
    expect(screen.queryByRole('menu')).toBe(null);
  });

  it('shows the file name and all three actions plus cancel', () => {
    render(<FileOpenChooser />);
    openChooser();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('Open in app')).toBeInTheDocument();
    expect(screen.getByText('Open with default app')).toBeInTheDocument();
    expect(screen.getByText(/Reveal in/)).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('Open in app routes through pendingFileOpen and closes', () => {
    render(<FileOpenChooser />);
    openChooser();
    fireEvent.click(screen.getByText('Open in app'));
    expect(useUiStore.getState().pendingFileOpen).toEqual({
      filePath: 'docs/report.pdf',
      projectPath: '/Users/me/proj',
    });
    expect(useUiStore.getState().pendingFileChooser).toBe(null);
  });

  it('Open with default app calls provider.openExternal and closes', () => {
    render(<FileOpenChooser />);
    openChooser();
    fireEvent.click(screen.getByText('Open with default app'));
    expect(providerMocks.openExternal).toHaveBeenCalledWith('/Users/me/proj', 'docs/report.pdf');
    expect(useUiStore.getState().pendingFileOpen).toBe(null);
    expect(useUiStore.getState().pendingFileChooser).toBe(null);
  });

  it('Reveal calls provider.reveal and closes', () => {
    render(<FileOpenChooser />);
    openChooser();
    fireEvent.click(screen.getByText(/Reveal in/));
    expect(providerMocks.reveal).toHaveBeenCalledWith('/Users/me/proj', 'docs/report.pdf');
    expect(useUiStore.getState().pendingFileChooser).toBe(null);
  });

  it('Cancel closes without dispatching any action', () => {
    render(<FileOpenChooser />);
    openChooser();
    fireEvent.click(screen.getByText('Cancel'));
    expect(useUiStore.getState().pendingFileChooser).toBe(null);
    expect(useUiStore.getState().pendingFileOpen).toBe(null);
    expect(providerMocks.openExternal).not.toHaveBeenCalled();
    expect(providerMocks.reveal).not.toHaveBeenCalled();
  });

  it('Escape closes the chooser', () => {
    render(<FileOpenChooser />);
    openChooser();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().pendingFileChooser).toBe(null);
  });

  it('clicking outside closes the chooser', () => {
    render(<FileOpenChooser />);
    openChooser();
    fireEvent.mouseDown(document.body);
    expect(useUiStore.getState().pendingFileChooser).toBe(null);
  });

  it('disables external actions when no project path is known', () => {
    render(<FileOpenChooser />);
    openChooser('orphan.pdf', '');
    expect(screen.getByText('Open with default app')).toBeDisabled();
    expect(screen.getByText(/Reveal in/)).toBeDisabled();
    expect(screen.getByText('Open in app')).not.toBeDisabled();
  });
});
