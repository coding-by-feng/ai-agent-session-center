// test/apiRouter.openExternal.test.ts — POST /api/files/open-external
// Verifies the OS-default-app open endpoint: path validation (root allow-list,
// traversal rejection, existence check) and the platform-specific execFile
// invocation (macOS `open`, Windows `cmd /c start`, Linux `xdg-open`).
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

const execFileMock = vi.hoisted(() => vi.fn((_cmd: string, _args: string[], cb?: (err: Error | null) => void) => {
  cb?.(null);
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: execFileMock };
});

let server: Server | null = null;
let baseUrl = '';
let projectRoot = '';
let filePath = '';

beforeAll(async () => {
  projectRoot = join(tmpdir(), `aasc-open-external-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(projectRoot, { recursive: true });
  filePath = join(projectRoot, 'report.pdf');
  writeFileSync(filePath, '%PDF-1.4 test');

  const app = express();
  app.use(express.json());
  const { default: apiRouter } = await import('../server/apiRouter.js');
  app.use('/api', apiRouter);

  server = createServer(app);
  await new Promise<void>((resolveStart) => server!.listen(0, '127.0.0.1', resolveStart));
  const addr = server!.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
  rmSync(projectRoot, { recursive: true, force: true });
});

beforeEach(() => {
  execFileMock.mockClear();
});

async function postOpenExternal(body: unknown) {
  const res = await fetch(`${baseUrl}/api/files/open-external`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe('POST /api/files/open-external', () => {
  it('opens an existing file with the platform default-app command', async () => {
    const { status, json } = await postOpenExternal({ root: projectRoot, path: '/report.pdf' });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);

    const [cmd, args] = execFileMock.mock.calls[0];
    if (process.platform === 'darwin') {
      expect(cmd).toBe('open');
      expect(args).toEqual([filePath]); // no -R reveal flag
    } else if (process.platform === 'win32') {
      expect(cmd).toBe('cmd');
      expect(args).toEqual(['/c', 'start', '', filePath]);
    } else {
      expect(cmd).toBe('xdg-open');
      expect(args).toEqual([filePath]);
    }
  });

  it('rejects a missing root', async () => {
    const { status } = await postOpenExternal({ path: '/report.pdf' });
    expect(status).toBe(400);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects a blocked shallow root', async () => {
    const { status } = await postOpenExternal({ root: '/etc', path: '/passwd' });
    expect(status).toBe(400);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects path traversal outside the project root', async () => {
    const { status, json } = await postOpenExternal({ root: projectRoot, path: '/../../etc/passwd' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/outside project root/i);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns 404 for a file that does not exist', async () => {
    const { status } = await postOpenExternal({ root: projectRoot, path: '/missing.pdf' });
    expect(status).toBe(404);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
