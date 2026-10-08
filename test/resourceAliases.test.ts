// test/resourceAliases.test.ts — server/resourceAliases.ts
//
// An abbreviation made in the Library can also exist as a real command in
// Claude Code and Codex, so typing it there runs the skill. The writes are the
// riskiest thing the RESOURCES tab does after Uninstall, so what is pinned here
// is mostly refusal: only files AASC marked are ever replaced or deleted, never
// a hand-written one, a symlink, or a path outside the three alias folders.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ALIAS_MARKER,
  AliasError,
  createAlias,
  removeAlias,
  aliasFilesFor,
} from '../server/resourceAliases.js';

let home: string;
const REAL = new Set(['claude:plan', 'codex:imagegen']);
const base = { kind: 'skill' as const, target: 'retouch-ascii-review', abbr: 'rar' };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aasc-alias-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('aliasFilesFor', () => {
  it('maps an agent and kind to the files each CLI reads', () => {
    expect(aliasFilesFor('claude', 'skill', 'rar', home).map((f) => f.display)).toEqual(['~/.claude/commands/rar.md']);
    expect(aliasFilesFor('codex', 'skill', 'rar', home).map((f) => f.display)).toEqual(['~/.codex/skills/rar/SKILL.md']);
    expect(aliasFilesFor('codex', 'command', 'rar', home).map((f) => f.display)).toEqual(['~/.codex/prompts/rar.md']);
    expect(aliasFilesFor('shared', 'skill', 'rar', home).map((f) => f.display)).toEqual([
      '~/.claude/commands/rar.md',
      '~/.codex/skills/rar/SKILL.md',
    ]);
  });
});

describe('createAlias', () => {
  it('writes a Claude command in the shortcut convention, marked as AASC\'s', async () => {
    const out = await createAlias({ ...base, agent: 'claude' }, { home, realNames: REAL });
    expect(out.files).toEqual([{ path: '~/.claude/commands/rar.md', action: 'created' }]);
    const text = readFileSync(join(home, '.claude/commands/rar.md'), 'utf8');
    expect(text).toContain('description: Shortcut for /retouch-ascii-review');
    expect(text).toContain('Use the `retouch-ascii-review` skill');
    expect(text).toContain('$ARGUMENTS');
    expect(text).toContain(ALIAS_MARKER);
  });

  it('writes a Codex skill alias invoked as $abbr', async () => {
    await createAlias({ ...base, agent: 'codex' }, { home, realNames: REAL });
    const text = readFileSync(join(home, '.codex/skills/rar/SKILL.md'), 'utf8');
    expect(text).toMatch(/^---\nname: rar\n/);
    expect(text).toContain('Shortcut for $retouch-ascii-review');
    expect(text).toContain(ALIAS_MARKER);
  });

  it('a shared skill gets both', async () => {
    const out = await createAlias({ ...base, agent: 'shared' }, { home, realNames: REAL });
    expect(out.files.map((f) => f.path)).toEqual(['~/.claude/commands/rar.md', '~/.codex/skills/rar/SKILL.md']);
  });

  it('is idempotent and reports a changed target as updated', async () => {
    await createAlias({ ...base, agent: 'claude' }, { home, realNames: REAL });
    expect((await createAlias({ ...base, agent: 'claude' }, { home, realNames: REAL })).files[0].action).toBe('unchanged');
    const moved = await createAlias({ ...base, agent: 'claude', target: 'plan2' }, { home, realNames: REAL });
    expect(moved.files[0].action).toBe('updated');
    expect(readFileSync(join(home, '.claude/commands/rar.md'), 'utf8')).toContain('plan2');
  });

  it('never replaces a hand-written file', async () => {
    mkdirSync(join(home, '.claude/commands'), { recursive: true });
    writeFileSync(join(home, '.claude/commands/rar.md'), 'my own command\n');
    await expect(createAlias({ ...base, agent: 'claude' }, { home, realNames: REAL })).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(home, '.claude/commands/rar.md'), 'utf8')).toBe('my own command\n');
  });

  it('writes nothing at all when one of two files is blocked', async () => {
    mkdirSync(join(home, '.codex/skills/rar'), { recursive: true });
    writeFileSync(join(home, '.codex/skills/rar/SKILL.md'), 'hand written\n');
    await expect(createAlias({ ...base, agent: 'shared' }, { home, realNames: REAL })).rejects.toBeInstanceOf(AliasError);
    expect(existsSync(join(home, '.claude/commands/rar.md'))).toBe(false);
  });

  it('refuses a symlink, wherever it points', async () => {
    mkdirSync(join(home, '.claude/commands'), { recursive: true });
    writeFileSync(join(home, 'elsewhere.md'), 'x');
    symlinkSync(join(home, 'elsewhere.md'), join(home, '.claude/commands/rar.md'));
    await expect(createAlias({ ...base, agent: 'claude' }, { home, realNames: REAL })).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(home, 'elsewhere.md'), 'utf8')).toBe('x');
  });

  it('refuses an abbreviation that is a real skill or command of that agent', async () => {
    await expect(createAlias({ ...base, agent: 'claude', abbr: 'plan' }, { home, realNames: REAL })).rejects.toMatchObject({ status: 409 });
    // the same word is free for the other agent
    await expect(createAlias({ ...base, agent: 'codex', abbr: 'plan' }, { home, realNames: REAL })).resolves.toBeTruthy();
  });

  it.each(['', 'a', '../x', 'a/b', 'A B', 'x'.repeat(13), '.hidden', 'a.md'])('rejects a malformed abbreviation %j', async (abbr) => {
    await expect(createAlias({ ...base, agent: 'claude', abbr }, { home, realNames: REAL })).rejects.toMatchObject({ status: 400 });
  });

  it.each(['', '../x', 'a b', '$(id)', 'a;b', 'x'.repeat(200), '`x`'])('rejects a malformed target %j', async (target) => {
    await expect(createAlias({ ...base, agent: 'claude', target }, { home, realNames: REAL })).rejects.toMatchObject({ status: 400 });
  });

  it('refuses when the CLI is not set up on this machine, and creates no folder for it', async () => {
    rmSync(join(home, '.codex'), { recursive: true });
    await expect(createAlias({ ...base, agent: 'codex' }, { home, realNames: REAL })).rejects.toMatchObject({ status: 409 });
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });

  it('creates the commands folder under an existing ~/.claude', async () => {
    await createAlias({ ...base, agent: 'claude' }, { home, realNames: REAL });
    expect(readdirSync(join(home, '.claude/commands'))).toEqual(['rar.md']);
  });
});

