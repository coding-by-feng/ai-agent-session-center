// test/mcp/commandRules.test.ts — which leading slash command a central may queue (Ruling 60): command_run's
// allow-list, applied to the text the scheduler types as stored. Never the commands that clear, end or reconfigure a
// session; of the built-ins only compact, model and effort (those two with their choice); anything else only when it is
// exactly a command or skill of the session's catalog — the CLI's slash menu completes a name it does not know to one it
// does, so a near miss (`/logou`) is refused like the command it would become.
import { describe, expect, it } from 'vitest';
import type { CommandEntry } from '../../server/commandIndex.js';
import {
  catalogEntries,
  catalogRefusal,
  CODE_REVIEW_LEVELS,
  isRunOnlyBuiltin,
  isUnsafeBuiltin,
  leadingCommand,
  NEVER_COMMANDS,
  OPENS_MENU,
  queuedCommandVerdict,
  RUN_ONLY_BUILTINS,
  runOnlyArgsRefusal,
  SAFE_BUILTINS,
} from '../../server/mcp/commandRules.js';
import { ToolError } from '../../server/mcp/types.js';

const entry = (over: Partial<CommandEntry> & Pick<CommandEntry, 'name'>): CommandEntry => ({
  description: 'x',
  cli: 'claude',
  kind: 'command',
  source: 'project',
  ...over,
});

const CATALOG: CommandEntry[] = [
  entry({ name: 'deploy' }),
  entry({ name: 'tdd', kind: 'skill', source: 'plugin', pluginName: 'kit' }),
  entry({ name: 'status', source: 'builtin' }),
  entry({ name: 'compact', source: 'builtin' }),
  entry({ name: 'review', cli: 'codex', kind: 'skill' }),
];

const verdictOf = (text: string) => {
  const cmd = leadingCommand(text);
  if (cmd === null) throw new Error(`no command in ${text}`);
  return queuedCommandVerdict(cmd);
};

const refusalOf = (text: string, entries: readonly CommandEntry[] = CATALOG): ToolError | null => {
  const cmd = leadingCommand(text);
  if (cmd === null) throw new Error(`no command in ${text}`);
  return catalogRefusal(cmd, entries);
};

describe('leadingCommand', () => {
  it('finds the slash command a text starts with, and whether anything follows it', () => {
    expect(leadingCommand('/deploy')).toEqual({ name: 'deploy', bare: true });
    expect(leadingCommand('/deploy staging now')).toEqual({ name: 'deploy', bare: false });
    expect(leadingCommand('/kit:tdd')).toEqual({ name: 'kit:tdd', bare: true });
  });

  it('looks past leading whitespace and line breaks, as the CLI reads the typed text', () => {
    expect(leadingCommand('  /clear')).toEqual({ name: 'clear', bare: true });
    expect(leadingCommand('\n/logout now')).toEqual({ name: 'logout', bare: false });
  });

  it('sees no command in words, a path, a slash later on, a lone slash or a Codex skill', () => {
    for (const text of ['fix it', '/Users/me/a.ts is broken', 'please run /compact', '$review the diff', '', '\uFF0Fclear']) {
      expect(leadingCommand(text), JSON.stringify(text)).toBeNull();
    }
  });
});

describe('leadingCommand: the name is the whole first word', () => {
  it('keeps punctuation and zero-width characters out of the match, so a near miss is not a path or words', () => {
    // The CLI types /clear! as /clear, so a name that stops at punctuation lets a never-command through.
    expect(leadingCommand('/clear!')).toEqual({ name: 'clear!', bare: true });
    expect(leadingCommand('/exit?')).toEqual({ name: 'exit?', bare: true });
    expect(leadingCommand('/logout,')).toEqual({ name: 'logout,', bare: true });
    expect(leadingCommand('/clear)')).toEqual({ name: 'clear)', bare: true });
    expect(leadingCommand('/clear\u200B')).toEqual({ name: 'clear', bare: true });
    expect(leadingCommand('/clear\u2060now')).toEqual({ name: 'clear', bare: false });
    expect(leadingCommand('/model\uFEFF')).toEqual({ name: 'model', bare: true });
  });

  it('is a path only when the first word holds a second slash', () => {
    expect(leadingCommand('/Users/me/x.md')).toBeNull();
    expect(leadingCommand('/Users/me/x.md is broken')).toBeNull();
    expect(leadingCommand('/etc/hosts')).toBeNull();
  });

  it('is refused as a command, never queued on the name it is not in the catalog under', () => {
    for (const text of ['/clear!', '/exit?', '/logout,', '/clear)']) {
      const cmd = leadingCommand(text)!;
      expect(queuedCommandVerdict(cmd), text).toBe('catalog');
      expect(catalogRefusal(cmd, CATALOG), text).toBeInstanceOf(ToolError);
    }
    expect(queuedCommandVerdict(leadingCommand('/clear\u200B')!)).toBeInstanceOf(ToolError);
  });
});

