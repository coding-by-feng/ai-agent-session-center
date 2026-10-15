/**
 * phoneRoutes.ts — the screens of the new phone frame (AASC-39), as paths.
 *
 *   /sessions                     Sessions tab root
 *   /sessions/<id>/chat|changes|terminal   a session, on one segment
 *   /sessions/<id>/info           its Info screen (AASC-46), and what Info opens:
 *   /sessions/<id>/info/files|notes|queue|agents|popups
 *   /inbox   /queue   /more        the other tab roots
 *   /more/<page>                  History, Prompts, Saved prompts, Review, Agenda, Settings
 *                                 (and its pages), This phone, About, UI kit
 *
 * A path is what `phoneNavStore` keeps in its stacks and what the address bar
 * shows as `?m=<path>`, so a reload or a link lands on the same screen. Pure:
 * no DOM, no store.
 *
 * Old links (`?session=<id>&tab=terminal|conversation`, src/lib/deepLink.ts) map
 * onto the session's Chat, or its Terminal when that was asked for explicitly.
 */

export const PHONE_TABS = ['sessions', 'inbox', 'queue', 'more'] as const;
export type PhoneTab = (typeof PHONE_TABS)[number];

export const SESSION_SEGMENTS = ['chat', 'changes', 'terminal'] as const;
export type SessionSegment = (typeof SESSION_SEGMENTS)[number];

export const MORE_PAGES = [
  'history', 'prompts', 'saved-prompts', 'review', 'agenda',
  'settings', 'appearance', 'notifications', 'api-keys', 'translation', 'advanced',
  'phone', 'about', 'gallery',
] as const;
export type MorePage = (typeof MORE_PAGES)[number];

/** What a session's Info screen opens (AASC-46). */
export const INFO_PAGES = ['files', 'notes', 'queue', 'agents', 'popups'] as const;
export type InfoPage = (typeof INFO_PAGES)[number];

export type PhoneRoute =
  | { kind: 'tab-root'; tab: PhoneTab }
  | { kind: 'session'; sessionId: string; segment: SessionSegment }
  /** `page` null: Info itself. */
  | { kind: 'session-info'; sessionId: string; page: InfoPage | null }
  | { kind: 'more'; page: MorePage };

/** The same shape the backend accepts as a push session reference (deepLink.ts). */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A More page reached from another More page, not from the More list itself. */
const MORE_PARENT: Partial<Record<MorePage, MorePage>> = {
  gallery: 'about',
  appearance: 'settings',
  notifications: 'settings',
  'api-keys': 'settings',
  translation: 'settings',
  advanced: 'settings',
};

const isOneOf = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

export function tabRootPath(tab: PhoneTab): string {
  return `/${tab}`;
}

export function sessionPath(sessionId: string, segment: SessionSegment = 'chat'): string {
  return `/sessions/${sessionId}/${segment}`;
}

/** A session's Info screen, or one of the screens it opens. */
export function infoPath(sessionId: string, page: InfoPage | null = null): string {
  return page ? `/sessions/${sessionId}/info/${page}` : `/sessions/${sessionId}/info`;
}

export function phonePath(route: PhoneRoute): string {
  if (route.kind === 'tab-root') return tabRootPath(route.tab);
  if (route.kind === 'session') return sessionPath(route.sessionId, route.segment);
  if (route.kind === 'session-info') return infoPath(route.sessionId, route.page);
  return `/more/${route.page}`;
}

/** The route a path names, or null for anything this frame doesn't draw. */
export function parsePhonePath(path: string): PhoneRoute | null {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  const parts = path.slice(1).split('/');
  const [head] = parts;
  if (parts.length === 1) return isOneOf(PHONE_TABS, head) ? { kind: 'tab-root', tab: head } : null;
  if (head === 'sessions' && parts.length === 3) {
    const [, sessionId, segment] = parts;
    if (!SESSION_ID.test(sessionId)) return null;
    if (segment === 'info') return { kind: 'session-info', sessionId, page: null };
    if (!isOneOf(SESSION_SEGMENTS, segment)) return null;
    return { kind: 'session', sessionId, segment };
  }
  if (head === 'sessions' && parts.length === 4 && parts[2] === 'info') {
    const [, sessionId, , page] = parts;
    if (!SESSION_ID.test(sessionId) || !isOneOf(INFO_PAGES, page)) return null;
    return { kind: 'session-info', sessionId, page };
  }
  if (head === 'more' && parts.length === 2 && isOneOf(MORE_PAGES, parts[1])) {
    return { kind: 'more', page: parts[1] };
  }
  return null;
}

