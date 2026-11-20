// afterDelete.ts — what this Mac does when the browser comes back from "Delete my account" (plan 18).
//
// The backend deleted the account the person picked in the browser, which may not be the account
// this Mac is connected to, and the return does not say which. So the Mac asks about its own
// connection: only the backend refusing this Mac's own token (the connection turns `revoked`) means
// its account is gone, and only then is the saved connection forgotten. A backend that is down,
// slow or answering something else proves nothing, and the connection is kept.

import type { AfterDelete } from './googleSignIn.js';
import type { CloudConnector } from './types.js';

export function createAfterDelete(cloud: CloudConnector): () => Promise<AfterDelete> {
  return async () => {
    if (!cloud.status().connection) return 'gone';
    try {
      await cloud.recheckCloud();
      return 'still-connected';
    } catch {
      if (cloud.status().state !== 'revoked') return 'unknown';
      await cloud.disconnectCloud().catch(() => {});
      return 'gone';
    }
  };
}
