// liteBundleCheck.test.ts — scripts/verify-lite-bundle.mjs: the build step that fails when the Lite UI
// still carries what it should have dropped, or lost what it must keep.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const script = join(process.cwd(), 'scripts/verify-lite-bundle.mjs');
const KEEP = ['HistoryView-a.js', 'PhoneAppFrame-a.js', 'ProjectTab-a.js'];

function check(files: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'lite-bundle-'));
  try {
    mkdirSync(join(root, 'assets'));
    for (const name of files) writeFileSync(join(root, 'assets', name), 'x');
    return spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('verify-lite-bundle', () => {
  it('passes a bundle with the kept chunks and none of the dropped ones', () => {
    const result = check([...KEEP, 'index-a.js']);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(['CyberdromeScene-b.js', 'AgendaView-b.js', 'PromptsView-b.js', 'QueueView-b.js', 'ReviewView-b.js', 'ResourcesView-b.js'])(
    'fails on %s, which Lite should have dropped',
    (chunk) => {
      const result = check([...KEEP, chunk]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(chunk);
    },
  );

  it.each(KEEP)('fails without %s: a paired phone and HISTORY need the kept chunks', (chunk) => {
    const result = check(KEEP.filter((name) => name !== chunk));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(chunk.split('-')[0]);
  });

  it('fails on a folder with no build in it', () => {
    expect(spawnSync(process.execPath, [script, join(tmpdir(), 'no-such-lite-build')], { encoding: 'utf8' }).status).not.toBe(0);
  });
});

describe('verify-lite-package', () => {
  const { leftOutLibraries, librariesStillPacked, asarPath } = require('../scripts/verify-lite-package.cjs') as {
    leftOutLibraries: () => string[];
    librariesStillPacked: (asar: string, libraries: string[]) => string[];
    asarPath: (context: { appOutDir: string; electronPlatformName: string; packager: { appInfo: { productFilename: string } } }) => string;
  };

  function fakeAsar(files: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'lite-asar-'));
    const json = Buffer.from(JSON.stringify({ files }));
    const head = Buffer.alloc(16);
    head.writeUInt32LE(json.length, 12);
    const path = join(root, 'app.asar');
    writeFileSync(path, Buffer.concat([head, json]));
    return path;
  }

  it('reads the libraries from the Lite config', () => {
    expect(leftOutLibraries()).toEqual(expect.arrayContaining(['three', '@mediapipe/tasks-vision', 'pdfjs-dist']));
  });

  it('finds a library the exclusions failed to remove, scoped ones too', () => {
    const asar = fakeAsar({
      node_modules: {
        files: {
          three: { files: { 'package.json': { size: 1 } } },
          '@mediapipe': { files: { 'tasks-vision': { files: {} } } },
          ws: { files: {} },
        },
      },
    });
    expect(librariesStillPacked(asar, ['three', '@mediapipe/tasks-vision', 'hls.js'])).toEqual(['three', '@mediapipe/tasks-vision']);
  });

  it('passes a package without them', () => {
    expect(librariesStillPacked(fakeAsar({ node_modules: { files: { ws: { files: {} } } } }), ['three'])).toEqual([]);
  });

  it('knows where each platform keeps the archive', () => {
    const packager = { appInfo: { productFilename: 'App Lite' } };
    expect(asarPath({ appOutDir: '/out', electronPlatformName: 'darwin', packager })).toBe(join('/out', 'App Lite.app', 'Contents', 'Resources', 'app.asar'));
    expect(asarPath({ appOutDir: '/out', electronPlatformName: 'linux', packager })).toBe(join('/out', 'resources', 'app.asar'));
    expect(asarPath({ appOutDir: '/out', electronPlatformName: 'win32', packager })).toBe(join('/out', 'resources', 'app.asar'));
  });
});
