/**
 * @module windowRole
 * What kind of window this renderer is: the dashboard, or one of the pop-outs the
 * Electron shell and the browser open with `?popout=<kind>`.
 *
 * Two decisions hang off it. `main.tsx` picks what to render, and the rule that
 * matters there is the one for a kind it does not know: render a notice, never the
 * dashboard — a second dashboard in a second window runs a second queue scheduler,
 * and every queued prompt is sent twice. And `useWebSocket` asks `isPopoutWindow()`
 * before doing the things only the main window may do (relaunching pinned sessions,
 * rewriting the room list), because every pop-out connects through the same hook.
 *
 * Import-free, so it is readable from the eager entry chunk and testable on its own.
 */

/** The pop-outs `main.tsx` has a view for. Add a kind here and a branch there together. */
export const POPOUT_KINDS = ['terminal', 'project', 'session', 'queue'] as const;
export type PopoutKind = (typeof POPOUT_KINDS)[number];

export type WindowRole =
  | { role: 'dashboard' }
  | { role: 'popout'; kind: PopoutKind }
  | { role: 'unknown-popout'; kind: string };

const isKnownKind = (kind: string): kind is PopoutKind =>
  (POPOUT_KINDS as readonly string[]).includes(kind);

function currentSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search;
}

/** Decide the role from a query string (`window.location.search`). */
export function resolveWindowRole(search: string = currentSearch()): WindowRole {
  const kind = new URLSearchParams(search).get('popout');
  // An empty `popout=` is what an absent one looks like to the app: the dashboard.
  if (!kind) return { role: 'dashboard' };
  return isKnownKind(kind) ? { role: 'popout', kind } : { role: 'unknown-popout', kind };
}

/** True in any pop-out window, including one of a kind this build does not know. */
export function isPopoutWindow(search: string = currentSearch()): boolean {
  return resolveWindowRole(search).role !== 'dashboard';
}