describe('leadingCommand: any first word that starts with a slash is a command (Ruling P4-38)', () => {
  const ODD = ['/', '/_clear', '/-clear', '/1', '/.x', '/\u0301clear', '/\u00E9xit', '/\uFF43lear', '/clear/', '//'];

  it('reads an odd name as a command, so the catalog can refuse it as written', () => {
    for (const text of ODD) {
      const cmd = leadingCommand(text);
      expect(cmd, JSON.stringify(text)).not.toBeNull();
      expect(cmd!.name, JSON.stringify(text)).toBe(text.slice(1));
      expect(catalogRefusal(cmd!, CATALOG), JSON.stringify(text)).toBeInstanceOf(ToolError);
    }
  });

  it('strips a leading run of whitespace and zero-width characters before it looks', () => {
    for (const lead of ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF', ' \u200B\n\u2060\uFEFF\t']) {
      expect(leadingCommand(`${lead}/clear`), JSON.stringify(lead)).toEqual({ name: 'clear', bare: true });
      expect(queuedCommandVerdict(leadingCommand(`${lead}/clear`)!), JSON.stringify(lead)).toBeInstanceOf(ToolError);
    }
  });

  it('strips every format character before the word, not a fixed list (Ruling P4-49 N3)', () => {
    for (const lead of ['\u00AD', '\u200E', '\u200F', '\u202A', '\u2066', '\u2061', '\u180E', ' \u00AD\u200E\n']) {
      expect(leadingCommand(`${lead}/clear`), JSON.stringify(lead)).toEqual({ name: 'clear', bare: true });
      expect(queuedCommandVerdict(leadingCommand(`${lead}/clear`)!), JSON.stringify(lead)).toBeInstanceOf(ToolError);
    }
  });

  it('is never a path when its first segment is a never-list or built-in command name (Ruling P4-49 N1)', () => {
    for (const text of ['/logout/a', '/clear/x', '/CLEAR/x', '/Exit/now', '/status/x', '/compact/x', '/model/y']) {
      const cmd = leadingCommand(text);
      expect(cmd, text).not.toBeNull();
      expect(cmd!.name, text).toBe(text.slice(1));
      expect(catalogRefusal(cmd!, CATALOG), text).toBeInstanceOf(ToolError);
    }
    // A path whose first folder is no command stays a path.
    for (const text of ['/Users/me/x.md', '/etc/hosts', '/tmp/clearing/x', '/home/x']) expect(leadingCommand(text), text).toBeNull();
  });

  it('keeps a path a path: a second slash followed by a further character', () => {
    for (const text of ['/Users/me/x.md', '/Users/me/x.md is broken', '//x', '\u200B/etc/hosts']) {
      expect(leadingCommand(text), JSON.stringify(text)).toBeNull();
    }
  });

  it('does not read the full-width slash as a command: the CLIs key on the ASCII one', () => {
    expect(leadingCommand('\uFF0Fclear')).toBeNull();
  });
});

describe('queuedCommandVerdict (no catalog needed)', () => {
  it('refuses every command that clears, ends or reconfigures a session, in any case', () => {
    for (const name of NEVER_COMMANDS) {
      for (const text of [`/${name}`, `/${name.toUpperCase()}`, `/${name} now please`]) {
        const verdict = verdictOf(text);
        expect(verdict, text).toBeInstanceOf(ToolError);
        expect((verdict as ToolError).code).toBe('INVALID');
        expect((verdict as ToolError).message).toMatch(/never queues/);
      }
    }
  });

  it('allows compact bare or with words, and model and effort with their choice', () => {
    for (const text of ['/compact', '/compact keep the plan', '/model sonnet', '/effort high']) {
      expect(verdictOf(text), text).toBe('allowed');
    }
  });

  it('refuses model and effort typed bare: their picker would catch the next prompt', () => {
    for (const text of ['/model', '/effort']) {
      const verdict = verdictOf(text);
      expect(verdict, text).toBeInstanceOf(ToolError);
      expect((verdict as ToolError).message).toMatch(/picker/);
    }
  });

  it('leaves every other name to the session’s catalog, a safe built-in in another case included', () => {
    for (const text of ['/deploy', '/kit:tdd x', '/status', '/COMPACT', '/Model sonnet', '/logou']) {
      expect(verdictOf(text), text).toBe('catalog');
    }
  });

  it('keeps the never list and the safe built-ins apart', () => {
    for (const name of NEVER_COMMANDS) expect(SAFE_BUILTINS.has(name), name).toBe(false);
  });
});

describe('catalogRefusal', () => {
  it('allows a command or skill of the catalog written exactly as its token', () => {
    expect(refusalOf('/deploy staging')).toBeNull();
    expect(refusalOf('/kit:tdd')).toBeNull();
  });

  it('refuses a built-in of the catalog that is not a safe one', () => {
    const refusal = refusalOf('/status');
    expect(refusal?.code).toBe('INVALID');
    expect(refusal?.message).toMatch(/built-in/);
  });

  it('refuses a name the catalog does not hold exactly: a near miss, another case, a bare plugin name, a Codex skill', () => {
    for (const text of ['/logou', '/Deploy', '/tdd', '/review', '/COMPACT']) {
      const refusal = refusalOf(text);
      expect(refusal?.code, text).toBe('NOT_FOUND');
      expect(refusal?.hint, text).toContain('command_list');
    }
  });

  it('refuses everything but nothing when the catalog is empty', () => {
    expect(refusalOf('/deploy', [])?.code).toBe('NOT_FOUND');
  });

  it('never repeats the text in its refusal', () => {
    const refusal = refusalOf('/zzneedlezz');
    expect(`${refusal?.message} ${refusal?.hint ?? ''}`).not.toContain('zzneedlezz');
  });
});

