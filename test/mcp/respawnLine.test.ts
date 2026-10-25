// test/mcp/respawnLine.test.ts — the headless respawn's Claude line (server/respawnLine.ts, Ruling P3-39): after an
// AASC restart, `respawnSshTerminals` (server/index.ts) resumes a card from its stored `ps` args, so its name is rebuilt
// quoted from the card's title, as every other relaunch does (relaunchRule.ts `relaunchLineOf`). Pure, plus a read of
// index.ts's source to hold the respawn to it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { relaunchCommandRefusal } from '../../server/mcp/relaunchRule.js';
import { respawnClaudeBase } from '../../server/respawnLine.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

describe('respawnClaudeBase', () => {
  it('a respawned card titled x mcp add e npx p types the name quoted, never as loose words', () => {
    const line = respawnClaudeBase('claude -n x mcp add e npx p', { title: 'x mcp add e npx p' });
    expect(line).toBe('claude -n "x mcp add e npx p"');
    expect(relaunchCommandRefusal(line)).toBeNull();
  });

  it('takes the session flags off, puts the permission flags back and keeps the rest', () => {
    expect(
      respawnClaudeBase('/opt/bin/claude --model opus --resume abc -n Fix the login bug', { title: 'Fix the login bug', permissionMode: 'bypassPermissions' }),
    ).toBe('claude --model opus --dangerously-skip-permissions -n "Fix the login bug"');
    expect(respawnClaudeBase('claude --continue', { title: '' })).toBe('claude');
    expect(respawnClaudeBase('', { title: 'New one' })).toBe('claude -n "New one"');
    // No card title: the name it had is quoted instead.
    expect(respawnClaudeBase('claude -n x mcp add e', { title: null })).toBe('claude -n "x mcp add e"');
  });

  it('respawnSshTerminals builds its Claude line with it', () => {
    const source = readFileSync(join(__dirname, '../../server/index.ts'), 'utf8');
    const start = source.indexOf('async function respawnSshTerminals');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n  }\n', start));
    expect(body).toContain('respawnClaudeBase(originalCmd, session)');
    expect(body).not.toContain('reconstructPermissionFlags(');
  });
});
