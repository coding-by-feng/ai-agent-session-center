import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  appendSessionName,
  extractSessionName,
  stripClaudeSessionName,
} from '../server/config.js';

/**
 * The `-n <title>` flag is interpolated into a command string that is written
 * verbatim into a live shell. Session titles are NOT trusted input: `buildAutoTitle`
 * derives them from the first 60 characters of the user's first prompt
 * (`makeShortTitle` does no shell sanitizing), and workspace-snapshot import
 * carries them in from a shared JSON file. So a title is an injection surface.
 */
describe('appendSessionName — shell safety', () => {
  it('quotes a multi-word title so it stays ONE argument', () => {
    // Unquoted, `claude` would take `KTS` as the name and `Deployment` as a
    // stray positional arg — which Claude Code reads as an initial prompt.
    expect(appendSessionName('claude', 'KTS Deployment')).toBe('claude -n "KTS Deployment"');
  });

  it('neutralizes command substitution', () => {
    const out = appendSessionName('claude', 'x$(touch /tmp/pwned)y');
    expect(out).toBe('claude -n "x\\$(touch /tmp/pwned)y"');
    expect(out).not.toMatch(/[^\\]\$\(/);
  });

  it('neutralizes backtick substitution', () => {
    const out = appendSessionName('claude', 'a`id`b');
    expect(out).toBe('claude -n "a\\`id\\`b"');
    expect(out).not.toMatch(/[^\\]`/);
  });

  it('neutralizes variable expansion', () => {
    expect(appendSessionName('claude', 'Deploy $HOME')).toBe('claude -n "Deploy \\$HOME"');
  });

  it('escapes backslashes before anything else, so an escape cannot be forged', () => {
    // A naive escaper that handles `"` before `\` turns `\` + `"` into `\\"`,
    // which closes the quote. Backslash must be escaped first.
    expect(appendSessionName('claude', 'a\\"b')).toBe('claude -n "a\\\\\\"b"');
  });

  it('escapes double quotes', () => {
    expect(appendSessionName('claude', 'say "hi"')).toBe('claude -n "say \\"hi\\""');
  });

  it('leaves apostrophes alone — they are inert inside double quotes', () => {
    expect(appendSessionName('claude', "Kason's job")).toBe('claude -n "Kason\'s job"');
  });

  it('strips newlines and control characters, which would inject a whole command', () => {
    expect(appendSessionName('claude', 'good\nrm -rf /')).toBe('claude -n "good rm -rf /"');
    expect(appendSessionName('claude', 'a\r\tb')).toBe('claude -n "a b"');
  });

  it('returns the command untouched for a blank or whitespace-only title', () => {
    expect(appendSessionName('claude', '')).toBe('claude');
    expect(appendSessionName('claude', null)).toBe('claude');
    expect(appendSessionName('claude', '   ')).toBe('claude');
  });

  it('only applies to claude commands', () => {
    expect(appendSessionName('codex resume', 'KTS Deployment')).toBe('codex resume');
  });
});

describe('appendSessionName — normalizing an existing -n', () => {
  it('repairs an already-malformed unquoted -n instead of preserving it', () => {
    // This is what made the bug sticky: the old "don't double-add" guard treated
    // ANY existing -n as valid, so one malformed command propagated through
    // every later resume / clone / fork / respawn unchanged.
    expect(appendSessionName('claude --model sonnet -n KTS Deployment', 'KTS Deployment')).toBe(
      'claude --model sonnet -n "KTS Deployment"',
    );
  });

  it('does not duplicate an already-correct -n', () => {
    const cmd = 'claude -n "KTS Deployment"';
    expect(appendSessionName(cmd, 'KTS Deployment')).toBe(cmd);
  });

  it('the new title wins over the one already in the command', () => {
    expect(appendSessionName('claude -n "Old Name"', 'New Name')).toBe('claude -n "New Name"');
  });

  it('leaves an existing -n alone when no replacement title is given', () => {
    const cmd = 'claude -n "Keep Me"';
    expect(appendSessionName(cmd, null)).toBe(cmd);
  });
});

describe('round-trip through extract / strip', () => {
  const titles = [
    'KTS Deployment',
    "Kason's job",
    'say "hi"',
    'Deploy $HOME',
    'a`id`b',
    'x$(touch /tmp/pwned)y',
    'a\\"b',
  ];

  it.each(titles)('survives appendSessionName → extractSessionName: %j', (title) => {
    const cmd = appendSessionName('claude --model opus', title);
    expect(extractSessionName(cmd)).toBe(title);
  });

  it.each(titles)('is fully removed by stripClaudeSessionName: %j', (title) => {
    const cmd = appendSessionName('claude --model opus', title);
    expect(stripClaudeSessionName(cmd)).toBe('claude --model opus');
  });

  it('survives a full strip → re-append cycle (the resume path)', () => {
    const title = 'Deploy $HOME "now"';
    let cmd = appendSessionName('claude --model opus', title);
    for (let i = 0; i < 3; i++) {
      const extracted = extractSessionName(cmd);
      expect(extracted).toBe(title);
      cmd = appendSessionName(stripClaudeSessionName(cmd), extracted);
    }
    expect(cmd).toBe('claude --model opus -n "Deploy \\$HOME \\"now\\""');
  });

  it('still extracts a legacy unquoted multi-word name', () => {
    expect(extractSessionName('claude -n KTS Deployment')).toBe('KTS Deployment');
  });
});

/**
 * `electron/ptyHost.ts` cannot import from `server/` (separate tsconfig roots —
 * same constraint as `ptyRing.ts` and the CLAUDE_CODE_CHILD_SESSION scrub), so
 * it carries its own copy of this logic. Assert the mirror's source text so the
 * two cannot silently drift apart.
 */
describe('electron/ptyHost.ts mirror', () => {
  const src = readFileSync(join(process.cwd(), 'electron/ptyHost.ts'), 'utf8');

  it('escapes backslash, $, backtick and " — not just "', () => {
    // Character class must be exactly [\\$`"] — the four chars the shell still
    // treats as special inside double quotes.
    expect(src).toContain('replace(/[\\\\$`"]/g');
  });

  it('strips control characters from the title', () => {
    expect(src).toContain('CONTROL_CHARS_RE');
  });

  it('normalizes an existing -n rather than bailing out', () => {
    expect(src).toContain('STRIP_SESSION_NAME_RE');
    expect(src).not.toMatch(/if \(\/ -n\[ =\]\/\.test\(cmd\)\) return cmd/);
  });
});