describe('catalogEntries', () => {
  it('keeps the well-formed entries of the route’s answer and drops the rest', () => {
    const body = { entries: [CATALOG[0], { name: 3 }, null, entry({ name: 'two words' }), CATALOG[1]] };
    expect(catalogEntries(body).map((e) => e.name)).toEqual(['deploy', 'tdd']);
    expect(catalogEntries(null)).toEqual([]);
    expect(catalogEntries({ entries: 'no' })).toEqual([]);
  });
});

describe('run-only built-ins (Ruling P3-16)', () => {
  const codexReview = entry({ name: 'review', cli: 'codex', source: 'builtin' });
  const claudeReview = entry({ name: 'code-review', source: 'builtin' });

  it('are review (Codex) and code-review (Claude), apart from the safe built-ins and the never list', () => {
    expect([...RUN_ONLY_BUILTINS].sort()).toEqual(['code-review', 'review']);
    for (const name of RUN_ONLY_BUILTINS) {
      expect(SAFE_BUILTINS.has(name), name).toBe(false);
      expect(NEVER_COMMANDS.has(name), name).toBe(false);
    }
  });

  it('are a catalog’s built-in commands only: not a skill or a project command of that name', () => {
    expect(isRunOnlyBuiltin(codexReview)).toBe(true);
    expect(isRunOnlyBuiltin(claudeReview)).toBe(true);
    expect(isRunOnlyBuiltin(entry({ name: 'review', cli: 'codex', kind: 'skill', source: 'builtin' }))).toBe(false);
    expect(isRunOnlyBuiltin(entry({ name: 'review' }))).toBe(false);
    expect(isRunOnlyBuiltin(entry({ name: 'status', source: 'builtin' }))).toBe(false);
    // Still unsafe as far as queued text goes.
    expect(isUnsafeBuiltin(codexReview)).toBe(true);
  });

  it('queued text still refuses them: bare, each opens a menu that would catch the next queued prompt', () => {
    const catalog = [codexReview, claudeReview];
    expect(verdictOf('/review')).toBe('catalog');
    expect(verdictOf('/code-review')).toBe('catalog');
    for (const text of ['/review', '/review the diff', '/code-review']) {
      const refusal = refusalOf(text, catalog);
      expect(refusal?.code, text).toBe('INVALID');
      expect(refusal?.message, text).toMatch(/built-in/);
    }
  });
});

describe('the arguments of a run-only built-in (finding D-I2)', () => {
  it('review runs bare: no arguments, or only whitespace', () => {
    expect(runOnlyArgsRefusal('review', undefined)).toBeNull();
    expect(runOnlyArgsRefusal('review', '')).toBeNull();
    expect(runOnlyArgsRefusal('review', '  ')).toBeNull();
  });

  it('bare code-review is refused: it reuses the person’s last level, which may be ultra', () => {
    for (const args of [undefined, '', '  ']) {
      const refusal = runOnlyArgsRefusal('code-review', args);
      expect(refusal?.code, String(args)).toBe('INVALID');
      expect(refusal?.message).toMatch(/exactly one level/);
    }
  });

  it('only review opens a menu a central answers with key_send', () => {
    expect([...OPENS_MENU]).toEqual(['review']);
  });

  it('code-review takes one level, and review takes none', () => {
    expect([...CODE_REVIEW_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    for (const level of CODE_REVIEW_LEVELS) {
      expect(runOnlyArgsRefusal('code-review', level), level).toBeNull();
      expect(runOnlyArgsRefusal('code-review', ` ${level} `), level).toBeNull();
      expect(runOnlyArgsRefusal('review', level)?.code, level).toBe('INVALID');
    }
  });

  it('refuses ultra, any -- option, more than one word and anything else, without repeating it', () => {
    for (const args of [
      'ultra', 'ULTRA', 'high ultra', '--comment', '--fix', '--post', 'high --fix', '--max-findings all', 'HIGH',
      'high high', 'high\u200b', 'the last commit', '-c',
    ]) {
      for (const name of RUN_ONLY_BUILTINS) {
        const refusal = runOnlyArgsRefusal(name, args);
        expect(refusal, `${name} ${args}`).toBeInstanceOf(ToolError);
        expect(refusal?.code, `${name} ${args}`).toBe('INVALID');
        const words = `${refusal?.message} ${refusal?.hint}`;
        if (args.trim() !== 'ultra' && args.trim().length > 3) expect(words, args).not.toContain(args.trim());
      }
    }
    const ultra = runOnlyArgsRefusal('code-review', 'ultra');
    expect(ultra?.message).toMatch(/ultra/);
  });
});
