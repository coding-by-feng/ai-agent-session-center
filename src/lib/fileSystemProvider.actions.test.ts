// The chooser's Mac-side actions throw the server's reason (Nov 17 2026); they used to swallow it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getFileSystemProvider } from './fileSystemProvider';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('file actions report refusals', () => {
  it('openExternal throws the server’s error', async () => {
    stubFetch(404, { error: 'Path not found' });
    await expect(getFileSystemProvider().openExternal('/Users/me/proj', 'x.md')).rejects.toThrow('Path not found');
  });

  it('reveal throws the server’s error, and the status when there is none', async () => {
    stubFetch(400, { error: 'Path outside project root' });
    await expect(getFileSystemProvider().reveal('/Users/me/proj', 'x.md')).rejects.toThrow('Path outside project root');
    stubFetch(500, {});
    await expect(getFileSystemProvider().reveal('/Users/me/proj', 'x.md')).rejects.toThrow('HTTP 500');
  });

  it('resolves on success and posts root + path', async () => {
    const fetchMock = stubFetch(200, { ok: true });
    await expect(getFileSystemProvider().openExternal('/Users/me/docs', 'plan.md')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/files/open-external', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ root: '/Users/me/docs', path: 'plan.md' }),
    }));
  });
});
