// selfDescription.ts — what this install tells its AASC Cloud account about itself (plan 18): the
// platform, the edition and the app version, so the account's device list can read
// "Mac mini · macOS · 2.11.0". Only values the backend's contract names are sent; anything this build
// cannot name is left out, and with nothing left there is no request at all.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Edition } from '../instanceLock.js';

/**
 * The version in this install's package.json, or '' when it cannot be read. The desktop app passes
 * its own version instead (the bundle has no package.json beside it); this is for `npm start`,
 * `aasc-server` and development.
 */
export function packageVersion(root: string): string {
  try {
    const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : '';
  } catch {
    return '';
  }
}

export interface SelfDescription {
  platform?: 'macos' | 'windows' | 'linux';
  edition?: 'full' | 'lite' | 'server';
  appVersion?: string;
}

const PLATFORMS: Record<string, SelfDescription['platform']> = { darwin: 'macos', win32: 'windows', linux: 'linux' };
/** The backend's AppVersionSchema: two to four numeric parts and an optional short tag. */
const APP_VERSION = /^\d{1,4}(\.\d{1,4}){1,3}([-+][0-9A-Za-z.-]{1,16})?$/;

export function selfDescription(input: {
  platform: string;
  /** Which product runs this server (edition.ts). */
  edition: Edition;
  /** The desktop app's Lite build; the server itself is the same in both. */
  lite: boolean;
  version: string;
}): SelfDescription | null {
  const platform = PLATFORMS[input.platform];
  const edition: SelfDescription['edition'] | undefined =
    input.edition === 'headless'
      ? 'server'
      : input.edition === 'desktop'
        ? input.lite
          ? 'lite'
          : 'full'
        : input.edition === 'dev'
          ? 'full'
          : undefined;
  const appVersion = input.version.length <= 32 && APP_VERSION.test(input.version) ? input.version : undefined;
  const described: SelfDescription = {
    ...(platform ? { platform } : {}),
    ...(edition ? { edition } : {}),
    ...(appVersion ? { appVersion } : {}),
  };
  return Object.keys(described).length ? described : null;
}