describe('removeAlias', () => {
  it('removes only a file AASC wrote, and the skill folder with it', async () => {
    await createAlias({ ...base, agent: 'shared' }, { home });
    const out = await removeAlias({ agent: 'shared', kind: 'skill', abbr: 'rar' }, { home });
    expect(out.files.map((f) => f.action)).toEqual(['removed', 'removed']);
    expect(existsSync(join(home, '.claude/commands/rar.md'))).toBe(false);
    expect(existsSync(join(home, '.codex/skills/rar'))).toBe(false);
  });

  it('leaves a hand-written file alone and says so', async () => {
    mkdirSync(join(home, '.claude/commands'), { recursive: true });
    writeFileSync(join(home, '.claude/commands/rar.md'), 'mine\n');
    const out = await removeAlias({ agent: 'claude', kind: 'skill', abbr: 'rar' }, { home });
    expect(out.files).toEqual([{ path: '~/.claude/commands/rar.md', action: 'kept' }]);
    expect(readFileSync(join(home, '.claude/commands/rar.md'), 'utf8')).toBe('mine\n');
  });

  it('keeps a Codex skill folder that holds anything besides the alias', async () => {
    await createAlias({ ...base, agent: 'codex' }, { home });
    writeFileSync(join(home, '.codex/skills/rar/notes.txt'), 'keep');
    await removeAlias({ agent: 'codex', kind: 'skill', abbr: 'rar' }, { home });
    expect(existsSync(join(home, '.codex/skills/rar/SKILL.md'))).toBe(false);
    expect(existsSync(join(home, '.codex/skills/rar/notes.txt'))).toBe(true);
  });

  it('is a no-op for an alias that does not exist', async () => {
    const out = await removeAlias({ agent: 'claude', kind: 'skill', abbr: 'nope' }, { home });
    expect(out.files).toEqual([{ path: '~/.claude/commands/nope.md', action: 'absent' }]);
  });

  it('refuses a malformed abbreviation (no path escapes)', async () => {
    await expect(removeAlias({ agent: 'claude', kind: 'skill', abbr: '../../x' }, { home })).rejects.toMatchObject({ status: 400 });
  });
});
