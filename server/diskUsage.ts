// diskUsage.ts — how much room is left on the disk a session works on (Nov 26 2026), for the disk chip in the
// session panel's top-left usage line (src/components/session/DiskChip.tsx).
//
//   GET /api/sessions/:id/disk → { ok, freeBytes, totalBytes, path }
//
// The server resolves the folder from the session (its project folder, else the home folder), so a caller never
// names a path to probe. This Mac only, like /api/session-memory: another device gets 404 (a phone's profile has
// no rule for it either). A session running over SSH on another host gets 404 too: this Mac's disk says nothing
// about that host's. Free space is what `statfs` calls available to this user (`bavail`); on APFS that leaves out
// purgeable space, so Finder can show more. Readings are cached per folder for DISK_CACHE_MS.

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { Router, type Request, type Response } from 'express';
import log from './logger.js';
import { isLocalRequest } from './requestLocality.js';

export const DISK_CACHE_MS = 30_000;

export interface DiskSessionRef {
  projectPath?: string | null;
  sshHost?: string | null;
}

export interface DiskReading {
  freeBytes: number;
  totalBytes: number;
}

export interface DiskUsageDeps {
  getSession: (sessionId: string) => DiskSessionRef | null | undefined;
  /** Whether an SSH host is this machine (sshManager `isLocalSshHost`). */
  isLocalHost: (host: string | undefined) => boolean;
  isLocal?: (req: Request) => boolean;
  statfs?: (path: string) => Promise<DiskReading>;
  now?: () => number;
  home?: string;
}

async function statfsReading(path: string): Promise<DiskReading> {
  const s = await fs.statfs(path);
  return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
}

export function createDiskUsageRouter(deps: DiskUsageDeps): Router {
  const isLocal = deps.isLocal ?? isLocalRequest;
  const read = deps.statfs ?? statfsReading;
  const now = deps.now ?? Date.now;
  const home = deps.home ?? homedir();
  const cache = new Map<string, { at: number; reading: DiskReading }>();

  async function reading(path: string): Promise<DiskReading> {
    const hit = cache.get(path);
    if (hit && now() - hit.at < DISK_CACHE_MS) return hit.reading;
    const fresh = await read(path);
    if (cache.size > 200) cache.clear();
    cache.set(path, { at: now(), reading: fresh });
    return fresh;
  }

  const router = Router();
  router.get('/sessions/:id/disk', async (req: Request, res: Response) => {
    if (!isLocal(req)) { res.status(404).json({ ok: false, error: 'Not found' }); return; }
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const session = deps.getSession(id);
    if (!session) { res.status(404).json({ ok: false, error: 'Session not found' }); return; }
    if (!deps.isLocalHost(session.sshHost ?? undefined)) {
      res.status(404).json({ ok: false, error: 'The session runs on another host', reason: 'remote-host' });
      return;
    }
    const path = session.projectPath && session.projectPath.startsWith('/') ? session.projectPath : home;
    try {
      const { freeBytes, totalBytes } = await reading(path);
      res.json({ ok: true, freeBytes, totalBytes, path });
    } catch (err) {
      log.debug('disk', `statfs ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(404).json({ ok: false, error: 'Disk reading unavailable', reason: 'unreadable' });
    }
  });
  return router;
}
