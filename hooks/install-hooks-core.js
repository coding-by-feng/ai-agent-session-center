// install-hooks-core.js — Pure logic functions for hook installation.
// No console output, no process.exit(). Used by both CLI and programmatic API.

import { writeFileSync, copyFileSync, chmodSync, renameSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';

// Atomic JSON file write: writes to temp file, then renames
export function atomicWriteJSON(filePath, data) {
  const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

// Build a single hook entry object for a given event
export function buildHookEntry(hookCommand, hookSource) {
  return {
    _source: hookSource,
    hooks: [{
      type: 'command',
      command: hookCommand,
      async: true,
    }],
  };
}

// Deploy a hook script from src to dest, with chmod on non-Windows
export function deployHookScript(srcPath, destPath, isWindows) {
  copyFileSync(srcPath, destPath);
  if (!isWindows) {
    chmodSync(destPath, 0o755);
  }
}

function escapeTomlString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Remove dashboard-owned Codex hook blocks from config.toml.
 * Handles the old notify= form and the current [[hooks.Event]] form while
 * preserving unrelated Codex config and third-party hooks.
 */
export function removeAllCodexHooksToml(toml, hookPattern, hookSource) {
  const lines = String(toml || '').split('\n');
  const kept = [];
  let removed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (
      line.includes(`[${hookSource}]`) ||
      (line.includes(hookPattern) && trimmed.startsWith('notify'))
    ) {
      removed++;
      continue;
    }

    const blockStart = trimmed.match(/^\[\[hooks\.[A-Za-z0-9_]+\]\]$/);
    if (blockStart) {
      const block = [line];
      i++;
      while (
        i < lines.length &&
        !/^\s*\[\[hooks\.[A-Za-z0-9_]+\]\]\s*$/.test(lines[i]) &&
        !/^\s*\[[^\[]/.test(lines[i])
      ) {
        block.push(lines[i]);
        i++;
      }
      i--;

      if (!block.some(l => l.includes(hookPattern))) {
        kept.push(...block);
        continue;
      }

      const eventHeader = block[0];
      const eventName = blockStart[0].match(/^\[\[hooks\.([A-Za-z0-9_]+)\]\]$/)?.[1];
      const nestedHookStart = eventName
        ? new RegExp(`^\\s*\\[\\[hooks\\.${eventName}\\.hooks\\]\\]\\s*$`)
        : null;
      const prefix = [eventHeader];
      const hookBlocks = [];
      let currentHook = null;

      for (let j = 1; j < block.length; j++) {
        const blockLine = block[j];
        if (nestedHookStart?.test(blockLine)) {
          if (currentHook) hookBlocks.push(currentHook);
          currentHook = [blockLine];
          continue;
        }
        if (currentHook) {
          currentHook.push(blockLine);
        } else {
          prefix.push(blockLine);
        }
      }
      if (currentHook) hookBlocks.push(currentHook);

      const remainingHookBlocks = [];
      for (const hookBlock of hookBlocks) {
        if (hookBlock.some(l => l.includes(hookPattern))) {
          removed++;
        } else {
          remainingHookBlocks.push(hookBlock);
        }
      }

      if (remainingHookBlocks.length > 0) {
        if (kept.length > 0 && kept[kept.length - 1].includes(`[${hookSource}]`)) {
          kept.pop();
        }
        kept.push(...prefix, ...remainingHookBlocks.flat());
      } else {
        if (hookBlocks.length === 0) removed++;
        if (kept.length > 0 && kept[kept.length - 1].includes(`[${hookSource}]`)) {
          kept.pop();
        }
      }
      continue;
    }

    kept.push(line);
  }

  return { toml: kept.join('\n').replace(/\n{3,}/g, '\n\n'), removed };
}

export function configureCodexHooksToml(toml, events, hookCommand, hookPattern, hookSource) {
  const cleaned = removeAllCodexHooksToml(toml, hookPattern, hookSource);
  let nextToml = cleaned.toml.trimEnd();
  const command = escapeTomlString(hookCommand);
  // Codex emits Stop / agent-turn-complete only through the legacy `notify`
  // entry, never through [[hooks.X]] blocks. Keep both forms so the dashboard
  // gets the full lifecycle: notify → Stop (red ! attention badge), plus the
  // new [[hooks.X]] blocks → PreToolUse / PostToolUse (orange working state).
  const blocks = [
    '',
    `# [${hookSource}] Dashboard hook -- safe to remove with "npm run reset"`,
    `notify = "${command}"`,
    '',
    `# [${hookSource}] Dashboard Codex lifecycle hooks`,
    ...events.flatMap(event => [
      `[[hooks.${event}]]`,
      `[[hooks.${event}.hooks]]`,
      'type = "command"',
      `command = "${command}"`,
      'async = true',
      '',
    ]),
  ].join('\n');

  nextToml += blocks;
  if (!nextToml.endsWith('\n')) nextToml += '\n';
  return { toml: nextToml, added: events.length, removed: cleaned.removed };
}

// Configure Claude hooks in a settings object.
// Adds/updates hooks for events in the density set, removes hooks for excluded events.
// Returns { added, updated, removed, unchanged }.
export function configureClaudeHooks(settings, events, allEvents, hookCommand, hookPattern, hookSource) {
  if (!settings.hooks) settings.hooks = {};

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let removed = 0;

  // Add/update hooks for events in the selected density
  for (const event of events) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    const existingIdx = settings.hooks[event].findIndex(group =>
      group.hooks?.some(h => h.command?.includes(hookPattern))
    );

    if (existingIdx >= 0) {
      const group = settings.hooks[event][existingIdx];
      const hookEntry = group.hooks.find(h => h.command?.includes(hookPattern));
      if (hookEntry && hookEntry.command !== hookCommand) {
        hookEntry.command = hookCommand;
        updated++;
      } else {
        unchanged++;
      }
    } else {
      settings.hooks[event].push(buildHookEntry(hookCommand, hookSource));
      added++;
    }
  }

  // Remove hooks for events NOT in the selected density
  const excludedEvents = allEvents.filter(e => !events.includes(e));
  for (const event of excludedEvents) {
    if (!settings.hooks[event]) continue;
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(group =>
      !group.hooks?.some(h => h.command?.includes(hookPattern))
    );
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
    if (before !== (settings.hooks[event]?.length ?? 0)) {
      removed++;
    }
  }

  return { added, updated, removed, unchanged };
}

// Remove all dashboard hooks from settings (uninstall mode).
// Returns the number of events that had hooks removed.
export function removeAllClaudeHooks(settings, allEvents, hookPattern) {
  if (!settings.hooks) return 0;

  let removed = 0;
  for (const event of allEvents) {
    if (!settings.hooks[event]) continue;
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(group =>
      !group.hooks?.some(h => h.command?.includes(hookPattern))
    );
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
    if (before !== (settings.hooks[event]?.length ?? 0)) {
      removed++;
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    settings.hooks = {};
  }

  return removed;
}

// Configure Gemini hooks in a settings object.
// Returns the number of events added.
export function configureGeminiHooks(settings, events, hookSource) {
  if (!settings.hooks) settings.hooks = {};

  let added = 0;
  for (const event of events) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const has = settings.hooks[event].some(g =>
      g.hooks?.some(h => h.command?.includes('dashboard-hook'))
    );
    if (!has) {
      settings.hooks[event].push({
        _source: hookSource,
        hooks: [{ type: 'command', command: `~/.gemini/hooks/dashboard-hook.sh ${event}` }],
      });
      added++;
    }
  }
  return added;
}
