#!/usr/bin/env node
// sync-version.mjs — copies the phone app's version (capacitor.config.ts APP_VERSION / APP_BUILD) into the
// Xcode project and Gradle, so the number This phone shows is the number that was installed. Runs before
// every `cap sync` (package.json `capacitor:sync:before`); writes a file only when it changed.
//
//   node scripts/sync-version.mjs        (from mobile/)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = {
  config: 'capacitor.config.ts',
  pbxproj: 'ios/App/App.xcodeproj/project.pbxproj',
  gradle: 'android/app/build.gradle',
};

/** `{ version, build }` from the config's two literal lines; throws rather than guess. */
export function readVersion(configText) {
  const version = /^export const APP_VERSION = '(\d+\.\d+\.\d+)';$/m.exec(configText)?.[1];
  if (!version) throw new Error(`${FILES.config}: no APP_VERSION = '<major>.<minor>.<patch>' line`);
  const build = Number(/^export const APP_BUILD = (\d+);$/m.exec(configText)?.[1]);
  if (!Number.isInteger(build) || build < 1) throw new Error(`${FILES.config}: no APP_BUILD = <whole number ≥ 1> line`);
  return { version, build };
}

/** The file's text with its version fields set; the same text when they already match. */
export function applyVersion(text, kind, { version, build }) {
  if (kind === 'pbxproj') {
    return text
      .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
      .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`);
  }
  if (kind === 'gradle') {
    return text
      .replace(/versionName "[^"]*"/, `versionName "${version}"`)
      .replace(/versionCode \d+/, `versionCode ${build}`);
  }
  throw new Error(`unknown file kind ${kind}`);
}

function main() {
  const v = readVersion(readFileSync(resolve(MOBILE, FILES.config), 'utf8'));
  for (const kind of ['pbxproj', 'gradle']) {
    const path = resolve(MOBILE, FILES[kind]);
    const before = readFileSync(path, 'utf8');
    const after = applyVersion(before, kind, v);
    if (after !== before) writeFileSync(path, after);
    process.stdout.write(`${FILES[kind]}: ${v.version} (${v.build})${after === before ? '' : ' — updated'}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
