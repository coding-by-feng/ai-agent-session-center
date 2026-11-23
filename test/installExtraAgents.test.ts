/**
 * hooks/install-extra-agents.js — OpenCode plugin + Antigravity hooks.json install/remove, in a scratch home.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  installOpencodePlugin, removeOpencodePlugin, opencodePluginInstalled, opencodePluginPaths,
  installAgyHooks, uninstallAgyHooks, readAgyHookEvents, configureAgyHooks, agyPaths, AGY_HOOK_NAME,
} from '../hooks/install-extra-agents.js';

const hooksDir = join(__dirname, '..', 'hooks');
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'extra-agents-home-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('OpenCode plugin install', () => {
  it('copies the plugin into the global plugins folder, once', () => {
    expect(installOpencodePlugin({ hooksDir, home })).toBe('installed');
    expect(installOpencodePlugin({ hooksDir, home })).toBe('unchanged');
    expect(opencodePluginInstalled(home)).toBe(true);
    expect(readFileSync(opencodePluginPaths(home).file, 'utf8')).toBe(readFileSync(join(hooksDir, 'opencode-plugin', 'server.js'), 'utf8'));
  });

  it('removes only a plugin that is ours', () => {
    const { dir, file } = opencodePluginPaths(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, 'export default {} // someone else’s plugin');
    expect(removeOpencodePlugin({ home })).toBe(false);
    expect(existsSync(file)).toBe(true);
    installOpencodePlugin({ hooksDir, home });
    expect(removeOpencodePlugin({ home })).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('Antigravity hooks install', () => {
  it('registers our named hook in agy’s format and keeps the user’s own hooks', () => {
    const p = agyPaths(home);
    mkdirSync(p.configDir, { recursive: true });
    const mine = { 'lint-checker': { PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh' }] }] } };
    writeFileSync(p.hooksFile, JSON.stringify(mine));

    expect(installAgyHooks({ hooksDir, home })).toEqual({ relay: 'installed', hooks: 'registered' });
    const cfg = JSON.parse(readFileSync(p.hooksFile, 'utf8'));
    expect(cfg['lint-checker']).toEqual(mine['lint-checker']);
    expect(cfg[AGY_HOOK_NAME].SessionStart).toEqual([{ type: 'command', command: `exec ${p.relayCommand} SessionStart`, timeout: 10 }]);
    expect(cfg[AGY_HOOK_NAME].PreToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: `exec ${p.relayCommand} PreToolUse`, timeout: 10 }] }]);
    expect(readAgyHookEvents(home)).toEqual(['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);
    expect(statSync(p.relay).mode & 0o111).toBeTruthy();
    expect(installAgyHooks({ hooksDir, home })).toEqual({ relay: 'unchanged', hooks: 'unchanged' });
  });

  it('low density keeps only the turn lifecycle', () => {
    installAgyHooks({ hooksDir, home, density: 'low' });
    expect(readAgyHookEvents(home)).toEqual(['SessionStart', 'PreInvocation', 'Stop']);
  });

  it('never overwrites a hooks.json it cannot parse', () => {
    const p = agyPaths(home);
    mkdirSync(p.configDir, { recursive: true });
    writeFileSync(p.hooksFile, '{ not json');
    expect(() => installAgyHooks({ hooksDir, home })).toThrow();
    expect(readFileSync(p.hooksFile, 'utf8')).toBe('{ not json');
  });

  it('uninstall removes our hook and relay, nothing else', () => {
    const p = agyPaths(home);
    installAgyHooks({ hooksDir, home });
    const cfg = JSON.parse(readFileSync(p.hooksFile, 'utf8'));
    writeFileSync(p.hooksFile, JSON.stringify({ ...cfg, reminder: { PreInvocation: [{ command: './r.sh' }] } }));
    expect(uninstallAgyHooks({ home })).toEqual({ hooksRemoved: true, relayRemoved: true });
    expect(JSON.parse(readFileSync(p.hooksFile, 'utf8'))).toEqual({ reminder: { PreInvocation: [{ command: './r.sh' }] } });
    expect(existsSync(p.relayDir)).toBe(false);
    expect(uninstallAgyHooks({ home })).toEqual({ hooksRemoved: false, relayRemoved: false });
  });

  it('configureAgyHooks does not change its input', () => {
    const input = { other: {} };
    const out = configureAgyHooks(input, ['Stop'], '~/r.sh');
    expect(input).toEqual({ other: {} });
    expect(Object.keys(out)).toEqual(['other', AGY_HOOK_NAME]);
  });
});
