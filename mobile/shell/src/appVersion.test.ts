// The phone app's version (capacitor.config.ts `APP_VERSION` / `APP_BUILD`) is the one source: the user agent
// carries it to the Mac's This phone screen, and scripts/sync-version.mjs copies it into the Xcode and Gradle
// projects before every `cap sync` (package.json `capacitor:sync:before`). These pin that the copies agree.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import config, { APP_BUILD, APP_VERSION } from '../../capacitor.config';
// @ts-expect-error — a plain Node script with no type declarations
import { applyVersion, readVersion } from '../../scripts/sync-version.mjs';

const MOBILE = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(MOBILE, rel), 'utf8');
const PBXPROJ = 'ios/App/App.xcodeproj/project.pbxproj';
const GRADLE = 'android/app/build.gradle';

describe('phone app version', () => {
  it('is a plain version and a whole build number, sent in the user agent', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number.isInteger(APP_BUILD) && APP_BUILD >= 1).toBe(true);
    expect(config.appendUserAgent).toBe(`AASC-Mobile/${APP_VERSION}+${APP_BUILD}`);
  });

  it('is what the Xcode and Gradle projects carry', () => {
    const pbx = read(PBXPROJ);
    const marketing = [...pbx.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1]);
    const project = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = ([^;]+);/g)].map((m) => m[1]);
    expect(marketing.length).toBeGreaterThan(0);
    expect(new Set(marketing)).toEqual(new Set([APP_VERSION]));
    expect(new Set(project)).toEqual(new Set([String(APP_BUILD)]));
    const gradle = read(GRADLE);
    expect(gradle).toContain(`versionName "${APP_VERSION}"`);
    expect(gradle).toContain(`versionCode ${APP_BUILD}`);
  });

  it('is copied by the script, which reads the config and leaves synced files as they are', () => {
    expect(readVersion(read('capacitor.config.ts'))).toEqual({ version: APP_VERSION, build: APP_BUILD });
    const v = { version: '2.3.4', build: 17 };
    const pbx = applyVersion(read(PBXPROJ), 'pbxproj', v);
    expect(pbx).toContain('MARKETING_VERSION = 2.3.4;');
    expect(pbx).toContain('CURRENT_PROJECT_VERSION = 17;');
    expect(pbx).not.toContain(`MARKETING_VERSION = ${APP_VERSION};`);
    const gradle = applyVersion(read(GRADLE), 'gradle', v);
    expect(gradle).toContain('versionName "2.3.4"');
    expect(gradle).toContain('versionCode 17');
    expect(applyVersion(pbx, 'pbxproj', v)).toBe(pbx);
    expect(applyVersion(read(GRADLE), 'gradle', { version: APP_VERSION, build: APP_BUILD })).toBe(read(GRADLE));
  });

  it('refuses a config it cannot read rather than writing a guess', () => {
    expect(() => readVersion("export const APP_VERSION = '1.0';")).toThrow(/APP_VERSION/);
    expect(() => readVersion("export const APP_VERSION = '1.0.0';\nexport const APP_BUILD = 0;")).toThrow(/APP_BUILD/);
  });

  it('runs before every cap sync', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['capacitor:sync:before']).toBe('node scripts/sync-version.mjs');
  });
});
