// test/sessionHookLevel.test.ts — the per-session Automation mark (lite hooks).
//
// A session marked Automation runs with AASC_HOOK_LEVEL=lite in its PTY, and the hook scripts drop every event
// outside LITE_HOOK_EVENTS before their ps / jq / queue write. Running a whole hook script would append to the live
// dashboard queue (/tmp/claude-session-center/queue.jsonl is hard-coded), so this runs only the scripts' own lite
// block, extracted from each file, followed by an `echo` that shows whether the event went on.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  HOOK_LEVEL_ENV,
  LITE_HOOK_EVENTS,
  hookLevelConfigOf,
  hookLevelExport,
  isLiteHookLevel,
  withHookLevelEnv,
} from '../server/sessionHookLevel.js';
import { CODEX_DENSITY_EVENTS, DENSITY_EVENTS } from '../server/constants.js';

const SCRIPTS = {
  claude: fileURLToPath(new URL('../hooks/dashboard-hook.sh', import.meta.url)),
  codex: fileURLToPath(new URL('../hooks/dashboard-hook-codex.sh', import.meta.url)),
};
const PS1 = fileURLToPath(new URL('../hooks/dashboard-hook.ps1', import.meta.url));

/** The lite block of a bash hook script: from its AASC_HOOK_LEVEL test to the `fi` that closes it. */
function liteBlock(path: string): string {
  const src = readFileSync(path, 'utf8');
  const start = src.indexOf('if [ "${AASC_HOOK_LEVEL:-}" = "lite" ]; then');
  if (start < 0) throw new Error(`lite block not found in ${path}`);
  const end = src.indexOf('\nfi\n', start);
  if (end < 0) throw new Error(`lite block not closed in ${path}`);
  return src.slice(start, end + 4);
}

/** Run a script's lite block on a payload. True when the event went on (the block did not exit). */
function goesOn(path: string, payload: string, env: Record<string, string> = { [HOOK_LEVEL_ENV]: 'lite' }): boolean {
  const program = `INPUT=$(cat)\n${liteBlock(path)}\necho PASSED\n`;
  const { [HOOK_LEVEL_ENV]: _drop, ...parent } = process.env;
  void _drop;
  const res = spawnSync('bash', ['-c', program], { input: payload, encoding: 'utf8', env: { ...parent, ...env } });
  if (res.status !== 0) throw new Error(`bash failed (${res.status}): ${res.stderr}`);
  return res.stdout.trim() === 'PASSED';
}

const event = (name: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: 's1', hook_event_name: name, ...extra });

describe('LITE_HOOK_EVENTS', () => {
  it('is global density Low for both CLIs', () => {
    expect([...LITE_HOOK_EVENTS].sort()).toEqual([...new Set([...DENSITY_EVENTS.low, ...CODEX_DENSITY_EVENTS.low])].sort());
    expect(LITE_HOOK_EVENTS).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd']));
    expect(LITE_HOOK_EVENTS).not.toContain('PreToolUse');
  });

  it.each(Object.entries(SCRIPTS))('is the list the %s bash script lets through', (_cli, path) => {
    const listed = /\n\s*([A-Za-z|]+)\) ;;\n/.exec(liteBlock(path))?.[1].split('|') ?? [];
    expect(listed.sort()).toEqual([...LITE_HOOK_EVENTS].sort());
  });

  it('is the list the Windows script lets through', () => {
    const src = readFileSync(PS1, 'utf8');
    const listed = /@\(([^)]*)\) -notcontains/.exec(src)?.[1].match(/'([A-Za-z]+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
    expect(listed.sort()).toEqual([...LITE_HOOK_EVENTS].sort());
    expect(src).toContain("$env:AASC_HOOK_LEVEL -eq 'lite'");
  });
});

describe.each(Object.entries(SCRIPTS))('%s hook script, lite block', (_cli, path) => {
  it.each(['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Notification', 'PreCompact', 'PostCompact'])(
    'drops %s in a lite session',
    (name) => {
      expect(goesOn(path, event(name, { tool_name: 'Bash' }))).toBe(false);
    },
  );

  it.each(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd'])('sends %s in a lite session', (name) => {
    expect(goesOn(path, event(name))).toBe(true);
  });

  it('sends every event when the session is not lite', () => {
    expect(goesOn(path, event('PreToolUse'), {})).toBe(true);
    expect(goesOn(path, event('PreToolUse'), { [HOOK_LEVEL_ENV]: 'full' })).toBe(true);
  });

  it('sends a payload with no readable event name (Codex legacy notify, a format change)', () => {
    expect(goesOn(path, JSON.stringify({ type: 'agent-turn-complete' }))).toBe(true);
  });

  it('reads the event name itself, not one quoted inside a tool input', () => {
    // The key is after the tool input, whose text names a lifecycle event: JSON escapes those quotes.
    const payload = JSON.stringify({ tool_input: { command: 'echo "hook_event_name":"Stop"' }, hook_event_name: 'PreToolUse' });
    expect(goesOn(path, payload)).toBe(false);
  });

  it('reads a name written with spaces around the colon', () => {
    expect(goesOn(path, '{"hook_event_name" : "PostToolUse"}')).toBe(false);
    expect(goesOn(path, '{"hook_event_name" : "Stop"}')).toBe(true);
  });
});

describe('PTY environment', () => {
  it('sets the variable for a local lite launch', () => {
    expect(withHookLevelEnv({ PATH: '/bin' }, 'lite', true)).toEqual({ PATH: '/bin', [HOOK_LEVEL_ENV]: 'lite' });
  });

  it('never passes on a level the server inherited', () => {
    const inherited = { PATH: '/bin', [HOOK_LEVEL_ENV]: 'lite' };
    expect(withHookLevelEnv(inherited, undefined, true)).toEqual({ PATH: '/bin' });
    expect(withHookLevelEnv(inherited, 'lite', false)).toEqual({ PATH: '/bin' });
    expect(inherited[HOOK_LEVEL_ENV]).toBe('lite');
  });

  it('sets it in a local lite tmux pane, clears it in any other local pane, and leaves a remote one alone', () => {
    expect(hookLevelExport('lite', true)).toBe(`export ${HOOK_LEVEL_ENV}=lite && `);
    expect(hookLevelExport(undefined, true)).toBe(`unset ${HOOK_LEVEL_ENV} && `);
    expect(hookLevelExport('lite', false)).toBe('');
    expect(hookLevelExport(undefined, false)).toBe('');
  });

  it('carries a card\'s mark into a relaunch config, and nothing else', () => {
    expect(hookLevelConfigOf({ hookLevel: 'lite' })).toEqual({ hookLevel: 'lite' });
    expect(hookLevelConfigOf({})).toEqual({});
    expect(hookLevelConfigOf(null)).toEqual({});
    expect(isLiteHookLevel('LITE')).toBe(false);
  });
});
