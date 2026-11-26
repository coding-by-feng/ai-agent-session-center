// test/terminalFilesRouter.test.ts — POST /api/terminal-files (Nov 26 2026): a file pasted into, or picked for, a
// terminal is streamed to this machine under its own (made-safe) name, and the answered path is typed at the prompt.
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join, basename, dirname } from 'path';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, existsSync } from 'fs';
import {
  createTerminalFilesRouter,
  safeFileName,
  sweepTerminalFiles,
  TERMINAL_FILE_TTL_MS,
} from '../server/terminalFilesRouter.js';

let server: Server;
let baseUrl = '';
let dir = '';
const SMALL_CAP = 64;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aasc-terminal-files-'));
  const app = express();
  // The real server's global JSON parser runs first; a file body must reach the router untouched.
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', createTerminalFilesRouter({ dir }));
  app.use('/small', createTerminalFilesRouter({ dir, maxBytes: SMALL_CAP }));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
});

const post = (path: string, body: BodyInit | null, name: string | null, type = 'application/octet-stream') =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': type, ...(name === null ? {} : { 'X-File-Name': encodeURIComponent(name) }) },
  });

describe('POST /api/terminal-files', () => {
  it('saves the file under its own name, in a folder of its own, and answers the path', async () => {
    const bytes = Buffer.from('%PDF-1.7 fake');
    const res = await post('/api/terminal-files', bytes, 'report.pdf');
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; path: string; bytes: number };
    expect(json.ok).toBe(true);
    expect(basename(json.path)).toBe('report.pdf');
    expect(dirname(dirname(json.path))).toBe(dir);
    expect(json.bytes).toBe(bytes.length);
    expect(readFileSync(json.path)).toEqual(bytes);
  });

  it('two files with the same name never overwrite each other', async () => {
    const a = await (await post('/api/terminal-files', Buffer.from('one'), 'notes.txt')).json() as { path: string };
    const b = await (await post('/api/terminal-files', Buffer.from('two'), 'notes.txt')).json() as { path: string };
    expect(a.path).not.toBe(b.path);
    expect(readFileSync(a.path, 'utf8')).toBe('one');
    expect(readFileSync(b.path, 'utf8')).toBe('two');
  });

  it('a JSON file is saved as bytes, not parsed by the server', async () => {
    const res = await post('/api/terminal-files', Buffer.from('{"a":1}'), 'data.json');
    const json = await res.json() as { path: string };
    expect(readFileSync(json.path, 'utf8')).toBe('{"a":1}');
  });

  it('a name with a path in it cannot leave the folder', async () => {
    const res = await post('/api/terminal-files', Buffer.from('x'), '../../etc/passwd');
    const json = await res.json() as { path: string };
    expect(dirname(dirname(json.path))).toBe(dir);
    expect(basename(json.path)).toBe('passwd');
  });

  it('refuses a body over the cap and leaves nothing behind', async () => {
    const res = await post('/small/terminal-files', Buffer.alloc(SMALL_CAP + 1, 1), 'big.bin');
    expect(res.status).toBe(413);
    expect((await res.json() as { code: string }).code).toBe('too_large');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses an empty file and leaves nothing behind', async () => {
    const res = await post('/api/terminal-files', Buffer.alloc(0), 'empty.txt');
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('empty');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a request without a file name', async () => {
    const res = await post('/api/terminal-files', Buffer.from('x'), null);
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('no_name');
  });

  it('refuses any body type but raw bytes', async () => {
    const res = await post('/api/terminal-files', Buffer.from('{}'), 'a.json', 'application/json');
    expect(res.status).toBe(415);
  });
});

describe('safeFileName', () => {
  it('keeps an ordinary name and its extension', () => {
    expect(safeFileName('report.pdf')).toBe('report.pdf');
    expect(safeFileName('截图 2026.png')).toBe('截图-2026.png');
  });

  it('turns spaces and shell characters into dashes, so the typed path needs no quoting', () => {
    expect(safeFileName("Screen Shot (1) 'final'.png")).toBe('Screen-Shot-1-final.png');
    expect(safeFileName('a;b|c$d`e&f.txt')).toBe('a-b-c-d-e-f.txt');
  });

  it('drops any folder part and leading dots', () => {
    expect(safeFileName('../../x.txt')).toBe('x.txt');
    expect(safeFileName('C:\\Users\\me\\y.txt')).toBe('y.txt');
    expect(safeFileName('.env')).toBe('env');
  });

  it('falls back to "file" when nothing usable is left', () => {
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName('$$$')).toBe('file');
  });

  it('caps a long name but keeps its extension', () => {
    const name = safeFileName(`${'a'.repeat(300)}.tar.gz`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith('.gz')).toBe(true);
  });
});

describe('sweepTerminalFiles', () => {
  it('removes upload folders older than the lifetime and keeps newer ones', () => {
    const old = join(dir, 'old');
    const fresh = join(dir, 'fresh');
    mkdirSync(old);
    mkdirSync(fresh);
    const now = Date.now();
    const past = (now - TERMINAL_FILE_TTL_MS - 60_000) / 1000;
    utimesSync(old, past, past);
    sweepTerminalFiles(dir, now);
    expect(existsSync(old)).toBe(false);
    expect(statSync(fresh).isDirectory()).toBe(true);
  });

  it('does nothing when the folder does not exist yet', () => {
    expect(() => sweepTerminalFiles(join(dir, 'missing'), Date.now())).not.toThrow();
  });
});
