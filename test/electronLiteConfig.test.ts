// electronLiteConfig.test.ts — the Lite package. Its package `name` decides the shared data folder and
// keychain item (electron/edition.ts), and what it leaves out must be nothing the server loads.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import viteLite from '../vite.config.lite';
import viteFull from '../vite.config';

const require = createRequire(import.meta.url);
const full = require('../electron-builder.json') as Record<string, never>;
const lite = require('../electron-builder.lite.cjs') as {
  appId: string; productName: string; files: Array<string | { from: string; to: string }>;
  extraMetadata: Record<string, unknown>; directories: { output: string };
  linux: { artifactName: string; executableName: string; icon: string }; deb: { packageName: string }; dmg: { title: string };
  mac: { icon: string }; win: { icon: string };
  [key: string]: unknown;
};

const excluded = lite.files
  .filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('!node_modules/'))
  .map((entry) => entry.replace('!node_modules/', '').replace('/**', ''));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|js|cjs|mjs)$/.test(name) ? [path] : [];
  });
}

describe('the Lite package', () => {
  it('installs beside Full under its own name and app ID', () => {
    expect(lite.appId).not.toBe(full.appId);
    expect(lite.productName).toBe('AI Agent Session Center Lite');
    expect(lite.dmg.title).toBe(lite.productName);
  });

  it('keeps the package name, which is what shares the data folder and keychain item', () => {
    expect(lite.extraMetadata).not.toHaveProperty('name');
    expect(lite.extraMetadata).not.toHaveProperty('productName');
    expect(lite.extraMetadata.aascEdition).toBe('lite');
    expect(lite.extraMetadata.main).toBe((full.extraMetadata as unknown as { main: string }).main);
  });

  it('ships the Lite UI where the server looks for the client', () => {
    expect(lite.files).toContainEqual({ from: 'dist/client-lite', to: 'dist/client' });
    expect(lite.files).not.toContain('dist/client/**');
  });

  it('never replaces Full on Linux', () => {
    expect(lite.linux.artifactName).toMatch(/^ai-agent-session-center-lite-/);
    expect(lite.linux.executableName).toBe('ai-agent-session-center-lite');
    expect(lite.deb.packageName).toBe('ai-agent-session-center-lite');
  });

  // Both editions install side by side, so the Dock, Applications folder and desktop must tell them apart. Without
  // linux.icon electron-builder falls back to mac.icon, so all three are stated.
  it('has its own icon on every platform', () => {
    const fullIcons = full as unknown as { mac: { icon: string }; win: { icon: string } };
    for (const [icon, fullIcon] of [
      [lite.mac.icon, fullIcons.mac.icon],
      [lite.win.icon, fullIcons.win.icon],
      [lite.linux.icon, fullIcons.mac.icon],
    ]) {
      expect(icon).toMatch(/^electron\/icon\/icon-lite\./);
      expect(existsSync(icon), icon).toBe(true);
      expect(readFileSync(icon).equals(readFileSync(fullIcon)), icon).toBe(false);
    }
  });

  it('changes only the icon in the platform settings it inherits from Full', () => {
    const base = full as unknown as { mac: object; win: object };
    expect(lite.mac).toEqual({ ...base.mac, icon: lite.mac.icon });
    expect(lite.win).toEqual({ ...base.win, icon: lite.win.icon });
  });

  it('leaves Full on the original icons', () => {
    const base = full as unknown as { mac: { icon: string }; win: { icon: string } };
    expect(base.mac.icon).toBe('electron/icon/icon.icns');
    expect(base.win.icon).toBe('electron/icon/icon.ico');
  });

  it('builds into its own folder, so it cannot overwrite a Full build', () => {
    expect(lite.directories.output).toBe('dist/lite');
  });

  // electron-builder groups each run of strings into one set and moves the sets around. Strings written after a
  // { from, to } entry end up ahead of `node_modules/**`, which then adds every library back without a word.
  it('lists its exclusions before any { from, to } entry, or they do nothing', () => {
    const firstFileSet = lite.files.findIndex((entry) => typeof entry !== 'string');
    const lastExclusion = lite.files.map((entry) => typeof entry === 'string' && entry.startsWith('!')).lastIndexOf(true);
    expect(lastExclusion).toBeGreaterThan(-1);
    expect(lastExclusion).toBeLessThan(firstFileSet);
  });

  it('checks the packed app for the left-out libraries', () => {
    expect(lite.afterPack).toBe('scripts/verify-lite-package.cjs');
  });

  it('leaves out only libraries the server, Electron and hooks never load', () => {
    expect(excluded.length).toBeGreaterThan(0);
    const code = ['server', 'electron', 'hooks'].flatMap(sources).map((file) => readFileSync(file, 'utf8'));
    for (const library of excluded) {
      const loaded = code.some((text) => text.includes(`'${library}'`) || text.includes(`"${library}"`) || text.includes(`'${library}/`));
      expect(loaded, library).toBe(false);
    }
  });

  it('leaves the Full package as it was', () => {
    expect((full.files as unknown as string[])).toContain('dist/client/**');
    expect(full.extraMetadata).not.toHaveProperty('aascEdition');
  });
});

describe('the Lite UI build', () => {
  it('sets the edition and has its own output folder', () => {
    expect(viteLite.define?.__AASC_EDITION__).toBe('"lite"');
    expect(viteLite.build?.outDir).toBe('dist/client-lite');
  });

  it('leaves the Full build as Full, with CORS still off in both', () => {
    const fullConfig = viteFull as typeof viteLite;
    expect(fullConfig.define?.__AASC_EDITION__).toBe('"full"');
    expect(fullConfig.build?.outDir).toBe('dist/client');
    expect(viteLite.server?.cors).toBe(false);
  });
});
