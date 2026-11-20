// test/machineAccountSettings.test.ts — plan 18, stage 2: what this computer tells and allows its account.
//
//   showOnAccount   "Show this computer to my account" (publishes its addresses). On by default.
//   addresses       which ones: home network on, Tailscale on, Public IP OFF until ticked (plain HTTP).
//   computerEnroll  'ask' (Allow once per computer, the default) or 'auto' (connect without asking).
// In server-config.json as `showOnAccount`, `accountAddresses` and `computerAccountEnroll`; a headless server
// sets AASC_SHOW_ON_ACCOUNT=1|0 and AASC_COMPUTER_ACCOUNT_ENROLL=ask|auto, which win over the file. Anything
// unreadable falls to the careful side: Public IP off, and ask.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterAll, vi } from 'vitest';
import {
  createMachineAccountSettings, resolveMachineAccountSettings, type MachineAccountSettings,
} from '../server/mobile/machineAccountSettings.js';
import { createAccountEnrollSetting } from '../server/mobile/accountEnrollSetting.js';

const DEFAULTS: MachineAccountSettings = {
  showOnAccount: true,
  addresses: { lan: true, tailnet: true, public: false },
  computerEnroll: 'ask',
};

describe('resolveMachineAccountSettings', () => {
  it('defaults to shown, home network and Tailscale, no public address, and asking', () => {
    expect(resolveMachineAccountSettings({}, {})).toEqual(DEFAULTS);
  });

  it('reads the file', () => {
    expect(resolveMachineAccountSettings({
      showOnAccount: false, accountAddresses: { lan: false, tailnet: false, public: true }, computerAccountEnroll: 'auto',
    }, {})).toEqual({ showOnAccount: false, addresses: { lan: false, tailnet: false, public: true }, computerEnroll: 'auto' });
  });

  it('fills in what the file leaves out', () => {
    expect(resolveMachineAccountSettings({ accountAddresses: { public: true } }, {}))
      .toEqual({ ...DEFAULTS, addresses: { lan: true, tailnet: true, public: true } });
  });

  it('lets the environment win', () => {
    expect(resolveMachineAccountSettings({ showOnAccount: true }, { AASC_SHOW_ON_ACCOUNT: '0' }).showOnAccount).toBe(false);
    expect(resolveMachineAccountSettings({ showOnAccount: false }, { AASC_SHOW_ON_ACCOUNT: ' TRUE ' }).showOnAccount).toBe(true);
    expect(resolveMachineAccountSettings({ computerAccountEnroll: 'ask' }, { AASC_COMPUTER_ACCOUNT_ENROLL: 'auto' }).computerEnroll).toBe('auto');
    expect(resolveMachineAccountSettings({ computerAccountEnroll: 'auto' }, { AASC_COMPUTER_ACCOUNT_ENROLL: ' Ask ' }).computerEnroll).toBe('ask');
  });

  it('ignores an environment value it doesn\'t know', () => {
    expect(resolveMachineAccountSettings({ showOnAccount: false }, { AASC_SHOW_ON_ACCOUNT: 'yes' }).showOnAccount).toBe(false);
    expect(resolveMachineAccountSettings({ computerAccountEnroll: 'auto' }, { AASC_COMPUTER_ACCOUNT_ENROLL: '1' }).computerEnroll).toBe('auto');
    expect(resolveMachineAccountSettings({}, { AASC_COMPUTER_ACCOUNT_ENROLL: 'always' }).computerEnroll).toBe('ask');
  });

  it('falls to the careful side for anything in the file it can\'t read', () => {
    const odd = {
      showOnAccount: 'false', accountAddresses: { lan: 0, tailnet: 'no', public: 'true' }, computerAccountEnroll: 'yes',
    } as unknown as Parameters<typeof resolveMachineAccountSettings>[0];
    expect(resolveMachineAccountSettings(odd, {})).toEqual(DEFAULTS);
    const worse = { accountAddresses: 'all', computerAccountEnroll: true } as unknown as Parameters<typeof resolveMachineAccountSettings>[0];
    expect(resolveMachineAccountSettings(worse, {})).toEqual(DEFAULTS);
  });
});

