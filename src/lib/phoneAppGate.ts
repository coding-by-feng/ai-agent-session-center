/**
 * phoneAppGate — does App.tsx show the phone app or the desktop layout?
 *
 * Every phone-sized screen (`useIsMobile()`) gets the phone app (AASC-48). The
 * one exception is the standalone project browser: the desktop opens it in a
 * window of its own that can shrink to 480px, which is "phone-sized" by the
 * media query, and it must stay the project browser there. Import-free: App.tsx
 * reads it, so it sits in the desktop's entry chunk.
 */
export const PROJECT_BROWSER_PATH = '/project-browser';

export function showsPhoneApp(isMobile: boolean, pathname: string): boolean {
  return isMobile && pathname !== PROJECT_BROWSER_PATH;
}
