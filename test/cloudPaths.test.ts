// The device token must never sit where a paired phone can read it or where
// Project Sync would copy it (security review of the cloud port, MEDIUM).
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudStateBase } from '../server/cloud/paths.js';
import { phoneMayRead } from '../server/mobile/phoneProfile.js';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function fakeHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-cloud-paths-')));
  homes.push(home);
  return home;
}

it('Electron keeps cloud state in its user-data folder', () => {
  expect(cloudStateBase({ APP_USER_DATA: '/fixture/user-data' }, '/fixture/home')).toBe('/fixture/user-data');
});

it('without Electron it lives under ~/.config/aasc, never in the repository data folder', () => {
  expect(cloudStateBase({}, '/fixture/home')).toBe('/fixture/home/.config/aasc');
});

it('a phone cannot read the token file even when the AASC checkout is a shared project', () => {
  const home = fakeHome();
  const checkout = join(home, 'code', 'agent-manager');
  mkdirSync(join(checkout, 'data'), { recursive: true });
  const secrets = join(cloudStateBase({}, home), 'cloud', 'secrets');
  mkdirSync(secrets, { recursive: true });
  const token = join(secrets, '00000000-0000-4000-8000-000000000001');
  writeFileSync(token, '{}');
  expect(phoneMayRead(token, [checkout, home, join(home, '.config')], home)).toBe(false);
  // Why the old location was wrong: <repo>/data is an ordinary project file.
  const repoData = join(checkout, 'data', 'cloud', 'secrets', 'x');
  mkdirSync(join(checkout, 'data', 'cloud', 'secrets'), { recursive: true });
  writeFileSync(repoData, '{}');
  expect(phoneMayRead(repoData, [checkout], home)).toBe(true);
});

it('the server opens its cloud state through cloudStateBase only', async () => {
  const source = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8');
  expect(source).toContain('const base = cloudStateBase();');
  expect(source).not.toMatch(/join\(__dirname, '\.\.', 'data'\)[^\n]*cloud|'data', 'cloud'/);
});
