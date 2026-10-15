// queueImages.ts — where uploaded prompt images live, and how a request names one (AASC-42).
//
// POST /api/queue-images saves each image as `queue-img-<ms>-<random>.<ext>` here
// and answers with the paths and their ids (the file names). A prompt sent through
// the Mac (POST /api/sessions/:id/prompt) names its images by id only; the server
// turns an id back into the path it types, so a request can never point the CLI at
// another file.

import { statSync } from 'fs';
import { basename, join } from 'path';

export const QUEUE_IMAGES_DIR = '/tmp/claude-queue-images';

/** The exact shape of a saved image's file name. */
const QUEUE_IMAGE_ID_RE = /^queue-img-\d{1,16}-[a-z0-9]{1,12}\.[A-Za-z0-9_]{1,10}$/;

export function isQueueImageId(id: string): boolean {
  return QUEUE_IMAGE_ID_RE.test(id);
}

/** The id of a saved image: its file name. */
export function queueImageId(path: string): string {
  return basename(path);
}

/** The path of a saved image that still exists, or null (a malformed id, or swept after 24 h). */
export function resolveQueueImage(id: string, dir: string = QUEUE_IMAGES_DIR): string | null {
  if (!isQueueImageId(id)) return null;
  const path = join(dir, id);
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}