/** The tab a path belongs to when nothing else says (a reload, a link). */
export function tabOfPath(path: string): PhoneTab {
  const route = parsePhonePath(path);
  if (!route) return 'sessions';
  if (route.kind === 'tab-root') return route.tab;
  return route.kind === 'more' ? 'more' : 'sessions';
}

/** The stack a link to `path` restores: its tab's root, any parent screens, then the path. */
export function pathChain(path: string): string[] {
  const route = parsePhonePath(path);
  if (!route) return [tabRootPath('sessions')];
  if (route.kind === 'tab-root') return [path];
  if (route.kind === 'session') return [tabRootPath('sessions'), path];
  if (route.kind === 'session-info') {
    // Under its session (on Chat: what a reload knows of it), and Info under its screens.
    const info = infoPath(route.sessionId);
    const base = [tabRootPath('sessions'), sessionPath(route.sessionId), info];
    return route.page ? [...base, path] : base;
  }
  const chain: string[] = [];
  for (let page: MorePage | undefined = route.page; page; page = MORE_PARENT[page]) {
    chain.unshift(`/more/${page}`);
  }
  return [tabRootPath('more'), ...chain];
}

// ---------------------------------------------------------------------------
// The address bar: ?m=<path>
// ---------------------------------------------------------------------------

export const PHONE_PATH_PARAM = 'm';

export function phonePathFromSearch(search: string): string | null {
  const path = new URLSearchParams(search).get(PHONE_PATH_PARAM);
  return path && parsePhonePath(path) ? path : null;
}

/** `href` reduced to path + query + hash, with `?m=` set to `path` (slashes left readable). */
export function withPhonePath(href: string, path: string): string {
  const url = new URL(href);
  url.searchParams.delete(PHONE_PATH_PARAM);
  const rest = url.searchParams.toString();
  const m = `${PHONE_PATH_PARAM}=${path.split('/').map(encodeURIComponent).join('/')}`;
  return `${url.pathname}?${rest ? `${rest}&` : ''}${m}${url.hash}`;
}

export function withoutPhonePath(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(PHONE_PATH_PARAM);
  const rest = url.searchParams.toString();
  return `${url.pathname}${rest ? `?${rest}` : ''}${url.hash}`;
}

// ---------------------------------------------------------------------------
// Old deep links
// ---------------------------------------------------------------------------

/**
 * `?session=<id>&tab=…` as a new-frame path. `waitsForUser(id)` says whether the
 * session is waiting on an approval or a question right now: today's shell sends
 * those taps with `tab=terminal` (mobile/shell/src/notificationTap.ts), and in the
 * new design they open the chat, where the waiting card is. A `kind=approval|input`
 * parameter says the same thing outright.
 */
export function legacyDeepLinkToPath(search: string, waitsForUser: (sessionId: string) => boolean): string | null {
  const params = new URLSearchParams(search);
  const sessionId = params.get('session');
  if (!sessionId || !SESSION_ID.test(sessionId)) return null;
  const kind = params.get('kind');
  const askedForTerminal = params.get('tab') === 'terminal'
    && kind !== 'approval' && kind !== 'input'
    && !waitsForUser(sessionId);
  return sessionPath(sessionId, askedForTerminal ? 'terminal' : 'chat');
}

/**
 * The segment a session opens on: Chat for Claude Code and Codex, Terminal for
 * anything else (a plain shell, an unknown CLI), which has no transcript (DU1).
 */
export function defaultSegment(cli: string | null): SessionSegment {
  return cli === 'claude' || cli === 'codex' ? 'chat' : 'terminal';
}
