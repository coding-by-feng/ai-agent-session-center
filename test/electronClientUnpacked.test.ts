// electronClientUnpacked.test.ts — the desktop server serves dist/client with express.static, which opens each
// file by descriptor. Electron can't open a file inside app.asar that way, so it copies the file to $TMPDIR once
// and reuses that copy for as long as the app runs. macOS deletes $TMPDIR files left untouched for 3 days: an app
// left running that long answered 404 (ENOENT …/T/.com.kasonzhan.ai-agent-session-center.XXXX) for index.html
// and every chunk, and the phone app opened on a blank page (Nov 10 2026). Unpacked files are opened in place.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const full = require('../electron-builder.json') as { asarUnpack: string[] };
const lite = require('../electron-builder.lite.cjs') as {
  asarUnpack: string[];
  files: Array<string | { from: string; to: string }>;
};

describe('the client the desktop server serves', () => {
  it('ships outside app.asar in Full', () => {
    expect(full.asarUnpack).toContain('dist/client/**');
  });

  // electron-builder matches asarUnpack against each file's SOURCE path, not where `files` puts it: Lite copies
  // dist/client-lite to dist/client, so only the source name unpacks it (a packaged --dir build showed it).
  it('ships outside app.asar in Lite, matched by the source folder its `files` entry copies from', () => {
    expect(lite.files).toContainEqual({ from: 'dist/client-lite', to: 'dist/client' });
    expect(lite.asarUnpack).toContain('dist/client-lite/**');
  });

  it('keeps the native modules unpacked', () => {
    expect(full.asarUnpack).toEqual(expect.arrayContaining(['node_modules/better-sqlite3/**', 'node_modules/node-pty/**']));
  });
});
