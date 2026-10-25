// internalAuth.ts — the /api token the loopback client (client.ts) carries.
//
// With no dashboard password, /api admits any loopback caller and the client sends no token. With
// one, every /api request needs a session token, so the server signs itself in: one token, kept
// and replaced shortly before it expires. It lives only in this process's memory; a central never
// sees it, so with a password set /mcp is its only way into AASC.

import { createToken, getTokenTTL, isPasswordEnabled } from '../authManager.js';

/**
 * Replace the token when it has less than this long to live, so a call that starts just before
 * the end is not refused halfway. `getTokenTTL` counts milliseconds.
 */
const MIN_REMAINING_MS = 60_000;

let cachedToken: string | null = null;

/**
 * The token to send to /api, or null when no dashboard password is set (nothing to send).
 *
 * It is a plain sign-in on purpose. A token minted with a device id (`createToken('some-id')`)
 * counts as a paired phone: the phone profile (`phoneOf` in server/index.ts) then refuses every
 * route outside its short allow-list (RESOURCES and room edits among them) and holds the rest to
 * a phone's limits.
 */
export function internalAuthToken(): string | null {
  if (!isPasswordEnabled()) return null;
  if (cachedToken === null || getTokenTTL(cachedToken) < MIN_REMAINING_MS) {
    cachedToken = createToken();
  }
  return cachedToken;
}
