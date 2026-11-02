/**
 * edition.ts — which desktop version this bundle is, and what Lite keeps.
 *
 * Full and Lite are one codebase and two builds: `vite.config.lite.ts` defines
 * `__AASC_EDITION__` as 'lite', and nothing else about the code differs. Absent (tests,
 * harnesses, anything the server imports) reads as Full.
 *
 * IS_LITE stays a build-time constant so Rollup can drop what Lite leaves out
 * (`scripts/verify-lite-bundle.mjs` fails the build if it doesn't). Lite hides features: it
 * turns none off. The server, its routes and the queue scheduler run the same in both.
 *
 * The lists are allow-lists on purpose: a new tab, setting or shortcut shows in Full only,
 * until someone decides it belongs in Lite.
 *
 * A phone paired to Lite loads its screens from this same bundle and keeps all of them, so a
 * check in a component a phone also renders must exempt it (see TerminalContainer).
 */
export const IS_LITE: boolean = typeof __AASC_EDITION__ === 'string' && __AASC_EDITION__ === 'lite';

export const APP_DISPLAY_NAME = IS_LITE ? 'AI Agent Session Center Lite' : 'AI Agent Session Center';

/** The top tabs Lite shows. HISTORY is how a user reopens an old session. */
export const LITE_NAV_ROUTES: ReadonlySet<string> = new Set(['/', '/history']);

/** The Settings tabs Lite shows. */
export const LITE_SETTINGS_TABS: ReadonlySet<string> = new Set(['appearance', 'sound', 'translation']);

/**
 * The session tabs Lite shows, in its order (TERMINAL first). A session with no terminal, such as a
 * `claude` started in iTerm, has nothing else to read: it gets CONVERSATION.
 */
export function liteSessionTabs<T extends { id: string }>(tabs: readonly T[], hasTerminal = true): T[] {
  const ids = ['terminal', ...(hasTerminal ? [] : ['conversation']), 'project', 'aiPopups', 'queue'];
  return ids.flatMap((id) => tabs.filter((tab) => tab.id === id));
}

const LITE_SHORTCUTS: ReadonlySet<string> = new Set([
  'toggleFullscreen', 'scrollToBottom', 'terminalToggleAutoScroll',
  'switchLatestSession', 'jumpToSession', 'switchTabProject', 'switchTabTerminal', 'switchTabQueue',
  // An AI popup window's keys, named on its buttons. Only a focused window reacts.
  'floatMinimize', 'floatMaximize', 'floatClose',
]);

/** Whether a keyboard action exists in Lite: only those that reach something Lite shows. */
export function liteAllowsShortcut(actionId: string): boolean {
  return LITE_SHORTCUTS.has(actionId)
    || /^switchSession\d$/.test(actionId)
    || actionId.startsWith('fileBrowser');
}
