const COMMAND_USAGE_KEY = 'command-usage-counts';

// Shared command presets for session creation command comboboxes.
export const DEFAULT_SESSION_COMMANDS: string[] = [
  'claude',
  'claude --resume',
  'claude --continue',
  'claude --model sonnet',
  'claude --model opus',
  'claude --dangerously-skip-permissions',
  'claude --verbose',
  'gemini',
  'gemini --yolo',
  'codex',
  'codex --dangerously-bypass-approvals-and-sandbox',
  'aider',
];

function loadCommandUsageCounts(): Record<string, number> {
  try {
    const storage = globalThis.localStorage;
    if (!storage || typeof storage.getItem !== 'function') return {};
    return JSON.parse(storage.getItem(COMMAND_USAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

/** Sort by usage frequency (most used first), then append unused defaults. */
export function getCommandSuggestions(defaultCommands: readonly string[] = DEFAULT_SESSION_COMMANDS): string[] {
  const counts = loadCommandUsageCounts();
  const usedSorted = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([cmd]) => cmd);
  const seen = new Set(usedSorted);
  const result = [...usedSorted];
  for (const cmd of defaultCommands) {
    if (!seen.has(cmd)) result.push(cmd);
  }
  return result;
}

export function saveCommand(cmd: string): void {
  if (!cmd) return;
  const storage = globalThis.localStorage;
  if (!storage || typeof storage.setItem !== 'function') return;
  const counts = loadCommandUsageCounts();
  counts[cmd] = (counts[cmd] || 0) + 1;
  storage.setItem(COMMAND_USAGE_KEY, JSON.stringify(counts));
}
