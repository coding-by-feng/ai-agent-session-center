// install-extra-agents.js — install / remove the dashboard hooks of OpenCode and the Antigravity CLI (Nov 23 2026).
// Shared by the server's startup installer (server/hookInstaller.js) and the CLI installer (install-hooks-api.js).
// No console output: each function returns what it did.
//
// OpenCode 2.x  a server plugin: ~/.config/opencode/plugins/aasc-dashboard/server.js (OpenCode loads every folder
//               in its global plugins directory). Only ever removed when the file carries our marker.
// Antigravity   the named hook "aasc-dashboard" in ~/.gemini/config/hooks.json (agy's global hooks file; it does
//               not read hooks from antigravity-cli/settings.json), running a relay deployed beside it. Other named
//               hooks in that file are the user's and are never touched. This is NOT the retired Gemini CLI
//               integration (~/.gemini/settings.json + ~/.gemini/hooks/), which uninstall cleans separately.

import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

export const EXTRA_AGENT_CLIS = ['opencode', 'antigravity'];

export const OPENCODE_PLUGIN_MARKER = 'AI Agent Session Center — OpenCode 2.x server plugin';
export const AGY_HOOK_NAME = 'aasc-dashboard';

/** agy events per density. Low keeps the turn lifecycle; the others add tools. */
export const AGY_DENSITY_EVENTS = {
  high: ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop'],
  medium: ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop'],
  low: ['SessionStart', 'PreInvocation', 'Stop'],
};

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

export function opencodePluginPaths(home = homedir()) {
  const dir = join(home, '.config', 'opencode', 'plugins', 'aasc-dashboard');
  return { dir, file: join(dir, 'server.js') };
}

export function agyPaths(home = homedir()) {
  const configDir = join(home, '.gemini', 'config');
  const relayDir = join(configDir, 'aasc-dashboard');
  return {
    configDir,
    hooksFile: join(configDir, 'hooks.json'),
    relayDir,
    relay: join(relayDir, 'dashboard-hook-agy.sh'),
    // `~` is expanded by agy; `exec` keeps agy the relay's parent (its pid and tty identify the session).
    relayCommand: '~/.gemini/config/aasc-dashboard/dashboard-hook-agy.sh',
  };
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function sameContent(a, b) {
  try { return readFileSync(a, 'utf8') === readFileSync(b, 'utf8'); } catch { return false; }
}

// ── OpenCode ──

/** Copy the plugin into OpenCode's global plugins folder. Returns 'installed' | 'unchanged'. */
export function installOpencodePlugin({ hooksDir, home = homedir() }) {
  const src = join(hooksDir, 'opencode-plugin', 'server.js');
  if (!existsSync(src)) throw new Error(`OpenCode plugin not found: ${src}`);
  const { dir, file } = opencodePluginPaths(home);
  if (existsSync(file) && sameContent(src, file)) return 'unchanged';
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, file);
  return 'installed';
}

/** Remove our plugin folder, only when its file is ours. Returns whether it was removed. */
export function removeOpencodePlugin({ home = homedir() } = {}) {
  const { dir, file } = opencodePluginPaths(home);
  try {
    if (!existsSync(file) || !readFileSync(file, 'utf8').includes(OPENCODE_PLUGIN_MARKER)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function opencodePluginInstalled(home = homedir()) {
  const { file } = opencodePluginPaths(home);
  try { return readFileSync(file, 'utf8').includes(OPENCODE_PLUGIN_MARKER); } catch { return false; }
}

// ── Antigravity CLI ──

/**
 * Set the "aasc-dashboard" named hook in a parsed hooks.json object (agy's format: tool events are grouped under a
 * `matcher`, the others are flat handler lists). Returns the new object; the input is not changed.
 */
export function configureAgyHooks(config, events, relayCommand) {
  const handler = (event) => ({ type: 'command', command: `exec ${relayCommand} ${event}`, timeout: 10 });
  const spec = {};
  for (const event of events) {
    spec[event] = TOOL_EVENTS.has(event) ? [{ matcher: '*', hooks: [handler(event)] }] : [handler(event)];
  }
  const base = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  return { ...base, [AGY_HOOK_NAME]: spec };
}

/** The hooks.json object without our named hook, and whether it was there. */
export function removeAgyHooks(config) {
  if (!config || typeof config !== 'object' || !(AGY_HOOK_NAME in config)) return { config, removed: false };
  const { [AGY_HOOK_NAME]: _ours, ...rest } = config;
  return { config: rest, removed: true };
}

/** The events our named hook registers in a hooks.json object ([] when absent). */
export function agyHookEvents(config) {
  const spec = config && typeof config === 'object' ? config[AGY_HOOK_NAME] : null;
  return spec && typeof spec === 'object' ? Object.keys(spec).filter((k) => Array.isArray(spec[k])) : [];
}

function readJsonObject(file) {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed;
}

/** Deploy the relay and register it. Returns { relay: 'installed'|'unchanged', hooks: 'registered'|'unchanged' }. */
export function installAgyHooks({ hooksDir, density = 'medium', home = homedir() }) {
  const src = join(hooksDir, 'dashboard-hook-agy.sh');
  if (!existsSync(src)) throw new Error(`Antigravity hook relay not found: ${src}`);
  const p = agyPaths(home);
  let relay = 'unchanged';
  if (!(existsSync(p.relay) && sameContent(src, p.relay))) {
    mkdirSync(p.relayDir, { recursive: true });
    copyFileSync(src, p.relay);
    relay = 'installed';
  }
  chmodSync(p.relay, 0o755);

  // A hooks.json we cannot parse is the user's: leave it alone rather than overwrite it.
  const current = readJsonObject(p.hooksFile);
  const events = AGY_DENSITY_EVENTS[density] || AGY_DENSITY_EVENTS.medium;
  const next = configureAgyHooks(current, events, p.relayCommand);
  if (JSON.stringify(next) === JSON.stringify(current)) return { relay, hooks: 'unchanged' };
  mkdirSync(p.configDir, { recursive: true });
  writeJsonAtomic(p.hooksFile, next);
  return { relay, hooks: 'registered' };
}

/** Unregister and delete the relay. Returns { hooksRemoved, relayRemoved }. */
export function uninstallAgyHooks({ home = homedir() } = {}) {
  const p = agyPaths(home);
  let hooksRemoved = false;
  try {
    const current = readJsonObject(p.hooksFile);
    const { config, removed } = removeAgyHooks(current);
    if (removed) { writeJsonAtomic(p.hooksFile, config); hooksRemoved = true; }
  } catch { /* unreadable: the user's file, untouched */ }
  let relayRemoved = false;
  try {
    if (existsSync(p.relayDir)) { rmSync(p.relayDir, { recursive: true, force: true }); relayRemoved = true; }
  } catch { /* ignore */ }
  return { hooksRemoved, relayRemoved };
}

export function readAgyHookEvents(home = homedir()) {
  try { return agyHookEvents(readJsonObject(agyPaths(home).hooksFile)); } catch { return []; }
}
