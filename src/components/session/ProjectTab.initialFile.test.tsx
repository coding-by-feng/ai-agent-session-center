import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ProjectTab from './ProjectTab';
import { setFileSystemProvider, type FileSystemProvider } from '@/lib/fileSystemProvider';

// The detached Project window persists its own file tabs (persistId
// browser-<path>). Before preferInitialFile, those saved tabs always won on
// mount, so ?file= from the Detach button was ignored on every detach after
// the first.
describe('ProjectTab — preferInitialFile', () => {
  let readFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    localStorage.clear();
    readFile = vi.fn(async (_root: string, rel: string) => ({ path: rel, name: rel, content: `// ${rel}`, ext: 'ts' }));
    const provider = new Proxy({ readFile } as unknown as FileSystemProvider, {
      get: (t, k) => (k in t ? (t as never)[k] : vi.fn(async () => ({ path: '', items: [], results: [], indexing: false, matches: [] }))),
    });
    setFileSystemProvider(provider);
    localStorage.setItem('agent-manager:file-tabs:browser-/p', JSON.stringify({
      tabs: [{ path: 'old.ts', name: 'old.ts' }], active: 'old.ts',
    }));
  });

  it('opens the passed file instead of the saved one, keeping the saved tabs', async () => {
    render(<MemoryRouter><ProjectTab projectPath="/p" persistId="browser-/p" initialPath="src/new.ts" initialIsFile preferInitialFile /></MemoryRouter>);
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('agent-manager:file-tabs:browser-/p') ?? '{}');
      expect(saved.active).toBe('src/new.ts');
      expect(saved.tabs.map((t: { path: string }) => t.path)).toEqual(['old.ts', 'src/new.ts']);
    });
    expect(readFile.mock.calls.map((c) => c[1])).toEqual(['src/new.ts']);
  });

  it('without it, saved tabs still win (docked sub-tabs keep the old rule)', async () => {
    render(<MemoryRouter><ProjectTab projectPath="/p" persistId="browser-/p" initialPath="src/new.ts" initialIsFile /></MemoryRouter>);
    await waitFor(() => expect(readFile).toHaveBeenCalled());
    expect(readFile.mock.calls.map((c) => c[1])).toEqual(['old.ts']);
  });
});
