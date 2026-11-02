/// <reference types="vite/client" />

/** package.json's version, set by vite.config.ts `define`; absent in tests and harnesses (read through lib/appVersion). */
declare const __AASC_VERSION__: string | undefined;
/** When and from which commit the bundle was built, set the same way (read through lib/appVersion). */
declare const __AASC_BUILD__: unknown;
/** 'lite' in the Lite desktop build (vite.config.lite.ts); read through lib/edition. */
declare const __AASC_EDITION__: string | undefined;

declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
