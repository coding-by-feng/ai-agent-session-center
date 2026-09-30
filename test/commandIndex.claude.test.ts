/**
 * Claude skill descriptions written as YAML block scalars.
 *
 * `parseFrontmatter` recognised a bare `>` or `|` block header but none of its
 * chomping / indentation variants, so `description: >-` — the form several
 * real skills use (design-director, frontend-ui-polish, md-to-pdf,
 * openai-image, optimize-ui on the dev machine) — came through as the literal
 * description ">-", and the folded text beneath it was dropped. The queue
 * box's `/` dropdown then printed ">-" beside those skills.
 *
 * Fixtures are PROJECT skills (`<projectPath>/.claude/skills/<slug>`) in a temp
 * dir, so the test never depends on what is installed in the real ~/.claude.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getCommandIndex, clearCommandIndexCache } from '../server/commandIndex.js';

const project = mkdtempSync(join(tmpdir(), 'aasc-claude-skills-'));

function skill(slug: string, frontmatter: string): void {
  const dir = join(project, '.claude', 'skills', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# ${slug}\n\nBody text.\n`);
}

skill('folded-strip', 'name: folded-strip\ndescription: >-\n  Review the visual design\n  of a component.');
skill('literal-strip', 'name: literal-strip\ndescription: |-\n  First line\n  second line');
skill('folded-keep', 'name: folded-keep\ndescription: >+\n  Kept text');
skill('indent-then-chomp', 'name: indent-then-chomp\ndescription: >2-\n  Indicator first');
skill('chomp-then-indent', 'name: chomp-then-indent\ndescription: |-2\n  Chomping first');
skill('folded-bare', 'name: folded-bare\ndescription: >\n  Bare folded');
skill('plain', 'name: plain\ndescription: A plain one-line description');
skill('quoted-gt', 'name: quoted-gt\ndescription: ">- is how YAML folds"');
skill('header-comment', 'name: header-comment\ndescription: >- # folded below\n  Comment after the header');
// CRLF line endings (a SKILL.md saved on Windows): the frontmatter must still parse.
{
  const dir = join(project, '.claude', 'skills', 'crlf');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\r\nname: crlf-skill\r\ndescription: >-\r\n  Written on Windows\r\n---\r\n\r\n# crlf\r\n');
}

afterAll(() => rmSync(project, { recursive: true, force: true }));
beforeEach(() => clearCommandIndexCache());

function descriptionOf(name: string): string | undefined {
  return getCommandIndex('claude', project)
    .find((e) => e.source === 'project' && e.kind === 'skill' && e.name === name)
    ?.description;
}

describe('Claude skill descriptions — YAML block scalars', () => {
  it('reads a folded description with strip chomping (>-) as its text, not ">-"', () => {
    expect(descriptionOf('folded-strip')).toBe('Review the visual design of a component.');
  });

  it('reads a literal description with strip chomping (|-) as its text', () => {
    expect(descriptionOf('literal-strip')).toBe('First line second line');
  });

  it('reads keep chomping (>+) as its text', () => {
    expect(descriptionOf('folded-keep')).toBe('Kept text');
  });

  it('reads an indentation indicator in either order (>2- and |-2)', () => {
    expect(descriptionOf('indent-then-chomp')).toBe('Indicator first');
    expect(descriptionOf('chomp-then-indent')).toBe('Chomping first');
  });

  it('still reads a bare > block and a plain one-line description', () => {
    expect(descriptionOf('folded-bare')).toBe('Bare folded');
    expect(descriptionOf('plain')).toBe('A plain one-line description');
  });

  it('allows a comment after the block header (YAML permits ">- # note")', () => {
    expect(descriptionOf('header-comment')).toBe('Comment after the header');
  });

  it('parses a SKILL.md with CRLF line endings — name and description both', () => {
    expect(descriptionOf('crlf-skill')).toBe('Written on Windows');
  });

  it('leaves a quoted value that merely starts with ">-" alone', () => {
    expect(descriptionOf('quoted-gt')).toBe('>- is how YAML folds');
  });
});
