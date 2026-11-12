// test/shareDefaultFile.test.ts — the setup wizard writes share-default.json itself (the server may
// not be running yet); the server must read what it wrote, and the wizard must read what the server wrote.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readShareDefault, writeShareDefault, shareDefaultPath } from '../hooks/shareDefaultFile.js';
import { isShareNewSessionsOn, setShareNewSessions, _resetShareNewSessionsForTests } from '../server/shareDefault.js';

let dir: string;
const saved = process.env.AASC_SHARE_DEFAULT_FILE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aasc-share-'));
  process.env.AASC_SHARE_DEFAULT_FILE = shareDefaultPath(dir);
  _resetShareNewSessionsForTests();
});
afterEach(() => {
  if (saved === undefined) delete process.env.AASC_SHARE_DEFAULT_FILE;
  else process.env.AASC_SHARE_DEFAULT_FILE = saved;
  _resetShareNewSessionsForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe('share-default.json, wizard ↔ server', () => {
  it('reads off when there is no file or it is not ours', () => {
    expect(readShareDefault(dir)).toBe(false);
  });

  it('the server reads what the wizard wrote, privately', () => {
    writeShareDefault(dir, true);
    expect(isShareNewSessionsOn()).toBe(true);
    expect(statSync(shareDefaultPath(dir)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(shareDefaultPath(dir), 'utf8'))).toEqual({ shareNewSessions: true });
  });

  it('the wizard reads what the server wrote', () => {
    setShareNewSessions(true);
    expect(readShareDefault(dir)).toBe(true);
    setShareNewSessions(false);
    expect(readShareDefault(dir)).toBe(false);
  });
});
