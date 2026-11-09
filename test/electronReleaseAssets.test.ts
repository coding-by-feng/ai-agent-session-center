import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const script = join(process.cwd(), 'scripts/prepare-electron-release.mjs');
const names = {
  mac: ['Test App-1.2.3-arm64.dmg', 'Test App-1.2.3-arm64-mac.zip'],
  win: ['Test App Setup 1.2.3.exe'],
  linux: ['test-app-1.2.3-x86_64.AppImage', 'test-app-1.2.3-amd64.deb'],
  'lite-mac': ['Test App Lite-1.2.3-arm64.dmg', 'Test App Lite-1.2.3-arm64-mac.zip'],
  'lite-win': ['Test App Lite Setup 1.2.3.exe'],
  'lite-linux': ['test-app-lite-1.2.3-x86_64.AppImage', 'test-app-lite-1.2.3-amd64.deb'],
  'full-client-mac': ['Test App Full Client-1.2.3-arm64.dmg', 'Test App Full Client-1.2.3-arm64-mac.zip'],
  'full-client-win': ['Test App Full Client Setup 1.2.3.exe'],
  'full-client-linux': ['test-app-full-client-1.2.3-x86_64.AppImage', 'test-app-full-client-1.2.3-amd64.deb'],
  'lite-client-mac': ['Test App Lite Client-1.2.3-arm64.dmg', 'Test App Lite Client-1.2.3-arm64-mac.zip'],
  'lite-client-win': ['Test App Lite Client Setup 1.2.3.exe'],
  'lite-client-linux': ['test-app-lite-client-1.2.3-x86_64.AppImage', 'test-app-lite-client-1.2.3-amd64.deb'],
};
// Folder `<edition>-<platform>` (Full has no edition prefix) → `SHA256SUMS-<platform>[-<edition>].txt`.
const checksumFile = (folder: string): string => {
  const at = folder.lastIndexOf('-');
  return at < 0 ? `SHA256SUMS-${folder}.txt` : `SHA256SUMS-${folder.slice(at + 1)}-${folder.slice(0, at)}.txt`;
};

function prepare(missing?: string) {
  const root = mkdtempSync(join(tmpdir(), 'electron-release-'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(process.cwd(), 'scripts/verify-electron-artifacts.mjs'), join(root, 'scripts/verify-electron-artifacts.mjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'test-app', version: '1.2.3' }));
  writeFileSync(join(root, 'electron-builder.json'), JSON.stringify({ productName: 'Test App' }));
  for (const [platform, files] of Object.entries(names)) {
    mkdirSync(join(root, 'builds', platform), { recursive: true });
    for (const name of files) if (name !== missing) writeFileSync(join(root, 'builds', platform, name), `bytes of ${name}`);
  }
  const result = spawnSync(process.execPath, [script, join(root, 'builds')], { cwd: root, encoding: 'utf8' });
  return { root, result };
}

describe('complete four-edition, three-platform release asset staging', () => {
  it('requires twenty binaries and stages thirty-four assets with public filenames and matching checksums', () => {
    const { root, result } = prepare();
    try {
      expect(result.status, result.stderr).toBe(0);
      const upload = join(root, 'builds', 'upload');
      const assets = readdirSync(upload);
      // 20 binaries + 12 checksum files + latest-mac.yml + lite-mac.yml (the Clients have no auto-updater).
      expect(assets).toHaveLength(34);
      expect(assets.filter((name) => name.endsWith('-mac.yml')).sort()).toEqual(['latest-mac.yml', 'lite-mac.yml']);
      for (const [folder, files] of Object.entries(names)) {
        const checksums = readFileSync(join(upload, checksumFile(folder)), 'utf8');
        for (const name of files) {
          const publicName = name.replaceAll(' ', '.');
          const bytes = readFileSync(join(upload, publicName));
          expect(bytes.toString()).toBe(`bytes of ${name}`);
          expect(checksums).toContain(`${createHash('sha256').update(bytes).digest('hex')}  ${publicName}\n`);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('writes one Mac update file per edition naming the public zip and its SHA-512', () => {
    const { root, result } = prepare();
    try {
      expect(result.status, result.stderr).toBe(0);
      const upload = join(root, 'builds', 'upload');
      for (const [file, zip] of [['latest-mac.yml', 'Test.App-1.2.3-arm64-mac.zip'], ['lite-mac.yml', 'Test.App.Lite-1.2.3-arm64-mac.zip']]) {
        const yml = readFileSync(join(upload, file), 'utf8');
        const bytes = readFileSync(join(upload, zip));
        const digest = createHash('sha512').update(bytes).digest('base64');
        expect(yml).toContain('version: 1.2.3\n');
        expect(yml).toContain(`  - url: ${zip}\n    sha512: ${digest}\n    size: ${bytes.length}\n`);
        expect(yml).toContain(`path: ${zip}\nsha512: ${digest}\n`);
        expect(yml).not.toMatch(/url: .* /); // a space in the name would 404 on GitHub
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not stage a partial release when a Linux package is absent', () => {
    const { root, result } = prepare(names.linux[1]);
    try {
      expect(result.status).not.toBe(0);
      expect(() => readdirSync(join(root, 'builds', 'upload'))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not stage a release without the Client editions', () => {
    for (const missing of [names['full-client-win'][0], names['lite-client-linux'][1], names['lite-client-mac'][0]]) {
      const { root, result } = prepare(missing);
      try {
        expect(result.status, missing).not.toBe(0);
        expect(() => readdirSync(join(root, 'builds', 'upload'))).toThrow();
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  it('does not stage a release with Full alone when a Lite package is absent', () => {
    const { root, result } = prepare(names['lite-win'][0]);
    try {
      expect(result.status).not.toBe(0);
      expect(() => readdirSync(join(root, 'builds', 'upload'))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
