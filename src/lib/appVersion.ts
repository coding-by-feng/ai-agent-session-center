/**
 * appVersion.ts — the AASC version this bundle was built as, and when and from which
 * commit (vite.config.ts `define`). Two builds can share a version, so the stamp is
 * what tells them apart. A phone loads its screens from the Mac, so on a phone this is
 * the Mac's AASC. Null where the build set none (tests, screenshot harnesses).
 */
export interface AppBuild {
  /** ISO time the bundle was built. */
  date: string;
  /** `git describe --always --dirty`, or AASC_BUILD_COMMIT; null outside a checkout. */
  commit: string | null;
}

export const APP_VERSION: string | null = typeof __AASC_VERSION__ === 'string' ? __AASC_VERSION__ : null;

function readBuild(raw: unknown): AppBuild | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { date, commit } = raw as { date?: unknown; commit?: unknown };
  if (typeof date !== 'string' || (commit !== null && typeof commit !== 'string')) return null;
  return { date, commit };
}

export const APP_BUILD: AppBuild | null = readBuild(typeof __AASC_BUILD__ === 'undefined' ? undefined : __AASC_BUILD__);

/** One line for a bug report: `AASC 2.10.58 (built 2026-10-26T02:40:00.000Z, f129192-dirty)`. */
export function versionSummary(): string {
  if (!APP_VERSION) return 'AASC (version unknown)';
  if (!APP_BUILD) return `AASC ${APP_VERSION}`;
  return `AASC ${APP_VERSION} (built ${APP_BUILD.date}, ${APP_BUILD.commit ?? 'no commit'})`;
}
