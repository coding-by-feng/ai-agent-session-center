import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureTrialStore } from '../electron/trial/store.js';

const dirs: string[] = [];
const fakeCrypto = (available = true) => ({
  isAvailable: () => available,
  encrypt: (s: string) => Buffer.from(s, 'utf8').map(b => b ^ 0x55),
  decrypt: (b: Buffer) => Buffer.from(b).map(x => x ^ 0x55).toString('utf8'),
});
function path() { const dir = mkdtempSync(join(tmpdir(), 'aasc-trial-vault-')); dirs.push(dir); return join(dir, 'trial.json'); }
const state = { version: 1 as const, cookie: '__Host-aasc_trial=private-test-session', pending: { requestKey: 'pending-request-001', prompt: '解释这个概念' } };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('persists trial credentials and pending question encrypted across application restart', () => {
  const file = path(); const store = createSecureTrialStore({ file, crypto: fakeCrypto() });
  store.save(state);
  expect(readFileSync(file, 'utf8')).not.toContain('private-test-session');
  expect(readFileSync(file, 'utf8')).not.toContain(state.pending.prompt);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(createSecureTrialStore({ file, crypto: fakeCrypto() }).load()).toEqual(state);
  store.save(null); expect(store.load()).toBeNull();
});

it('fails closed when the operating-system keychain is unavailable', () => {
  const store = createSecureTrialStore({ file: path(), crypto: fakeCrypto(false) });
  expect(() => store.save(state)).toThrow('credential_store_unavailable');
});

it('does not follow a symlink or overwrite corrupt credential data', () => {
  const file = path(); const target = `${file}.target`; writeFileSync(target, 'unrelated'); symlinkSync(target, file);
  const store = createSecureTrialStore({ file, crypto: fakeCrypto() });
  expect(() => store.load()).toThrow('credential_store_invalid');
  expect(() => store.save(state)).toThrow('credential_store_invalid');
  expect(readFileSync(target, 'utf8')).toBe('unrelated');
  rmSync(file); writeFileSync(file, '{broken');
  expect(() => store.load()).toThrow('credential_store_invalid');
  expect(readFileSync(file, 'utf8')).toBe('{broken');
});
