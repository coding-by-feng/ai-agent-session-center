/**
 * platform.ts — the ONE place that answers "is this mobile?" and "is this the
 * desktop app?", plus the rule for which question to ask.
 *
 * ## Why this exists
 *
 * Platform-divergent UI had grown three unrelated mechanisms with no rule for
 * choosing between them: ~46 responsive CSS rules across 21 style modules, an
 * ad-hoc `window.electronAPI` null check, and (most recently) a JS media query.
 * The same *category* of decision was being expressed three different ways in
 * three different files.
 *
 * ## The rule
 *
 * Pick by what the divergence actually IS:
 *
 * 1. **Platform CAPABILITY** — the feature needs something only the desktop
 *    app has (PTY host, Finder, quit, tray). Use {@link useIsDesktopApp} and
 *    unmount. Example: the Quit button, "Reveal in Finder".
 *
 * 2. **SIZE, purely visual** — padding, wrapping, font size, order. Use a CSS
 *    media query. No JS, no bundle cost, no re-render on resize.
 *
 * 3. **SIZE, and the element should NOT EXIST** — mounting it costs real work
 *    (a fetch, a subscription, event handlers, an entry in the accessibility
 *    tree), or it simply isn't a phone workflow. Use {@link useIsMobile} and
 *    unmount. Example: workspace export/import, the AGENDA tab.
 *
 * The trap that motivates keeping (1) and (3) separate: **`window.electronAPI`
 * is a capability check, not a size check.** A desktop *browser* at 1920px has
 * no `electronAPI` — treating its absence as "mobile" gives the phone layout to
 * a full-size Chrome window, which is exactly how this dashboard is used for
 * remote access and for every render check in development.
 */
import { useMediaQuery } from '@/hooks/useMediaQuery';

/**
 * The single mobile breakpoint, in px. Kept in step with the `max-width: 480px`
 * media queries in the style modules — if this moves, those move with it.
 * 480 rather than 640: 640 catches narrow desktop windows too, and dropping
 * features from a resized desktop window is not the intent.
 */
export const MOBILE_BREAKPOINT = 480;

/**
 * A phone in landscape is ~844px wide but short, and still a touch device: it
 * gets the phone layout too (AASC-17). `pointer: coarse` keeps short desktop
 * windows out of it.
 */
export const MOBILE_MEDIA_QUERY =
  `(max-width: ${MOBILE_BREAKPOINT}px), (max-height: ${MOBILE_BREAKPOINT}px) and (pointer: coarse)`;

/**
 * True on a phone-sized viewport. Use to UNMOUNT things that shouldn't exist
 * on mobile — see rule (3) above. For purely visual differences prefer a CSS
 * media query, which costs no JS and no re-render.
 */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_MEDIA_QUERY);
}

/**
 * True when running inside the Electron desktop app (the preload bridge is
 * present). A CAPABILITY check — see rule (1). Never use this to infer screen
 * size: a desktop browser returns false here at any width.
 */
export function useIsDesktopApp(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

/**
 * Non-hook form of {@link useIsDesktopApp}, for use outside render (event
 * handlers, module init). Same capability semantics.
 */
export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

// ---------------------------------------------------------------------------
// The AASC phone app (AASC-17)
// ---------------------------------------------------------------------------

/**
 * The native shell (Capacitor) appends `AASC-Mobile/<version>` (no platform suffix) to
 * its WebView user agent. A CAPABILITY check like {@link useIsDesktopApp}: the
 * app has a shell to re-authenticate through and no desktop automation to run.
 * The user agent is spoofable, so this only ever shapes UX; the server never
 * authorizes on it.
 */
export const NATIVE_APP_UA_TOKEN = 'AASC-Mobile/';

export type NativePlatform = 'ios' | 'android';

/** Which phone platform the app runs on, or null outside the app. */
export function nativeAppPlatform(userAgent?: string): NativePlatform | null {
  const ua = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const at = ua.indexOf(NATIVE_APP_UA_TOKEN);
  if (at < 0) return null;
  const tail = ua.slice(at);
  if (/\(android\)/i.test(tail)) return 'android';
  if (/\(ios\)/i.test(tail)) return 'ios';
  // The shells don't append the suffix (seen on a real iPhone, Oct 2026): read the platform
  // from the WebView's own user agent, or an Android app would re-authenticate through
  // the iOS shell's origin.
  return /\bAndroid\b/.test(ua) ? 'android' : 'ios';
}

/** True inside the AASC phone app. Constant for the page's lifetime. */
export function isNativeMobileApp(userAgent?: string): boolean {
  return nativeAppPlatform(userAgent) !== null;
}

/** Hook form of {@link isNativeMobileApp}; no subscription needed, it never changes. */
export function useIsNativeMobileApp(): boolean {
  return isNativeMobileApp();
}

/**
 * The viewport meta's content inside the app: edge to edge (`viewport-fit=cover`;
 * base.css pads the UI back inside the safe area under body.native-app) and never
 * zoomed (`maximum-scale=1`). iOS zooms the page into a focused field whose text is
 * under 16px, the phone's text sizes go below that (the composer is 17px × 0.8 at
 * the default size), and Capacitor turns off the pinch that would zoom back out.
 * Adds each only when the page hasn't set it. Browsers keep their viewport untouched.
 */
export function nativeAppViewport(content: string): string {
  const added = [
    content.includes('viewport-fit') ? null : 'viewport-fit=cover',
    content.includes('maximum-scale') ? null : 'maximum-scale=1',
  ];
  return [content, ...added].filter(Boolean).join(', ');
}

/** Where the bundled shell lives inside the app (Capacitor's default origins). */
const SHELL_ORIGINS: Record<NativePlatform, string> = {
  ios: 'capacitor://localhost',
  android: 'https://localhost',
};

/**
 * The shell page that re-exchanges the phone's device token for a session and
 * comes back to `back` (a path on this server). Null outside the app.
 */
export function nativeShellReauthUrl(back: string, userAgent?: string): string | null {
  const platform = nativeAppPlatform(userAgent);
  if (!platform) return null;
  const path = back.startsWith('/') ? back : '/';
  return `${SHELL_ORIGINS[platform]}/?reauth=1&back=${encodeURIComponent(path)}`;
}
