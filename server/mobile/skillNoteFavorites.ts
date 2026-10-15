// skillNoteFavorites.ts — the phone's read of the user's skill notes, through the Mac (AASC-20, M9).
//
// A phone has no skill notes of its own: they live in the desktop's browser
// (IndexedDB) and, when the cloud connection is on, in the account's notes on
// the backend. The Mac's server holds no copy of its own, so the only source it
// can read is that cloud connection: it pulls the account's notes the same way
// the cloud alias review does (`GET /v1/skill-notes`, paged) and keeps them for
// a minute. With no connection (or before the first pull succeeds) the answer is
// an empty list, `source: 'none'`, and the phone ranks commands without notes.
//
// What leaves the Mac is the narrowest useful shape: `{ key, fav, tags, abbr }`
// per note, keyed `agent:name`. Never a path, a description, a version, the tag
// history or the `cli` flag, and nothing about the connection itself.

import { Router, type Request, type Response } from 'express';
import { NotesPullResultSchema, type NoteRecord } from '../../src/types/skillNotesSync.js';
import type { CloudConnector } from '../cloud/types.js';

/** One note as a phone sees it. Exactly these four fields. */
export interface PhoneSkillNote {
  key: string;
  fav: boolean;
  tags: string[];
  abbr: string | null;
}

export interface PhoneSkillNotes {
  /** Where the notes came from: the cloud connection, or nowhere (no connection). */
  source: 'cloud' | 'none';
  entries: PhoneSkillNote[];
}

/** How long one pull answers every phone. */
export const FAVORITES_TTL_MS = 60_000;
/** Bounds on one pull: pages of 100, and the entries one answer carries. */
export const FAVORITES_MAX_PAGES = 50;
export const FAVORITES_MAX_ENTRIES = 1000;

const NONE: PhoneSkillNotes = Object.freeze({ source: 'none', entries: [] }) as PhoneSkillNotes;

/** The four fields of a live note, or null for a deleted or empty one. */
export function toPhoneNote(record: NoteRecord): PhoneSkillNote | null {
  if (record.deleted) return null;
  const { fav, tags, abbr } = record.value;
  if (!fav && tags.length === 0 && !abbr) return null;
  return { key: record.key, fav, tags: [...tags], abbr: abbr ?? null };
}

/** Favourites first, then notes with an abbreviation, then the rest; by key inside each. */
export function rankPhoneNotes(notes: readonly PhoneSkillNote[]): PhoneSkillNote[] {
  const rank = (n: PhoneSkillNote) => (n.fav ? 0 : n.abbr ? 1 : 2);
  return [...notes].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}

export interface SkillNoteFavoritesDeps {
  cloud: CloudConnector | null;
  now?: () => number;
  ttlMs?: number;
}

export interface SkillNoteFavorites {
  read(): Promise<PhoneSkillNotes>;
}

export function createSkillNoteFavorites(deps: SkillNoteFavoritesDeps): SkillNoteFavorites {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? FAVORITES_TTL_MS;
  let cached: { identity: string; at: number; value: PhoneSkillNotes } | null = null;
  let inflight: { identity: string; promise: Promise<PhoneSkillNotes> } | null = null;

  /** Which account a pull belongs to: a reconnect to another account never sees the old notes. */
  function identityOf(cloud: CloudConnector): string | null {
    const c = cloud.status().connection;
    return c ? JSON.stringify([c.backendOrigin, c.accountId, c.generation]) : null;
  }

  async function pull(cloud: CloudConnector): Promise<PhoneSkillNotes> {
    const latest = new Map<string, NoteRecord>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < FAVORITES_MAX_PAGES; page++) {
      const raw = await cloud.client.request(
        'GET',
        `/v1/skill-notes?limit=100${cursor ? `&since=${encodeURIComponent(cursor)}` : ''}`,
      );
      const parsed = NotesPullResultSchema.safeParse(raw);
      if (!parsed.success) throw new Error('invalid notes page');
      for (const record of parsed.data.records) {
        const old = latest.get(record.key);
        if (!old || old.version < record.version) latest.set(record.key, record);
      }
      if (!parsed.data.hasMore || seen.has(parsed.data.cursor)) break;
      seen.add(parsed.data.cursor);
      cursor = parsed.data.cursor;
    }
    const entries = [...latest.values()].map(toPhoneNote).filter((n): n is PhoneSkillNote => n !== null);
    return { source: 'cloud', entries: rankPhoneNotes(entries).slice(0, FAVORITES_MAX_ENTRIES) };
  }

  return {
    async read() {
      const cloud = deps.cloud;
      if (!cloud) return NONE;
      const identity = identityOf(cloud);
      if (!identity) return NONE;
      const fresh = cached && cached.identity === identity && now() - cached.at < ttl;
      if (fresh && cached) return cached.value;
      // Offline or revoked: the last pull of this account still answers; a first pull can't happen.
      if (cloud.status().state !== 'connected') {
        return cached && cached.identity === identity ? cached.value : NONE;
      }
      if (inflight && inflight.identity === identity) return inflight.promise;
      const promise = pull(cloud)
        .then((value) => {
          if (identityOf(cloud) === identity) cached = { identity, at: now(), value };
          return identityOf(cloud) === identity ? value : NONE;
        })
        .catch(() => (cached && cached.identity === identity ? cached.value : NONE))
        .finally(() => {
          if (inflight?.promise === promise) inflight = null;
        });
      inflight = { identity, promise };
      return promise;
    },
  };
}

/**
 * `GET /api/skill-notes/favorites`. Mounted inside `/api`, after authMiddleware
 * and the phone profile (which opens it to paired phones as a GET). Read-only:
 * every other method or sub-path falls through to the API router's 404.
 */
export function createSkillNoteFavoritesRouter(favorites: SkillNoteFavorites): Router {
  const router = Router();
  router.get('/skill-notes/favorites', async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      const value = await favorites.read();
      res.json({
        source: value.source,
        entries: value.entries.map(({ key, fav, tags, abbr }) => ({ key, fav, tags, abbr })),
      });
    } catch {
      res.json(NONE);
    }
  });
  return router;
}
