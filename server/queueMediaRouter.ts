// queueMediaRouter.ts — POST /api/queue-media: a video for a prompt (Oct 27 2026).
//
// A phone attaches a screen recording or a camera clip to a message. A photo rides
// the prompt as a base64 data URL (POST /api/queue-images) because the shared queue
// can carry a few MB of them; a video can't, so its raw bytes are streamed to disk
// here, next to the prompt images, under the same `queue-img-<ms>-<random>.<ext>`
// name. That keeps every existing rule: the id shape (`isQueueImageId`), the lookup
// by id (`resolveQueueImage`) and apiRouter's 24 h sweep of the folder. The phone
// puts the answered path in the message text, so a sent or a queued prompt types it
// as it would a photo's path. Claude Code and Codex can't watch a video: they get
// the file's path and decide what to do with it.
//
// The body is streamed, never buffered, and cut off at the cap: a 100 MB clip never
// sits in memory, and a body that outgrows the cap leaves no partial file behind.

import { Router, type Request, type Response } from 'express';
import { createWriteStream, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { Transform, type TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { QUEUE_IMAGES_DIR } from './queueImages.js';
import log from './logger.js';

/** A minute or two of phone video; a bigger one is better shared another way. */
export const MAX_QUEUE_MEDIA_BYTES = 100 * 1024 * 1024;

/** The video types a phone records or picks, and the extension each is saved under. */
export const QUEUE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
};

export interface QueueMediaRouterOptions {
  /** Where the file goes; the prompt images' folder by default. */
  dir?: string;
  /** The size cap in bytes; {@link MAX_QUEUE_MEDIA_BYTES} by default. */
  maxBytes?: number;
}

class TooLargeError extends Error {}

/** Passes bytes through, and fails once more than `max` have gone by. */
function byteCap(max: number): Transform & { bytes: () => number } {
  let seen = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback) {
      seen += chunk.length;
      if (seen > max) done(new TooLargeError('too large'));
      else done(null, chunk);
    },
  });
  return Object.assign(cap, { bytes: () => seen });
}

function mediaType(req: Request): string | null {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return Object.hasOwn(QUEUE_MEDIA_TYPES, type) ? type : null;
}

function refuse(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ ok: false, code, error });
}

export function createQueueMediaRouter(options: QueueMediaRouterOptions = {}): Router {
  const dir = options.dir ?? QUEUE_IMAGES_DIR;
  const maxBytes = options.maxBytes ?? MAX_QUEUE_MEDIA_BYTES;
  const router = Router();

  router.post('/queue-media', async (req: Request, res: Response) => {
    const type = mediaType(req);
    if (!type) {
      refuse(res, 415, 'unsupported_type', 'Only MP4, MOV, M4V and WebM videos can be attached');
      req.resume();
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      refuse(res, 413, 'too_large', 'That video is too large to attach');
      req.resume();
      return;
    }

    try { mkdirSync(dir, { recursive: true }); } catch { /* the write below says why */ }
    const name = `queue-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${QUEUE_MEDIA_TYPES[type]}`;
    const path = join(dir, name);
    const cap = byteCap(maxBytes);
    try {
      await pipeline(req, cap, createWriteStream(path, { flags: 'wx' }));
    } catch (err) {
      rmSync(path, { force: true });
      if (err instanceof TooLargeError) {
        refuse(res, 413, 'too_large', 'That video is too large to attach');
        req.resume();
        return;
      }
      log.warn('queue-media', `Upload failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) refuse(res, 500, 'failed', 'The video could not be saved');
      return;
    }
    if (cap.bytes() === 0) {
      rmSync(path, { force: true });
      refuse(res, 400, 'empty', 'The video was empty');
      return;
    }
    res.json({ ok: true, path, id: name, bytes: cap.bytes() });
  });

  return router;
}