describe('createMachineAccountSettings', () => {
  const root = mkdtempSync(join(tmpdir(), 'aasc-machine-settings-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let n = 0;
  const fresh = () => join(root, `case-${++n}`, 'server-config.json');
  const CHOICE: MachineAccountSettings = {
    showOnAccount: true, addresses: { lan: true, tailnet: false, public: true }, computerEnroll: 'auto',
  };

  it('saves the choice into server-config.json, keeping every other key, owner-only', () => {
    const file = fresh();
    const dir = join(file, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ port: 4444, passwordHash: 'scrypt$abc', phoneAccountEnroll: false }), { mode: 0o600 });
    const settings = createMachineAccountSettings({ configPath: file, saved: {}, env: {} });
    expect(settings.get()).toEqual(DEFAULTS);
    expect(settings.set(CHOICE)).toEqual({ ok: true });
    expect(settings.get()).toEqual(CHOICE);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      port: 4444, passwordHash: 'scrypt$abc', phoneAccountEnroll: false,
      showOnAccount: true, accountAddresses: { lan: true, tailnet: false, public: true }, computerAccountEnroll: 'auto',
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['server-config.json']); // no temp file left behind
  });

  it('starts from the saved values and creates the file when there is none', () => {
    const file = fresh();
    const settings = createMachineAccountSettings({ configPath: file, saved: { showOnAccount: false, computerAccountEnroll: 'auto' }, env: {} });
    expect(settings.get()).toEqual({ ...DEFAULTS, showOnAccount: false, computerEnroll: 'auto' });
    expect(settings.set(DEFAULTS)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      showOnAccount: true, accountAddresses: { lan: true, tailnet: true, public: false }, computerAccountEnroll: 'ask',
    });
  });

  it('keeps the phone setting\'s own save and this one from undoing each other', () => {
    const file = fresh();
    const settings = createMachineAccountSettings({ configPath: file, saved: {}, env: {} });
    const phones = createAccountEnrollSetting({ configPath: file, saved: undefined, env: {} });
    settings.set(CHOICE);
    phones.set(false);
    settings.set({ ...CHOICE, computerEnroll: 'ask' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ phoneAccountEnroll: false, computerAccountEnroll: 'ask', showOnAccount: true });
  });

  it('refuses a change to what the environment pins, names it, and writes nothing', () => {
    const file = fresh();
    const settings = createMachineAccountSettings({
      configPath: file, saved: {}, env: { AASC_SHOW_ON_ACCOUNT: '0', AASC_COMPUTER_ACCOUNT_ENROLL: 'ask' },
    });
    expect(settings.pinnedByEnv()).toEqual(['showOnAccount', 'computerEnroll']);
    expect(settings.get()).toMatchObject({ showOnAccount: false, computerEnroll: 'ask' });
    expect(settings.set({ ...DEFAULTS, showOnAccount: true })).toEqual({ ok: false, pinned: 'showOnAccount' });
    expect(settings.set({ ...DEFAULTS, showOnAccount: false, computerEnroll: 'auto' })).toEqual({ ok: false, pinned: 'computerEnroll' });
    expect(existsSync(file)).toBe(false);
  });

  it('saves the rest when the pinned values are left as the environment has them, without writing those', () => {
    const file = fresh();
    const settings = createMachineAccountSettings({ configPath: file, saved: {}, env: { AASC_COMPUTER_ACCOUNT_ENROLL: 'auto' } });
    expect(settings.pinnedByEnv()).toEqual(['computerEnroll']);
    expect(settings.set({ showOnAccount: false, addresses: { lan: false, tailnet: true, public: false }, computerEnroll: 'auto' }))
      .toEqual({ ok: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      showOnAccount: false, accountAddresses: { lan: false, tailnet: true, public: false },
    });
    expect(settings.get()).toEqual({ showOnAccount: false, addresses: { lan: false, tailnet: true, public: false }, computerEnroll: 'auto' });
  });

  it('refuses to overwrite a config it can\'t read as an object, and keeps the old choice', () => {
    for (const content of ['{ broken', '[1,2]', 'null']) {
      const file = fresh();
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, content);
      const settings = createMachineAccountSettings({ configPath: file, saved: {}, env: {} });
      expect(() => settings.set(CHOICE)).toThrow();
      expect(readFileSync(file, 'utf8')).toBe(content);
      expect(settings.get()).toEqual(DEFAULTS);
    }
  });

  it('tells its listeners after a save, and only then', () => {
    const file = fresh();
    const settings = createMachineAccountSettings({ configPath: file, saved: {}, env: { AASC_SHOW_ON_ACCOUNT: '1' } });
    const heard = vi.fn();
    const stop = settings.onChange(heard);
    settings.set({ ...DEFAULTS, showOnAccount: false }); // pinned: refused
    expect(heard).not.toHaveBeenCalled();
    settings.set(CHOICE);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith(CHOICE);
    stop();
    settings.set(DEFAULTS);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('a listener that throws never fails the save', () => {
    const settings = createMachineAccountSettings({ configPath: fresh(), saved: {}, env: {} });
    settings.onChange(() => { throw new Error('boom'); });
    expect(settings.set(CHOICE)).toEqual({ ok: true });
    expect(settings.get()).toEqual(CHOICE);
  });
});
