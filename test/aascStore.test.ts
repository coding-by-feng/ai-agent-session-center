import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync, existsSync, readdirSync, chmodSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configDir, createStore, isValidServerName } from '../cli/client/store.js';

const DEVICE_TOKEN = 'dGhpcyBpcyBhIGRldmljZSB0b2tlbiBmb3IgdGVzdHM';
const DEVICE_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

const mode = (p: string): number => statSync(p).mode & 0o777;

describe('aasc store', () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aasc-store-'));
    dir = configDir({ XDG_CONFIG_HOME: join(root, 'xdg'), HOME: join(root, 'home') });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('honours XDG_CONFIG_HOME, then falls back to ~/.config', () => {
    expect(dir).toBe(join(root, 'xdg', 'aasc'));
    expect(configDir({ HOME: join(root, 'home') })).toBe(join(root, 'home', '.config', 'aasc'));
    // An empty XDG_CONFIG_HOME counts as unset, as the XDG spec says.
    expect(configDir({ XDG_CONFIG_HOME: '', HOME: join(root, 'home') })).toBe(join(root, 'home', '.config', 'aasc'));
  });

  it('creates the folder 0700 and every file 0600', () => {
    const store = createStore(dir);
    const s = store.addServer({
      name: 'vps', mode: 'paired', deviceId: DEVICE_ID,
      addresses: { lan: '192.168.1.20', tailnet: '100.101.102.103', public: null }, port: 3333,
    }, DEVICE_TOKEN);
    store.writeLastLs([{ n: 1, server: 'vps', sessionId: 'sess-1' }]);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, 'keys'))).toBe(0o700);
    expect(mode(join(dir, 'servers.json'))).toBe(0o600);
    expect(mode(join(dir, 'keys', `${s.id}.key`))).toBe(0o600);
    expect(mode(join(dir, 'last-ls.json'))).toBe(0o600);
  });

  it('tightens a folder that already exists with looser modes', () => {
    createStore(dir).addServer({ name: 'a', mode: 'ssh', sshTarget: 'me@box', port: 3333 });
    chmodSync(dir, 0o755);
    chmodSync(join(dir, 'servers.json'), 0o644);
    createStore(dir).addServer({ name: 'b', mode: 'ssh', sshTarget: 'me@box2', port: 3333 });
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, 'servers.json'))).toBe(0o600);
  });

  it('never writes the device key into servers.json', () => {
    const store = createStore(dir);
    const s = store.addServer({
      name: 'vps', mode: 'paired', deviceId: DEVICE_ID,
      addresses: { lan: null, tailnet: '100.101.102.103', public: null }, port: 3333,
    }, DEVICE_TOKEN);
    const json = readFileSync(join(dir, 'servers.json'), 'utf8');
    expect(json).not.toContain(DEVICE_TOKEN);
    expect(readFileSync(join(dir, 'keys', `${s.id}.key`), 'utf8').trim()).toBe(DEVICE_TOKEN);
    expect(store.readKey(s.id)).toBe(DEVICE_TOKEN);
  });

  it('gives each server a stable id and client id that survive a reload', () => {
    const s = createStore(dir).addServer({ name: 'vps', mode: 'ssh', sshTarget: 'me@vps.example', port: 3333 });
    expect(s.id).toMatch(/^[0-9a-f]{32}$/);
    expect(s.clientId).toMatch(/^aasc-[0-9a-f-]{36}$/);
    expect(Number.isFinite(Date.parse(s.pairedAt))).toBe(true);
    const again = createStore(dir).getServer('vps');
    expect(again).toEqual(s);
  });

  it('refuses a duplicate name and an invalid name', () => {
    const store = createStore(dir);
    store.addServer({ name: 'vps', mode: 'ssh', sshTarget: 'me@vps.example', port: 3333 });
    expect(() => store.addServer({ name: 'vps', mode: 'ssh', sshTarget: 'me@other', port: 3333 })).toThrow(/already/);
    expect(isValidServerName('vps-2')).toBe(true);
    for (const bad of ['', 'a b', '-x', 'x:1', '../x', 'a'.repeat(33)]) expect(isValidServerName(bad)).toBe(false);
    expect(() => store.addServer({ name: 'a b', mode: 'ssh', sshTarget: 'me@x', port: 3333 })).toThrow();
  });

  it('remove forgets the server and deletes its key', () => {
    const store = createStore(dir);
    const s = store.addServer({
      name: 'vps', mode: 'paired', deviceId: DEVICE_ID,
      addresses: { lan: '192.168.1.20', tailnet: null, public: null }, port: 3333,
    }, DEVICE_TOKEN);
    expect(store.removeServer('vps')).toBe(true);
    expect(store.getServer('vps')).toBeNull();
    expect(existsSync(join(dir, 'keys', `${s.id}.key`))).toBe(false);
    expect(store.removeServer('vps')).toBe(false);
  });

  it('refuses a key file that others can read', () => {
    const store = createStore(dir);
    const s = store.addServer({
      name: 'vps', mode: 'paired', deviceId: DEVICE_ID,
      addresses: { lan: '192.168.1.20', tailnet: null, public: null }, port: 3333,
    }, DEVICE_TOKEN);
    chmodSync(join(dir, 'keys', `${s.id}.key`), 0o644);
    expect(() => store.readKey(s.id)).toThrow(/0600/);
  });

  it('reads an empty store as no servers and leaves no temp files behind', () => {
    const store = createStore(dir);
    expect(store.listServers()).toEqual([]);
    store.addServer({ name: 'vps', mode: 'ssh', sshTarget: 'me@vps.example', port: 3333 });
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('refuses a servers.json that fails the schema rather than guessing', () => {
    createStore(dir).addServer({ name: 'vps', mode: 'ssh', sshTarget: 'me@vps.example', port: 3333 });
    writeFileSync(join(dir, 'servers.json'), JSON.stringify([{ name: 'vps', mode: 'telnet' }]), { mode: 0o600 });
    expect(() => createStore(dir).listServers()).toThrow(/servers\.json/);
  });

  it('round-trips the last ls numbering', () => {
    const store = createStore(dir);
    store.writeLastLs([{ n: 1, server: 'vps', sessionId: 'a' }, { n: 2, server: 'vps', sessionId: 'b' }]);
    expect(store.readLastLs()).toEqual([{ n: 1, server: 'vps', sessionId: 'a' }, { n: 2, server: 'vps', sessionId: 'b' }]);
  });
  it('refuses a config folder that is a symlink', () => {
    const real = join(root, 'elsewhere');
    mkdirSync(real, { mode: 0o700 });
    mkdirSync(join(root, 'xdg'), { recursive: true });
    symlinkSync(real, dir);
    const store = createStore(dir);
    expect(() => store.addServer({ name: 'vps', mode: 'ssh', sshTarget: 'me@box', port: 3333 })).toThrow(/symlink/);
    expect(() => store.listServers()).toThrow(/symlink/);
  });

  it('refuses a folder, servers.json or key that another user owns', () => {
    const store = createStore(dir);
    const s = store.addServer({
      name: 'vps', mode: 'paired', deviceId: DEVICE_ID,
      addresses: { lan: '192.168.1.20', tailnet: null, public: null }, port: 3333,
    }, DEVICE_TOKEN);
    const someoneElse = createStore(dir, { uid: (process.getuid?.() ?? 0) + 1 });
    expect(() => someoneElse.listServers()).toThrow(/owned by another user/);
    expect(() => someoneElse.readKey(s.id)).toThrow(/owned by another user/);
  });

  it('refuses a servers.json that is a symlink', () => {
    const store = createStore(dir);
    store.addServer({ name: 'vps', mode: 'ssh', sshTarget: 'me@box', port: 3333 });
    const elsewhere = join(root, 'planted.json');
    writeFileSync(elsewhere, '[]', { mode: 0o600 });
    rmSync(join(dir, 'servers.json'));
    symlinkSync(elsewhere, join(dir, 'servers.json'));
    expect(() => createStore(dir).listServers()).toThrow(/symlink/);
  });
});
