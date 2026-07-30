// test/commandIndex.codex.test.ts — Codex skill enumeration.
//
// Codex invokes skills with `$skill-name` (its own TUI has a `$` popup), and
// they live under `$CODEX_HOME/skills/<slug>/SKILL.md` — a root the index did
// not walk at all, so every Codex session saw zero skills. Two sharp edges are
// pinned here because both silently drop entries rather than erroring:
//   1. `.system/` holds Codex's PREINSTALLED skills ($imagegen, $skill-creator,
//      …). It is dot-prefixed, so the generic "skip _ and . dirs" rule hides a
//      whole tier of real, invocable skills unless it is walked explicitly.
//   2. Skill dirs are commonly SYMLINKS into another repo. `Dirent.isDirectory()`
//      is false for a symlink, so the naive walk drops them.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getCommandIndex, clearCommandIndexCache } from '../server/commandIndex.js';

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

function writeSkill(skillsRoot: string, slug: string, description: string): string {
  const dir = join(skillsRoot, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: "${description}"\n---\n\n# ${slug}\n`,
    'utf8',
  );
  return dir;
}

function writePrompt(promptsRoot: string, name: string, description: string): void {
  mkdirSync(promptsRoot, { recursive: true });
  writeFileSync(
    join(promptsRoot, `${name}.md`),
    `---\ndescription: ${description}\n---\n\nbody\n`,
    'utf8',
  );
}

let codexHome: string;
const originalCodexHome = process.env.CODEX_HOME;

beforeEach(() => {
  clearCommandIndexCache();
  codexHome = tempRoot('aasc-codex-home-');
  process.env.CODEX_HOME = codexHome;
});

afterAll(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const skills = (cli: 'codex', projectPath: string | null) =>
  getCommandIndex(cli, projectPath).filter((e) => e.kind === 'skill');

describe('getCommandIndex(codex) — skills', () => {
  it('enumerates global skills from $CODEX_HOME/skills as source "global"', () => {
    writeSkill(join(codexHome, 'skills'), 'retouch-current-prompt', 'Retouch the prompt');
    writeSkill(join(codexHome, 'skills'), 'ascii-review-first', 'ASCII first');

    const found = skills('codex', null);
    const names = found.map((e) => e.name).sort();
    expect(names).toEqual(['ascii-review-first', 'retouch-current-prompt']);
    expect(found.every((e) => e.source === 'global')).toBe(true);
    expect(found.every((e) => e.cli === 'codex')).toBe(true);
    expect(found.find((e) => e.name === 'ascii-review-first')?.description).toBe('ASCII first');
  });

  it('honours CODEX_HOME instead of hardcoding ~/.codex', () => {
    // Skill exists only under the overridden home; if the walker hardcoded
    // homedir() this comes back empty.
    writeSkill(join(codexHome, 'skills'), 'only-in-custom-home', 'x');
    expect(skills('codex', null).map((e) => e.name)).toContain('only-in-custom-home');
  });

  it('enumerates preinstalled .system skills as source "builtin"', () => {
    writeSkill(join(codexHome, 'skills', '.system'), 'imagegen', 'Generate images');
    writeSkill(join(codexHome, 'skills', '.system'), 'skill-creator', 'Author a skill');

    const found = skills('codex', null);
    const sys = found.filter((e) => e.source === 'builtin').map((e) => e.name).sort();
    expect(sys).toEqual(['imagegen', 'skill-creator']);
  });

  it('skips _shared and other underscore dirs, which are resources not skills', () => {
    mkdirSync(join(codexHome, 'skills', '_shared', 'feature-docs'), { recursive: true });
    writeFileSync(join(codexHome, 'skills', '_shared', 'SKILL.md'), 'not a skill', 'utf8');
    writeSkill(join(codexHome, 'skills'), 'real-skill', 'y');

    expect(skills('codex', null).map((e) => e.name)).toEqual(['real-skill']);
  });

  it('follows SYMLINKED skill dirs (Dirent.isDirectory() is false for those)', () => {
    const external = tempRoot('aasc-codex-external-');
    const target = writeSkill(external, 'kason-mcp-conventions', 'House conventions');
    mkdirSync(join(codexHome, 'skills'), { recursive: true });
    symlinkSync(target, join(codexHome, 'skills', 'kason-mcp-conventions'), 'dir');

    expect(skills('codex', null).map((e) => e.name)).toContain('kason-mcp-conventions');
  });

  it('enumerates project skills from <project>/.codex/skills as source "project"', () => {
    const project = tempRoot('aasc-codex-project-');
    writeSkill(join(project, '.codex', 'skills'), 'project-only-skill', 'z');

    const found = skills('codex', project);
    const entry = found.find((e) => e.name === 'project-only-skill');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('project');
  });

  it('ignores a skill dir with no SKILL.md', () => {
    mkdirSync(join(codexHome, 'skills', 'not-a-skill'), { recursive: true });
    writeSkill(join(codexHome, 'skills'), 'good', 'g');

    expect(skills('codex', null).map((e) => e.name)).toEqual(['good']);
  });
});

describe('getCommandIndex(codex) — prompts still work alongside skills', () => {
  it('lists $CODEX_HOME/prompts as commands and keeps them distinct from skills', () => {
    writePrompt(join(codexHome, 'prompts'), 'bilingual-md', 'Write EN + CN');
    writeSkill(join(codexHome, 'skills'), 'todo', 'Manage todos');

    const all = getCommandIndex('codex', null);
    const prompt = all.find((e) => e.name === 'bilingual-md');
    expect(prompt?.kind).toBe('command');
    expect(prompt?.source).toBe('global');
    expect(all.find((e) => e.name === 'todo')?.kind).toBe('skill');
  });

  it('still ships the in-binary builtin slash commands', () => {
    const cmds = getCommandIndex('codex', null).filter(
      (e) => e.kind === 'command' && e.source === 'builtin',
    );
    expect(cmds.map((e) => e.name)).toContain('compact');
  });
});
