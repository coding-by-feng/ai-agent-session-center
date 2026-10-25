import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { setFileSystemProvider, type FileSystemProvider } from '@/lib/fileSystemProvider';

vi.mock('./PdfViewer', () => ({ default: ({ src }: { src: string }) => <div data-testid="pdf" data-src={src} /> }));
import ProjectTab from './ProjectTab';

// A PDF used to be fetched into a blob: URL whose lifetime the tab cache owned.
// When that URL stopped being readable, pdf.js failed with "Unexpected server
// response (0) while retrieving PDF blob:…". It now gets the stream URL, as
// video, audio and the phone viewer do.
describe('ProjectTab — PDF source', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    localStorage.clear();
    const provider = {
      readFile: vi.fn(async (_root: string, rel: string) => ({ path: rel, name: 'r3.pdf', streamable: true, ext: 'pdf', size: 900 })),
      streamUrl: (root: string, rel: string) => `/api/files/stream?${new URLSearchParams({ root, path: rel })}`,
    };
    setFileSystemProvider(new Proxy(provider as unknown as FileSystemProvider, {
      get: (t, k) => (k in t ? (t as never)[k] : vi.fn(async () => ({ path: '', items: [], results: [], indexing: false, matches: [] }))),
    }));
  });

  it('hands the PDF viewer the stream URL and makes no blob copy', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    URL.createObjectURL = createObjectURL;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const view = render(<MemoryRouter><ProjectTab projectPath="/p" initialPath="docs/r3.pdf" initialIsFile /></MemoryRouter>);
    await waitFor(() => expect(view.getByTestId('pdf')).toHaveAttribute('data-src', '/api/files/stream?root=%2Fp&path=docs%2Fr3.pdf'));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
