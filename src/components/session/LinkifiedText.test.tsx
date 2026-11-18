// Conversation file links go through linkTarget like the terminal's (Nov 17 2026).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { resetFileRefCacheForTest } from '@/lib/fileRefResolve';
import LinkifiedText from './LinkifiedText';
import { useUiStore } from '@/stores/uiStore';

const ROOT = '/Users/me/aasc/public/website';

beforeEach(() => useUiStore.setState({ pendingFileChooser: null }));

describe('LinkifiedText file links', () => {
  it('opens the chooser for a path outside the session folder, rooted at the file’s folder', () => {
    render(<LinkifiedText text="Written: /Users/me/aasc/private/docs/plan.md (347 lines)." projectPath={ROOT} />);
    fireEvent.click(screen.getByText('/Users/me/aasc/private/docs/plan.md'));
    expect(useUiStore.getState().pendingFileChooser).toMatchObject({
      filePath: 'plan.md',
      projectPath: '/Users/me/aasc/private/docs',
      hostProjectPath: ROOT,
    });
  });

  it('makes an absolute path inside the session folder relative to it', () => {
    render(<LinkifiedText text={`See ${ROOT}/src/a.md`} projectPath={ROOT} />);
    fireEvent.click(screen.getByText(`${ROOT}/src/a.md`));
    const chooser = useUiStore.getState().pendingFileChooser;
    expect(chooser).toMatchObject({ filePath: 'src/a.md', projectPath: ROOT });
    expect(chooser?.hostProjectPath).toBeUndefined();
  });
});

// Nov 18 2026: a folder and a bare file name link once the Mac says the path exists.
describe('LinkifiedText: folders and bare names', () => {
  const onMac: Record<string, 'file' | 'dir'> = {
    '/Users/me/exmouth/docs': 'dir',
    '/Users/me/exmouth/docs/video-series-plan.md': 'file',
  };
  beforeEach(() => {
    resetFileRefCacheForTest();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
      const url = new URL(String(input), 'http://x');
      const path = url.searchParams.get('path') ?? '';
      if (url.pathname === '/api/files/resolve' && onMac[path]) return new Response(JSON.stringify({ absolute: path, kind: onMac[path] }), { status: 200 });
      if (url.pathname === '/api/files/search') return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(JSON.stringify({ error: 'Path does not exist' }), { status: 404 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const TEXT = 'Files are in /Users/me/exmouth/docs:\n- video-series-plan.md\n- not-there.md\nand/or Node.js';

  it('the folder opens the chooser as a folder, rooted at itself', async () => {
    render(<LinkifiedText text={TEXT} projectPath={ROOT} />);
    const folder = await waitFor(() => {
      const el = screen.getByText('/Users/me/exmouth/docs');
      expect(el).toHaveAttribute('role', 'button');
      return el;
    });
    fireEvent.click(folder);
    expect(useUiStore.getState().pendingFileChooser).toMatchObject({
      kind: 'dir', projectPath: '/Users/me/exmouth/docs', filePath: '/', hostProjectPath: ROOT,
    });
  });

  it('a bare name found in that folder opens the file; one that is nowhere stays text', async () => {
    render(<LinkifiedText text={TEXT} projectPath={ROOT} />);
    const name = await waitFor(() => {
      const el = screen.getByText('video-series-plan.md');
      expect(el).toHaveAttribute('role', 'button');
      return el;
    });
    fireEvent.click(name);
    expect(useUiStore.getState().pendingFileChooser).toMatchObject({
      filePath: 'video-series-plan.md', projectPath: '/Users/me/exmouth/docs', hostProjectPath: ROOT,
    });
    expect(useUiStore.getState().pendingFileChooser?.kind).toBeUndefined();
    expect(screen.getByText('not-there.md')).not.toHaveAttribute('role');
    expect(screen.queryAllByRole('button')).toHaveLength(2);
  });
});
