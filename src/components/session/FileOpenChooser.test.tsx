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
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: toast }));

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

  // Nov 17 2026: both Mac-side actions used to fire and forget, so a refused path did nothing.
  it('says why when the Mac refuses to open the file', async () => {
    providerMocks.openExternal.mockRejectedValueOnce(new Error('Path not found'));
    toast.mockClear();
    render(<FileOpenChooser />);
    openChooser();
    fireEvent.click(screen.getByText('Open with default app'));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Couldn’t open report.pdf: Path not found', 'error'));
  });

  it('says why when the Mac refuses to reveal the file', async () => {
    providerMocks.reveal.mockRejectedValueOnce(new Error('Path outside project root'));
    toast.mockClear();
    render(<FileOpenChooser />);
    openChooser();
    fireEvent.click(screen.getByText(/Reveal in/));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Couldn’t reveal report.pdf: Path outside project root', 'error'));
  });

  it('Open in app keeps the host session of a file outside its folder', () => {
    render(<FileOpenChooser />);
    act(() => {
      useUiStore.getState().openFileChooser('plan.md', '/Users/me/private/docs', { x: 1, y: 1 }, '/Users/me/proj');
    });
    fireEvent.click(screen.getByText('Open in app'));
    expect(useUiStore.getState().pendingFileOpen).toEqual({
      filePath: 'plan.md',
      projectPath: '/Users/me/private/docs',
      hostProjectPath: '/Users/me/proj',
    });
  });
});

// Nov 18 2026: a folder link (rooted at itself, filePath "/").
describe('FileOpenChooser: a folder', () => {
  beforeEach(() => {
    useUiStore.setState({ pendingFileChooser: null, pendingFileOpen: null });
    providerMocks.openExternal.mockClear();
    providerMocks.reveal.mockClear();
  });
  const openFolder = () => act(() => {
    useUiStore.getState().openFileChooser('/', '/Users/me/exmouth/docs', { x: 100, y: 100 }, '/Users/me/proj', 'dir');
  });

  it('is headed by the folder name and offers Open in app and Reveal, not a default app', () => {
    render(<FileOpenChooser />);
    openFolder();
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('Open in app')).toBeInTheDocument();
    expect(screen.queryByText('Open with default app')).toBeNull();
    expect(screen.getByText(/Reveal in/)).toBeInTheDocument();
  });

  it('Open in app asks the host session for a folder tab', () => {
    render(<FileOpenChooser />);
    openFolder();
    fireEvent.click(screen.getByText('Open in app'));
    expect(useUiStore.getState().pendingFileOpen).toEqual({
      filePath: '/', projectPath: '/Users/me/exmouth/docs', hostProjectPath: '/Users/me/proj', kind: 'dir',
    });
  });

  it('Reveal shows the folder itself', () => {
    render(<FileOpenChooser />);
    openFolder();
    fireEvent.click(screen.getByText(/Reveal in/));
    expect(providerMocks.reveal).toHaveBeenCalledWith('/Users/me/exmouth/docs', '/');
  });
});

