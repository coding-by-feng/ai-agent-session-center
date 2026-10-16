// folderRouter.ts — GET /api/folders: the folders in a folder under the home folder (AASC-54).
//
// The phone's folder browser (Sessions → New session → Browse): names only, no files, no hidden or
// private folders, capped (homeFolders.ts). The route applies those rules to every caller, the Mac
// included, so it never depends on the phone profile in front of it; the profile checks the same path
// with its own `folders` rule. Read-only, and it never reads or reveals a session.

import { Router, type Request, type Response } from 'express';
import { homedir } from 'os';
import { listFolders } from './homeFolders.js';

const one = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '');

/** The longest `path` the route takes (the launch route's own limit). */
const MAX_PATH_LENGTH = 1024;

export interface FolderRouterOptions {
  home?: string;
}

export function createFolderRouter({ home }: FolderRouterOptions = {}): Router {
  const router = Router();
  router.get('/folders', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const requested = one(req.query.path);
    const listing = requested.length <= MAX_PATH_LENGTH ? await listFolders(requested, home ?? homedir()) : null;
    if (!listing) {
      res.status(404).json({ success: false, error: 'This folder can’t be browsed from here' });
      return;
    }
    res.json({ success: true, data: listing });
  });
  return router;
}
