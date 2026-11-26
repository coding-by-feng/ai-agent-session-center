// terminalFilesRouter.ts — POST /api/terminal-files: a file for a terminal's prompt (Nov 26 2026).
//
// The terminal used to upload only pasted images (POST /api/queue-images, base64, `queue-img-…` names). Any file
// can now be pasted (files copied in Finder, a screenshot) or picked with the toolbar's 📎. Each one is streamed
// here, raw, and saved under its own name, made safe, in a folder of its own, so two `notes.txt` never collide and
// the agent sees a name that means something. The browser types the answered path at the prompt. The CLI runs on
// this machine (a local or hosted shell), so the path is real for it; a terminal SSH'd to another host never gets
// here (the browser refuses first).
//
// The body is streamed and cut off at the cap, like /api/queue-media. It must be `application/octet-stream`: the
// server's global JSON parser would otherwise swallow a pasted `.json` file. The folder belongs to this user
// (mode 0700, uid in its name): another account's AASC on the same host neither reads nor blocks it.

import { Router, type Request, type Response } from 'express';
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { byteCap, TooLargeError } from './queueMediaRouter.js';
import log from './logger.js';

/** Per file. A bigger one is better copied over another way. */
export const MAX_TERMINAL_FILE_BYTES = 100 * 1024 * 1024;
/** How long an upload is kept: the same day as the prompt images. */
export const TERMINAL_FILE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 120;
const MAX_EXTENSION_LENGTH = 16;

/** `/tmp/claude-terminal-files-<uid>` (short, so the typed path stays readable); the OS temp folder on Windows. */
export function defaultTerminalFilesDir(): string {
  if (process.platform === 'win32') return join(tmpdir(), 'claude-terminal-files');
  return `/tmp/claude-terminal-files-${process.getuid?.() ?? 'user'}`;
}

/**
 * A name that is one path segment and needs no shell quoting: no folder part, no leading dot, whitespace and shell
 * characters as `-`. Letters of any script are kept. The extension survives the length cap.
 */
export function safeFileName(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? '';
  const name = last
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\s'"`$&;|<>()*?[\]{}!#~%^=,@+:]/g, '-')
    .replace(/-+/g, '-')
    .replace(/-*\.-*/g, '.')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '');
  if (!name) return 'file';
  if (name.length <= MAX_NAME_LENGTH) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= MAX_EXTENSION_LENGTH ? name.slice(dot) : '';
  return name.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
}

/** Remove upload folders older than {@link TERMINAL_FILE_TTL_MS}. Never throws. */
export function sweepTerminalFiles(dir: string, now: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      if (now - statSync(path).mtimeMs > TERMINAL_FILE_TTL_MS) rmSync(path, { recursive: true, force: true });
    } catch { /* gone already, or not ours to remove */ }
  }
}

export interface TerminalFilesRouterOptions {
  dir?: string;
  maxBytes?: number;
}

function refuse(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ ok: false, code, error });
}

function fileName(req: Request): string | null {
  const header = req.headers['x-file-name'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  try {
    return safeFileName(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

export function createTerminalFilesRouter(options: TerminalFilesRouterOptions = {}): Router {
  const dir = options.dir ?? defaultTerminalFilesDir();
  const maxBytes = options.maxBytes ?? MAX_TERMINAL_FILE_BYTES;
  const router = Router();

  if (!options.dir) {
    const timer = setInterval(() => sweepTerminalFiles(dir, Date.now()), 60 * 60 * 1000);
    timer.unref();
  }

  router.post('/terminal-files', async (req: Request, res: Response) => {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/octet-stream') {
      refuse(res, 415, 'unsupported_type', 'Send the file as application/octet-stream');
      req.resume();
      return;
    }
    const name = fileName(req);
    if (!name) {
      refuse(res, 400, 'no_name', 'The file has no name');
      req.resume();
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      refuse(res, 413, 'too_large', 'That file is too large to attach');
      req.resume();
      return;
    }

    sweepTerminalFiles(dir, Date.now());
    const folder = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const path = join(folder, name);
    const cap = byteCap(maxBytes);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      mkdirSync(folder, { mode: 0o700 });
      await pipeline(req, cap, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
      rmSync(folder, { recursive: true, force: true });
      if (err instanceof TooLargeError) {
        refuse(res, 413, 'too_large', 'That file is too large to attach');
        req.resume();
        return;
      }
      log.warn('terminal-files', `Upload failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) refuse(res, 500, 'failed', 'The file could not be saved');
      return;
    }
    if (cap.bytes() === 0) {
      rmSync(folder, { recursive: true, force: true });
      refuse(res, 400, 'empty', 'The file was empty');
      return;
    }
    res.json({ ok: true, path, bytes: cap.bytes() });
  });

  return router;
}
