// test/phoneSearchFilter.test.ts — AASC-20: the phone's project search answers only with files the phone
// could open. A text search reads every file under the root (ripgrep skips only hidden and ignored files,
// the grep fallback not even those), so without this a paired phone would get lines of credentials.json,
// a *.pem or .claude/settings.json that /files/read refuses it. A password sign-in is unchanged.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPhoneProfile, filterPhoneSearchAnswer } from '../server/mobile/phoneProfile.js';

let tmp = '';
let home = '';
let project = '';

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-phone-search-')));
  home = join(tmp, 'home');
  project = join(home, 'proj');
  for (const dir of ['src', 'keys', '.claude', 'config']) mkdirSync(join(project, dir), { recursive: true });
  for (const file of ['src/a.ts', 'keys/server.pem', 'credentials.json', '.env.local', '.claude/settings.json', 'config/app.yml']) {
    writeFileSync(join(project, file), 'token = 1\n');
  }
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const MATCHES = [
  { file: '/src/a.ts', line: 1, text: 'token = 1' },
  { file: '/keys/server.pem', line: 1, text: 'token = 1' },
  { file: '/credentials.json', line: 1, text: 'token = 1' },
  { file: '/.env.local', line: 1, text: 'token = 1' },
  { file: '/.claude/settings.json', line: 1, text: 'token = 1' },
  { file: '/config/app.yml', line: 1, text: 'token = 1' },
];

describe('filterPhoneSearchAnswer', () => {
  it('keeps the lines and names a phone could open, and drops every secret one', () => {
    const grep = filterPhoneSearchAnswer({ matches: MATCHES, truncated: false }, project, [project], home) as { matches: typeof MATCHES; truncated: boolean };
    expect(grep.matches.map((m) => m.file)).toEqual(['/src/a.ts', '/config/app.yml']);
    expect(grep.truncated).toBe(false);
    const names = filterPhoneSearchAnswer(
      { results: MATCHES.map((m) => ({ path: m.file, name: m.file.split('/').pop(), type: 'file' })), indexing: false },
      project, [project], home,
    ) as { results: Array<{ path: string }> };
    expect(names.results.map((r) => r.path)).toEqual(['/src/a.ts', '/config/app.yml']);
  });

  it('drops everything when the project is no longer shared, and leaves other shapes alone', () => {
    expect((filterPhoneSearchAnswer({ matches: MATCHES }, project, [], home) as { matches: unknown[] }).matches).toEqual([]);
    expect(filterPhoneSearchAnswer({ error: 'Grep failed' }, project, [project], home)).toEqual({ error: 'Grep failed' });
    expect(filterPhoneSearchAnswer(null, project, [project], home)).toBeNull();
  });
});

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function serve(): Promise<string> {
  const app = express();
  app.use('/api', createPhoneProfile({
    phoneOf: (req) => (req.get('x-phone') ? 'phone-1234567890' : null),
    sharedProjectPaths: () => [project],
    knownProjectPaths: () => [],
    isOpsTerminal: () => false,
    foregroundProcess: () => null,
    home,
  }));
  app.get('/api/files/grep', (_req, res) => res.json({ matches: MATCHES, truncated: false }));
  app.get('/api/files/search', (_req, res) => res.json({ results: MATCHES.map((m) => ({ path: m.file, name: 'x', type: 'file' })), indexing: false }));
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

describe('the project search through the phone profile', () => {
  it('filters a phone\'s text and name search, and leaves a password sign-in\'s alone', async () => {
    const base = await serve();
    const q = `root=${encodeURIComponent(project)}&q=token`;
    const phoneGrep = (await (await fetch(`${base}/api/files/grep?${q}`, { headers: { 'x-phone': '1' } })).json()) as { matches: Array<{ file: string }> };
    expect(phoneGrep.matches.map((m) => m.file)).toEqual(['/src/a.ts', '/config/app.yml']);
    const phoneNames = (await (await fetch(`${base}/api/files/search?${q}`, { headers: { 'x-phone': '1' } })).json()) as { results: Array<{ path: string }> };
    expect(phoneNames.results.map((r) => r.path)).toEqual(['/src/a.ts', '/config/app.yml']);
    const desk = (await (await fetch(`${base}/api/files/grep?${q}`)).json()) as { matches: unknown[] };
    expect(desk.matches).toHaveLength(MATCHES.length);
  });
});
