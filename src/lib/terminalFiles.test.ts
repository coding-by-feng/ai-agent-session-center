// Files for a terminal's prompt (Nov 26 2026): each is streamed to POST /api/terminal-files and its saved path
// comes back to be typed. A terminal SSH'd to another host refuses them: the file would land on the wrong machine.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const toast = vi.fn();
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: (...a: unknown[]) => toast(...a) }));

import {
  attachTerminalFiles,
  remoteUploadRefusal,
  uploadTerminalFiles,
  MAX_TERMINAL_FILES,
  MAX_TERMINAL_FILE_BYTES,
} from './terminalFiles';

const file = (name: string, body = 'x', type = '') => new File([body], name, { type });
const ok = (path: string) => ({ ok: true, status: 200, json: async () => ({ ok: true, path }) });

beforeEach(() => toast.mockReset());

describe('uploadTerminalFiles', () => {
  it('streams each file as raw bytes with its name, and returns the saved paths in order', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok('/tmp/f/1/report.pdf'))
      .mockResolvedValueOnce(ok('/tmp/f/2/data.json'));
    const a = file('report.pdf', '%PDF', 'application/pdf');
    const b = file('data.json', '{}', 'application/json');
    const result = await uploadTerminalFiles([a, b], fetchMock);
    expect(result).toEqual({ paths: ['/tmp/f/1/report.pdf', '/tmp/f/2/data.json'], errors: [] });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/terminal-files', expect.objectContaining({
      method: 'POST',
      body: a,
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'report.pdf' },
    }));
    // A .json file is still raw bytes: the server's JSON parser must not take it.
    expect(fetchMock.mock.calls[1][1].headers['Content-Type']).toBe('application/octet-stream');
  });

  it('encodes a name that is not plain ASCII', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('/tmp/f/1/x.png'));
    await uploadTerminalFiles([file('截图 1.png')], fetchMock);
    expect(fetchMock.mock.calls[0][1].headers['X-File-Name']).toBe(encodeURIComponent('截图 1.png'));
  });

  it('skips a file over the cap without sending it, and says so', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('/tmp/f/1/small.txt'));
    const big = file('big.bin');
    Object.defineProperty(big, 'size', { value: MAX_TERMINAL_FILE_BYTES + 1 });
    const result = await uploadTerminalFiles([big, file('small.txt')], fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.paths).toEqual(['/tmp/f/1/small.txt']);
    expect(result.errors).toEqual(['big.bin is over 100 MB']);
  });

  it('sends at most the first MAX_TERMINAL_FILES files', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('/tmp/f/p'));
    const files = Array.from({ length: MAX_TERMINAL_FILES + 2 }, (_, i) => file(`f${i}.txt`));
    const result = await uploadTerminalFiles(files, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_TERMINAL_FILES);
    expect(result.errors).toEqual([`Only the first ${MAX_TERMINAL_FILES} files were attached`]);
  });

  it('reports the server\'s reason, and a network failure, per file', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ ok: false, error: 'The file was empty' }) })
      .mockRejectedValueOnce(new Error('offline'));
    const result = await uploadTerminalFiles([file('a.txt'), file('b.txt')], fetchMock);
    expect(result).toEqual({ paths: [], errors: ['a.txt: The file was empty', 'b.txt could not be uploaded'] });
  });
});

describe('remoteUploadRefusal', () => {
  it('is null for a local shell, or one SSH\'d to this machine', () => {
    expect(remoteUploadRefusal(null)).toBeNull();
    expect(remoteUploadRefusal('localhost')).toBeNull();
    expect(remoteUploadRefusal('127.0.0.1')).toBeNull();
  });

  it('names the host for a terminal SSH\'d elsewhere', () => {
    expect(remoteUploadRefusal('build.example.com')).toMatch(/build\.example\.com/);
  });
});

describe('attachTerminalFiles', () => {
  it('returns the paths and raises no toast when every file went up', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('/tmp/f/1/a.txt'));
    expect(await attachTerminalFiles([file('a.txt')], { sshHost: null, fetchImpl: fetchMock })).toEqual(['/tmp/f/1/a.txt']);
    expect(toast).not.toHaveBeenCalled();
  });

  it('refuses on a terminal SSH\'d to another host: nothing is sent, a toast says why', async () => {
    const fetchMock = vi.fn();
    expect(await attachTerminalFiles([file('a.txt')], { sshHost: 'vps.example.com', fetchImpl: fetchMock })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/vps\.example\.com/), 'warning');
  });

  it('shows each failure as one error toast and still returns what went up', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok('/tmp/f/1/a.txt'))
      .mockRejectedValueOnce(new Error('offline'));
    expect(await attachTerminalFiles([file('a.txt'), file('b.txt')], { sshHost: null, fetchImpl: fetchMock }))
      .toEqual(['/tmp/f/1/a.txt']);
    expect(toast).toHaveBeenCalledWith('b.txt could not be uploaded', 'error');
  });

  it('says it is uploading only when the upload is slow', async () => {
    vi.useFakeTimers();
    try {
      let finish: (v: ReturnType<typeof ok>) => void = () => {};
      const fetchMock = vi.fn(() => new Promise<ReturnType<typeof ok>>((r) => { finish = r; }));
      const pending = attachTerminalFiles([file('a.txt'), file('b.txt')], { sshHost: null, fetchImpl: fetchMock });
      await vi.advanceTimersByTimeAsync(400);
      expect(toast).toHaveBeenCalledWith('Uploading 2 files…', 'info');
      finish(ok('/tmp/f/1/a.txt'));
      await vi.advanceTimersByTimeAsync(0);
      finish(ok('/tmp/f/2/b.txt'));
      expect(await pending).toEqual(['/tmp/f/1/a.txt', '/tmp/f/2/b.txt']);
    } finally {
      vi.useRealTimers();
    }
  });
});
