import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const script = join(process.cwd(), 'scripts/verify-electron-artifacts.mjs');
const pkg = { name: 'test-app', version: '1.2.3' };
const productName = 'Test App';

function verify(platform: string, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'electron-artifacts-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(root, 'electron-builder.json'), JSON.stringify({ productName }));
    for (const [name, data] of Object.entries(files)) writeFileSync(join(root, name), data);
    const result = spawnSync(process.execPath, [script, platform, root], { cwd: root, encoding: 'utf8' });
    let checksums = '';
    if (result.status === 0) checksums = readFileSync(join(root, `SHA256SUMS-${platform}.txt`), 'utf8');
    return { ...result, checksums };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('versioned Electron artifact verification', () => {
  it.each([
    ['mac', ['Test App-1.2.3-arm64.dmg', 'Test App-1.2.3-arm64-mac.zip']],
    ['win', ['Test App Setup 1.2.3.exe']],
    ['linux', ['test-app-1.2.3-x86_64.AppImage', 'test-app-1.2.3-amd64.deb']],
  ])('checks every %s artifact and records its SHA-256', (platform, names) => {
    const files = Object.fromEntries(names.map((name) => [name, `bytes of ${name}`]));
    const result = verify(platform, files);
    expect(result.status, result.stderr).toBe(0);
    for (const name of names) {
      const digest = createHash('sha256').update(files[name]).digest('hex');
      expect(result.checksums).toContain(`${digest}  ${name}\n`);
      expect(result.stdout).toContain(name);
    }
  });

  it('rejects an incomplete Linux artifact set even with an older package present', () => {
    expect(verify('linux', { 'test-app-1.2.3-x86_64.AppImage': 'image', 'test-app-1.2.2-amd64.deb': 'old' }).status).not.toBe(0);
  });

  it('rejects empty artifacts', () => {
    expect(verify('win', { 'Test App Setup 1.2.3.exe': '' }).status).not.toBe(0);
  });

  it('rejects unknown platforms', () => {
    expect(verify('other', {}).status).not.toBe(0);
  });
});
