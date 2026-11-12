// clientRole.ts — is this connection a dashboard or a terminal client (D10)?
//
// `aasc` declares itself with `role=cli` on the WebSocket upgrade URL, or the header
// `X-AASC-Role: cli` on any request. A CLI is never the workspace writer (presenceManager.ts):
// otherwise an `aasc --ssh` client (local) or a long `aasc watch` (the oldest connection) takes the
// role, and the real dashboards stop saving the workspace and firing the queue.
//
// The declaration is cooperative and can only take privilege away: a client that omits it is a
// dashboard, exactly as before. Nothing here grants anything.

import type { IncomingHttpHeaders } from 'http';

export type ClientRole = 'dashboard' | 'cli';

export function clientRoleOf(req: { url?: string; headers?: IncomingHttpHeaders }): ClientRole {
  const header = req.headers?.['x-aasc-role'];
  if (typeof header === 'string' && header.trim().toLowerCase() === 'cli') return 'cli';
  try {
    const role = new URL(req.url ?? '', 'http://localhost').searchParams.get('role');
    if (role === 'cli') return 'cli';
  } catch {
    /* malformed URL: a dashboard, as before */
  }
  return 'dashboard';
}
