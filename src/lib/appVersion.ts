/**
 * appVersion.ts — the AASC version this bundle was built as (vite.config.ts `define`).
 * A phone loads its screens from the Mac, so on a phone this is the Mac's AASC.
 * Null where the build set none (tests, screenshot harnesses).
 */
export const APP_VERSION: string | null = typeof __AASC_VERSION__ === 'string' ? __AASC_VERSION__ : null;
