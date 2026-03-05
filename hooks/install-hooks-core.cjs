// CJS version of install-hooks-core.js for Electron main process use.
// The .js version (ESM) is used by the CLI; this .cjs version is used by Electron.
'use strict';

const { writeFileSync, copyFileSync, chmodSync, renameSync, unlinkSync } = require('fs');
const { randomBytes } = require('crypto');

function atomicWriteJSON(filePath, data) {
  const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function buildHookEntry(hookCommand, hookSource) {
  return {
    _source: hookSource,
    hooks: [{ type: 'command', command: hookCommand, async: true }],
  };
}

function deployHookScript(srcPath, destPath, isWindows) {
  copyFileSync(srcPath, destPath);
  if (!isWindows) chmodSync(destPath, 0o755);
}

function configureClaudeHooks(settings, events, allEvents, hookCommand, hookPattern, hookSource) {
  if (!settings.hooks) settings.hooks = {};
  let added = 0, updated = 0, unchanged = 0, removed = 0;

  for (const event of events) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const existingIdx = settings.hooks[event].findIndex(g =>
      g.hooks?.some(h => h.command?.includes(hookPattern))
    );
    if (existingIdx >= 0) {
      const hookEntry = settings.hooks[event][existingIdx].hooks.find(h => h.command?.includes(hookPattern));
      if (hookEntry && hookEntry.command !== hookCommand) { hookEntry.command = hookCommand; updated++; }
      else unchanged++;
    } else {
      settings.hooks[event].push(buildHookEntry(hookCommand, hookSource));
      added++;
    }
  }

  const excluded = allEvents.filter(e => !events.includes(e));
  for (const event of excluded) {
    if (!settings.hooks[event]) continue;
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(g => !g.hooks?.some(h => h.command?.includes(hookPattern)));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
    if (before !== (settings.hooks[event]?.length ?? 0)) removed++;
  }
  return { added, updated, removed, unchanged };
}

function removeAllClaudeHooks(settings, allEvents, hookPattern) {
  if (!settings.hooks) return 0;
  let removed = 0;
  for (const event of allEvents) {
    if (!settings.hooks[event]) continue;
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(g => !g.hooks?.some(h => h.command?.includes(hookPattern)));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
    if (before !== (settings.hooks[event]?.length ?? 0)) removed++;
  }
  if (Object.keys(settings.hooks).length === 0) settings.hooks = {};
  return removed;
}

function configureGeminiHooks(settings, events, hookSource) {
  if (!settings.hooks) settings.hooks = {};
  let added = 0;
  for (const event of events) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const has = settings.hooks[event].some(g => g.hooks?.some(h => h.command?.includes('dashboard-hook')));
    if (!has) {
      settings.hooks[event].push({ _source: hookSource, hooks: [{ type: 'command', command: `~/.gemini/hooks/dashboard-hook.sh ${event}` }] });
      added++;
    }
  }
  return added;
}

module.exports = { atomicWriteJSON, buildHookEntry, deployHookScript, configureClaudeHooks, removeAllClaudeHooks, configureGeminiHooks };
