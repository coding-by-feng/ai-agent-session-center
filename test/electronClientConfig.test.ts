// electronClientConfig.test.ts — the two Client packages: what they carry, what they must leave out, and that they
// install beside Full and Lite without sharing a data folder with them.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { CLIENT_DATA_FOLDER } from '../electron/clientEdition.js';
import viteHome from '../vite.config.client-home';

const require = createRequire(import.meta.url);
type Entry = string | { from: string; to: string };
interface Config {
  appId: string; productName: string; files: Entry[]; extraMetadata: Record<string, unknown>;
  directories: { output: string }; asarUnpack: string[]; extraResources: unknown[]; afterPack: string;
  mac: { icon: string; entitlements: string; entitlementsInherit: string }; win: { icon: string }; dmg: { title: string };
  linux: { icon: string; artifactName: string; executableName: string }; deb: { packageName: string };
}
const full = require('../electron-builder.json') as Config;
const lite = require('../electron-builder.lite.cjs') as Config;
const fullClient = require('../electron-builder.client.cjs') as Config;
const liteClient = require('../electron-builder.lite-client.cjs') as Config;
const { CLIENT_FUSES, clientPackageProblems, electronBinary, unpackedRequires } = require('../scripts/verify-client-package.cjs') as {
  CLIENT_FUSES: Record<string, unknown>;
  electronBinary: (context: unknown) => string;
  clientPackageProblems: (header: unknown) => string[];
  unpackedRequires: (entries: string[], header: unknown, read: (file: string) => string) => string[];
};

const both: Array<[string, Config]> = [['Full Client', fullClient], ['Lite Client', liteClient]];

describe.each(both)('the %s package', (name, config) => {
  it('installs beside the other three under its own name and app ID', () => {
    expect(config.productName).toBe(`AI Agent Session Center ${name}`);
    expect(config.dmg.title).toBe(config.productName);
    for (const other of [full, lite]) expect(config.appId).not.toBe(other.appId);
    expect(config.directories.output).toMatch(/^dist\/(full|lite)-client$/);
  });

  // Electron derives the data folder and keychain item from the package name, and the lock lives in that folder.
  it('has its own package name, so it never touches sessions.db or takes a local edition\'s lock', () => {
    expect(config.extraMetadata.name).toBe(CLIENT_DATA_FOLDER);
    expect(config.extraMetadata.main).toBe('dist/electron/clientMain.cjs');
  });

  it('carries no server, hooks or native modules', () => {
    const strings = config.files.filter((e): e is string => typeof e === 'string');
    expect(strings).not.toContain('dist/server-bundle.cjs');
    expect(strings).not.toContain('server/**');
    expect(strings).not.toContain('hooks/**');
    expect(strings).not.toContain('node_modules/**');
    expect(strings).toContain('!node_modules/**');
    expect(config.asarUnpack).toEqual([]);
    expect(config.extraResources).toEqual([]);
  });

  it('keeps its exclusions ahead of the { from, to } entries, or they stop applying', () => {
    const lastString = config.files.map((e) => typeof e === 'string').lastIndexOf(true);
    const firstObject = config.files.findIndex((e) => typeof e !== 'string');
    expect(lastString).toBeLessThan(firstObject);
  });

  it('carries the home page and the check that fails a bad package', () => {
    expect(config.files).toContainEqual({ from: 'dist/client-home', to: 'dist/client-home' });
    expect(config.afterPack).toBe('scripts/verify-client-package.cjs');
    expect(existsSync(config.afterPack)).toBe(true);
  });

  it('never replaces another edition on Linux', () => {
    expect(config.linux.artifactName).toMatch(/^ai-agent-session-center-(full|lite)-client-/);
    expect(config.linux.executableName).toBe(config.deb.packageName);
    expect(config.deb.packageName).toMatch(/^ai-agent-session-center-(full|lite)-client$/);
  });

  it('has its own icon on every platform', () => {
    for (const [icon, others] of [
      [config.mac.icon, [full.mac.icon, lite.mac.icon]],
      [config.win.icon, [full.win.icon, lite.win.icon]],
      [config.linux.icon, [full.mac.icon, lite.mac.icon]],
    ] as Array<[string, string[]]>) {
      expect(existsSync(icon), icon).toBe(true);
      for (const other of others) expect(readFileSync(icon).equals(readFileSync(other)), icon).toBe(false);
    }
  });
});

describe('the two Clients', () => {
  it('differ in the UI they carry', () => {
    expect(fullClient.files).toContainEqual({ from: 'dist/client', to: 'dist/client' });
    expect(liteClient.files).toContainEqual({ from: 'dist/client-lite', to: 'dist/client' });
  });

  it('say which they are', () => {
    expect(fullClient.extraMetadata.aascEdition).toBe('full-client');
    expect(liteClient.extraMetadata.aascEdition).toBe('lite-client');
  });

  it('are told apart from each other', () => {
    expect(fullClient.appId).not.toBe(liteClient.appId);
    expect(readFileSync(fullClient.mac.icon).equals(readFileSync(liteClient.mac.icon))).toBe(false);
  });
});

describe('the local editions', () => {
  it('still start the local app', () => {
    expect(full.extraMetadata.main).toBe('dist/electron/main.cjs');
    expect(lite.extraMetadata.main).toBe('dist/electron/main.cjs');
    expect(full.files).toContain('dist/server-bundle.cjs');
  });
});

