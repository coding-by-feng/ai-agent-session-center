/**
 * deepLink.ts — `/?session=<id>&tab=terminal|conversation` (AASC-17).
 *
 * A notification tap in the phone app opens the server's UI at this address.
 * Pure parsing only; the hook that acts on it is useSessionDeepLink.
 */

export type DeepLinkTab = 'terminal' | 'conversation';

export interface SessionDeepLink {
  sessionId: string;
  tab: DeepLinkTab;
}

/** The same shape the backend accepts as a push session reference. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseSessionDeepLink(search: string): SessionDeepLink | null {
  const params = new URLSearchParams(search);
  const sessionId = params.get('session');
  if (!sessionId || !SESSION_ID.test(sessionId)) return null;
  const tab = params.get('tab') === 'conversation' ? 'conversation' : 'terminal';
  return { sessionId, tab };
}

/** The same address without the deep-link parameters, so a reload doesn't reopen it. */
export function stripSessionDeepLink(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('session');
  url.searchParams.delete('tab');
  return `${url.pathname}${url.search}${url.hash}`;
}
