/**
 * The setup wizard hashes its password in the ELECTRON MAIN process
 * (`electron/ipc/setupHandlers.ts`) because scrypt is Node-crypto-only — the
 * renderer's Web Crypto has PBKDF2, not scrypt, so a renderer-side hash could
 * never match `verifyPassword`.
 *
 * That handler cannot import `server/authManager.ts` (`tsconfig.electron.json`
 * doesn't reach `server/` — the same constraint that forces `ptyRing.ts` and
 * `internalUrl.ts` to be duplicated), so `hashPassword` is MIRRORED there.
 *
 * A silent drift between the two is uniquely nasty: the user sets a password
 * during setup, it is written to server-config.json, and then login fails
 * forever with a correct password and nothing logged anywhere. These tests
 * pin the mirror's source text against the original and prove the output
 * round-trips through the real `verifyPassword`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { scryptSync, randomBytes } from 'crypto';
import { verifyPassword } from '../server/authManager.js';

const ROOT = join(__dirname, '..');
const HANDLER_SRC = readFileSync(join(ROOT, 'electron/ipc/setupHandlers.ts'), 'utf8');
const AUTH_SRC = readFileSync(join(ROOT, 'server/authManager.ts'), 'utf8');

/** Reproduces the mirror exactly, so the round-trip test below is meaningful. */
function mirrorHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

describe('setup password hash mirror', () => {
  it('the handler defines its own hashPassword (it cannot import authManager)', () => {
    expect(HANDLER_SRC).toMatch(/function hashPassword\s*\(/);
    // If this ever becomes a real import, this whole drift test is obsolete —
    // delete it rather than loosening it.
    expect(HANDLER_SRC).not.toMatch(/from ['"].*server\/authManager/);
  });

  it('uses the same scrypt key length as authManager', () => {
    const authKeylen = AUTH_SRC.match(/SCRYPT_KEYLEN\s*=\s*(\d+)/)?.[1];
    const mirrorKeylen = HANDLER_SRC.match(/SCRYPT_KEYLEN\s*=\s*(\d+)/)?.[1];
    expect(authKeylen).toBeDefined();
    expect(mirrorKeylen).toBe(authKeylen);
  });

  it('uses the same salt size and "salt:hash" hex encoding as authManager', () => {
    for (const src of [AUTH_SRC, HANDLER_SRC]) {
      expect(src).toMatch(/randomBytes\(16\)\.toString\('hex'\)/);
      expect(src).toMatch(/scryptSync\(password,\s*salt,\s*SCRYPT_KEYLEN\)\.toString\('hex'\)/);
      expect(src).toMatch(/`\$\{salt\}:\$\{hash\}`/);
    }
  });

  it('produces a hash the real verifyPassword accepts', () => {
    const stored = mirrorHash('Str0ng!Pass');
    expect(verifyPassword('Str0ng!Pass', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('salts per call — two hashes of the same password differ', () => {
    expect(mirrorHash('Str0ng!Pass')).not.toBe(mirrorHash('Str0ng!Pass'));
  });
});

describe('setup:save-config password handling', () => {
  it('hashes a plaintext password rather than storing it', () => {
    // The config object written to disk must only ever carry passwordHash.
    expect(HANDLER_SRC).toMatch(/passwordHash:\s*hashPassword\(c\.password\)/);
    expect(HANDLER_SRC).not.toMatch(/password:\s*c\.password/);
  });

  it('still accepts a pre-computed passwordHash', () => {
    expect(HANDLER_SRC).toMatch(/passwordHash:\s*c\.passwordHash/);
  });
});
