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

export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;

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
