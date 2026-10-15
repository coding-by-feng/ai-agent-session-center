// cloudReadLog.ts — when the Mac last read AASC Cloud for a phone, and what went wrong (AASC-51).
//
// The phone's Cloud row shows a "last sync" and a sync problem. The Mac's server
// keeps no notes or resources of its own, so the only reads it can speak for are
// the ones it makes for phones: the skill-note favourites (skillNoteFavorites.ts)
// and the cloud browse (phoneCloud.ts). Both report here, per account, so the
// answer follows whichever ran last. Another account starts from nothing.

import type { CloudConnection } from '../cloud/types.js';

/** Which account a read belongs to: a reconnect to another account never inherits the old one's state. */
export function cloudIdentity(connection: CloudConnection | null | undefined): string | null {
  return connection ? JSON.stringify([connection.backendOrigin, connection.accountId, connection.generation]) : null;
}

/** The machine code of a failed read (a CloudError's `code`), or 'offline' for anything else. */
export function readFailureCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'offline';
}

export interface CloudReadView {
  lastSuccessAt: number | null;
  /** The last failed read, only when it came after the last good one. */
  failure: { at: number; code: string } | null;
}

export interface CloudReadLog {
  succeeded(identity: string): void;
  failed(identity: string, code: string): void;
  view(identity: string): CloudReadView;
}

const NOTHING: CloudReadView = Object.freeze({ lastSuccessAt: null, failure: null });

export function createCloudReadLog(now: () => number = Date.now): CloudReadLog {
  let entry: { identity: string; view: CloudReadView } | null = null;
  const current = (identity: string): CloudReadView => (entry?.identity === identity ? entry.view : NOTHING);
  return {
    succeeded(identity) {
      entry = { identity, view: { lastSuccessAt: now(), failure: null } };
    },
    failed(identity, code) {
      entry = { identity, view: { ...current(identity), failure: { at: now(), code } } };
    },
    view: current,
  };
}
