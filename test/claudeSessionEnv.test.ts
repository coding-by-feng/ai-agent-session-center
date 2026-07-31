// test/claudeSessionEnv.test.ts — a dashboard-spawned PTY must never inherit the
// launching Claude Code session's identity markers.
//
// Regression guard for a silent, total loss of transcript persistence:
// when the dashboard itself is started from inside a Claude Code session (an
// agent running `npm run electron:build` / `open`ing the app, `npm run dev`
// from an agent terminal), its own process.env carries
//   CLAUDECODE=1, CLAUDE_CODE_CHILD_SESSION=1, CLAUDE_CODE_SESSION_ID=<parent>
// Every PTY inherits that env, and Claude Code ≥ 2.1.x reads
// CLAUDE_CODE_CHILD_SESSION as "I am a nested child/subagent session" and
// DISABLES transcript persistence ("⚠ Transcript saving is off — inherited
// CLAUDE_CODE_CHILD_SESSION marker"). No ~/.claude/projects/<enc>/<id>.jsonl is
// ever written, so every later `claude --resume <id>` / `--fork-session <id>`
// dies with "No conversation found with session ID: <id>" — a dead AI-popup
// float, a fresh-instead-of-resumed session on workspace restore, an empty
// Conversation tab, and no translate-answer.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  INHERITED_CLAUDE_SESSION_ENV_KEYS,
  stripInheritedClaudeSessionEnv,
} from '../server/config.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('INHERITED_CLAUDE_SESSION_ENV_KEYS', () => {
  it('strips the marker that disables Claude Code transcript persistence', () => {
    expect(INHERITED_CLAUDE_SESSION_ENV_KEYS).toContain('CLAUDE_CODE_CHILD_SESSION');
  });

  it('strips the nested-session flag and the parent session identity', () => {
    expect([...INHERITED_CLAUDE_SESSION_ENV_KEYS]).toEqual([
      'CLAUDECODE',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH',
    ]);
  });
});

describe('stripInheritedClaudeSessionEnv', () => {
  it('drops every inherited marker', () => {
    const env = stripInheritedClaudeSessionEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'e5d9a405-a454-4564-851e-776094a08a72',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: '/Users/x/.local/share/claude/versions/2.1.220',
      PATH: '/usr/bin',
    });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps credentials, config-dir overrides and the TUI opt-out', () => {
    const env = stripInheritedClaudeSessionEnv({
      CLAUDE_CODE_CHILD_SESSION: '1',
      ANTHROPIC_API_KEY: 'sk-x',
      OPENAI_API_KEY: 'sk-y',
      CLAUDE_CONFIG_DIR: '/Users/x/.claude',
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      AGENT_MANAGER_TERMINAL_ID: 'term-1',
    });
    expect(env).toEqual({
      ANTHROPIC_API_KEY: 'sk-x',
      OPENAI_API_KEY: 'sk-y',
      CLAUDE_CONFIG_DIR: '/Users/x/.claude',
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      AGENT_MANAGER_TERMINAL_ID: 'term-1',
    });
  });

  it('does not mutate the input env', () => {
    const input = { CLAUDECODE: '1', PATH: '/usr/bin' };
    const result = stripInheritedClaudeSessionEnv(input);
    expect(input).toEqual({ CLAUDECODE: '1', PATH: '/usr/bin' });
    expect(result).not.toBe(input);
  });

  it('drops undefined values so the result is a plain string env', () => {
    expect(stripInheritedClaudeSessionEnv({ PATH: '/usr/bin', EMPTY: undefined })).toEqual({
      PATH: '/usr/bin',
    });
  });

  it('is a no-op when the app was launched outside Claude Code', () => {
    expect(stripInheritedClaudeSessionEnv({ PATH: '/usr/bin', HOME: '/Users/x' })).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/x',
    });
  });
});

// electron/ptyHost.ts owns the Electron PTY path and cannot import from server/
// (separate tsconfig roots — same constraint that duplicates ptyRing.ts), so it
// mirrors the key list. Drift there silently restores the bug for every
// Electron-spawned session, which is the default transport.
describe('electron/ptyHost.ts mirror', () => {
  const src = readFileSync(join(repoRoot, 'electron/ptyHost.ts'), 'utf8');

  it('strips the same keys as the server implementation', () => {
    for (const key of INHERITED_CLAUDE_SESSION_ENV_KEYS) {
      expect(src).toContain(key);
    }
  });

  it('no longer destructures CLAUDECODE alone', () => {
    expect(src).not.toMatch(/const\s*\{\s*CLAUDECODE:\s*_drop,\s*\.\.\.parentEnv\s*\}/);
  });
});
