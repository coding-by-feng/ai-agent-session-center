// test/phoneAccountEnrollSetting.test.ts — plan 17: "Let phones signed into my AASC Cloud account connect".
//
// On by default. `"phoneAccountEnroll": false` in server-config.json turns it off; AASC_PHONE_ACCOUNT_ENROLL=1|0
// (or true|false) wins over the file, as AASC_PHONE_PAIRING does. The desktop's switch saves the choice into
// server-config.json with an atomic write that keeps every other key, and refuses to overwrite a file it can't
// read as a JSON object (it holds the password hash).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterAll } from 'vitest';
import { createAccountEnrollSetting, isPhoneAccountEnrollOn } from '../server/mobile/accountEnrollSetting.js';

describe('isPhoneAccountEnrollOn', () => {
  it('is on by default and with true in the file', () => {
    expect(isPhoneAccountEnrollOn({}, {})).toBe(true);
    expect(isPhoneAccountEnrollOn({ phoneAccountEnroll: true }, {})).toBe(true);
  });

  it('turns off with phoneAccountEnroll: false', () => {
    expect(isPhoneAccountEnrollOn({ phoneAccountEnroll: false }, {})).toBe(false);
  });

  it('lets the environment win', () => {
    expect(isPhoneAccountEnrollOn({ phoneAccountEnroll: false }, { AASC_PHONE_ACCOUNT_ENROLL: '1' })).toBe(true);
    expect(isPhoneAccountEnrollOn({ phoneAccountEnroll: false }, { AASC_PHONE_ACCOUNT_ENROLL: 'true' })).toBe(true);
    expect(isPhoneAccountEnrollOn({}, { AASC_PHONE_ACCOUNT_ENROLL: '0' })).toBe(false);
    expect(isPhoneAccountEnrollOn({ phoneAccountEnroll: true }, { AASC_PHONE_ACCOUNT_ENROLL: ' FALSE ' })).toBe(false);
  });

  it('ignores an environment value it doesn\'t know, and a non-boolean in the file', () => {
    expect(isPhoneAccountEnrollOn({}, { AASC_PHONE_ACCOUNT_ENROLL: 'no' })).toBe(true);
    expect(isPhoneAccountEnrollOn({ phoneAccountEnroll: false }, { AASC_PHONE_ACCOUNT_ENROLL: '' })).toBe(false);
    expect(isPhoneAccountEnrollOn({ phoneAccountEnroll: 'false' as unknown as boolean }, {})).toBe(true);
  });
});

describe('createAccountEnrollSetting', () => {
  const root = mkdtempSync(join(tmpdir(), 'aasc-enroll-setting-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let n = 0;
  const fresh = () => join(root, `case-${++n}`, 'server-config.json');

  it('saves the choice into server-config.json, keeping every other key, owner-only', () => {
    const file = fresh();
    const dir = join(file, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ port: 4444, passwordHash: 'scrypt$abc' }), { mode: 0o600 });
    const setting = createAccountEnrollSetting({ configPath: file, saved: undefined, env: {} });
    expect(setting.enabled()).toBe(true);
    expect(setting.set(false)).toBe(true);
    expect(setting.enabled()).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ port: 4444, passwordHash: 'scrypt$abc', phoneAccountEnroll: false });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['server-config.json']); // no temp file left behind
    expect(setting.set(true)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).phoneAccountEnroll).toBe(true);
  });

  it('starts from the saved value', () => {
    expect(createAccountEnrollSetting({ configPath: fresh(), saved: false, env: {} }).enabled()).toBe(false);
  });

  it('creates the file when there is none', () => {
    const file = fresh();
    const setting = createAccountEnrollSetting({ configPath: file, saved: undefined, env: {} });
    expect(setting.set(false)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ phoneAccountEnroll: false });
  });

  it('refuses to change a switch the environment pins, and writes nothing', () => {
    const file = fresh();
    const setting = createAccountEnrollSetting({ configPath: file, saved: undefined, env: { AASC_PHONE_ACCOUNT_ENROLL: '1' } });
    expect(setting.pinnedByEnv()).toBe(true);
    expect(setting.set(false)).toBe(false);
    expect(setting.enabled()).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses to overwrite a config it can\'t read as an object', () => {
    for (const content of ['{ broken', '[1,2]', 'null']) {
      const file = fresh();
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, content);
      const setting = createAccountEnrollSetting({ configPath: file, saved: undefined, env: {} });
      expect(() => setting.set(false)).toThrow();
      expect(readFileSync(file, 'utf8')).toBe(content);
      expect(setting.enabled()).toBe(true);
    }
  });
});