describe('what a Client may ask of the system', () => {
  it.each(both)('%s asks macOS only for what running a browser engine needs', (_name, config) => {
    expect(config.mac.entitlements).toBe('electron/entitlements.client.mac.plist');
    expect(config.mac.entitlementsInherit).toBe('electron/entitlements.client.mac.plist');
    const keys = [...readFileSync(config.mac.entitlements, 'utf8').matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual(['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory']);
  });

  it('leaves Full\'s and Lite\'s entitlements alone', () => {
    expect(full.mac.entitlements).toBe('electron/entitlements.mac.plist');
    expect(lite.mac.entitlements).toBe('electron/entitlements.mac.plist');
  });

  it('runs no one else\'s code through the app, and keeps its cookies encrypted', async () => {
    const { FuseV1Options: fuse, FuseVersion } = await import('@electron/fuses');
    expect(CLIENT_FUSES).toEqual({
      version: FuseVersion.V1,
      [fuse.RunAsNode]: false,
      [fuse.EnableNodeOptionsEnvironmentVariable]: false,
      [fuse.EnableNodeCliInspectArguments]: false,
      [fuse.EnableCookieEncryption]: true,
      [fuse.OnlyLoadAppFromAsar]: true,
      [fuse.GrantFileProtocolExtraPrivileges]: false,
    });
  });
});

describe('which file the fuses are set on', () => {
  const packager = { appInfo: { productFilename: 'AI Agent Session Center Full Client' }, executableName: 'ai-agent-session-center-full-client' };
  it.each([
    ['darwin', 'out/AI Agent Session Center Full Client.app'],
    ['win32', 'out/AI Agent Session Center Full Client.exe'],
    ['linux', 'out/ai-agent-session-center-full-client'],
  ])('on %s', (electronPlatformName, expected) => {
    expect(electronBinary({ appOutDir: 'out', electronPlatformName, packager })).toBe(expected);
  });
});

describe('the home page build', () => {
  it('has its own folder and leaves the shipped screenshots out', () => {
    expect(viteHome.build?.outDir).toBe('dist/client-home');
    expect(viteHome.publicDir).toBe(false);
  });
});

describe('the package check', () => {
  const dir = (files: Record<string, unknown>) => ({ files });
  const good = () => dir({
    dist: dir({
      electron: dir({ 'clientMain.cjs': {}, 'preloadClient.cjs': {} }),
      client: dir({ 'index.html': {} }),
      'client-home': dir({ 'client-home.html': {} }),
    }),
  });

  it('passes a good package', () => {
    expect(clientPackageProblems(good())).toEqual([]);
  });

  it.each([
    ['the server bundle', ['dist', 'server-bundle.cjs']],
    ['the server folder', ['server']],
    ['the hook scripts', ['hooks']],
    ['node-pty', ['node_modules', 'node-pty']],
    ['better-sqlite3', ['node_modules', 'better-sqlite3']],
    ['the local app entry', ['dist', 'electron', 'main.cjs']],
    ['the PTY host', ['dist', 'electron', 'ptyHost.cjs']],
  ])('fails when %s got packed', (_name, parts) => {
    const header = good() as { files: Record<string, { files: Record<string, unknown> }> };
    let node = header as { files: Record<string, unknown> };
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} };
      node = node.files[part] as { files: Record<string, unknown> };
    }
    node.files[parts[parts.length - 1]] = {};
    expect(clientPackageProblems(header).join()).toContain(parts.join('/'));
  });

  describe('following what the packed code loads', () => {
    const packed = (files: Record<string, string>) => {
      const header: { files: Record<string, unknown> } = { files: {} };
      for (const file of Object.keys(files)) {
        let node = header;
        const parts = file.split('/');
        for (const part of parts.slice(0, -1)) node = (node.files[part] ??= { files: {} }) as typeof header;
        node.files[parts[parts.length - 1]] = {};
      }
      return { header, read: (file: string) => files[file] };
    };
    const ENTRY = 'dist/electron/clientMain.cjs';

    it('passes when everything it requires is packed', () => {
      const { header, read } = packed({
        [ENTRY]: 'require("electron"); require("fs/promises"); require("node:path"); require("./remote/a.cjs");',
        'dist/electron/remote/a.cjs': 'require("../b.cjs");',
        'dist/electron/b.cjs': 'require("./remote/a.cjs");', // A cycle ends.
      });
      expect(unpackedRequires([ENTRY], header, read)).toEqual([]);
    });

    // A shared module that later imports something the Client leaves out passes every test, then dies at launch.
    it('fails on a local module left out of the package, however deep', () => {
      const { header, read } = packed({
        [ENTRY]: 'require("./remote/a.cjs");',
        'dist/electron/remote/a.cjs': 'require("../edition.cjs");',
      });
      expect(unpackedRequires([ENTRY], header, read).join()).toContain('dist/electron/edition.cjs');
    });

    it('fails on an npm package, because a Client carries none', () => {
      const { header, read } = packed({ [ENTRY]: 'require("zod");' });
      expect(unpackedRequires([ENTRY], header, read).join()).toContain('zod');
    });

    it('sees either kind of quote', () => {
      const { header, read } = packed({ [ENTRY]: "require('zod');" });
      expect(unpackedRequires([ENTRY], header, read).join()).toContain('zod');
    });
  });

  it.each([
    ['dist/client/index.html', 'client', 'index.html'],
    ['dist/client-home/client-home.html', 'client-home', 'client-home.html'],
    ['dist/electron/clientMain.cjs', 'electron', 'clientMain.cjs'],
    ['dist/electron/preloadClient.cjs', 'electron', 'preloadClient.cjs'],
  ])('fails when %s is missing', (needed, folder, file) => {
    const header = good() as unknown as { files: { dist: { files: Record<string, { files: Record<string, unknown> }> } } };
    delete header.files.dist.files[folder].files[file];
    expect(clientPackageProblems(header).join()).toContain(needed);
  });
});
