// test/resourceRoots.test.ts — where the RESOURCES tab looks, and which folders
// it believes are projects.
//
// Project discovery is a union of five lossy sources, and each one fails in its
// own quiet way: `~/.claude/projects/<encoded>` names collapse `/ . _ space`
// into `-` (so they must be decoded against the real filesystem, and can decode
// two ways), `~/.claude.json` and Codex's config.toml hold exact paths that may
// be symlinks or long deleted, and the home dir / global roots show up in those
// lists too but are NOT projects. Everything here runs against a temp HOME —
// never the developer's real ~/.claude.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveGlobalRoots,
  encodeProjectPath,
  decodeProjectDirName,
  discoverProjects,
  toResourceProject,
  walkProjectNested,
} from '../server/resourceRoots.js';
import type { ProjectRecord } from '../server/resourceRoots.js';
import { readConfigFile, displayPath, createLimiter } from '../server/fsSafe.js';

// Symlinks need elevated rights on Windows, so fixtures create them only where
// they can exist and the tests that depend on one skip elsewhere — a platform
// that cannot express the fixture is not a failure of the code under test.
const NO_SYMLINKS = process.platform === 'win32';
const link = (target: string, path: string, type?: 'dir'): void => {
  if (!NO_SYMLINKS) symlinkSync(target, path, type);
};
// chmod 000 stops neither root nor Windows from reading — tests that need a
// locked folder skip there.
const CANNOT_LOCK = process.platform === 'win32' || process.getuid?.() === 0;

let base = '';
let home = '';

const mk = (...parts: string[]): string => {
  const p = join(home, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-roots-')));
  home = join(base, 'home');
  mkdirSync(home, { recursive: true });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveGlobalRoots', () => {
  it('defaults to ~/.claude, ~/.claude.json, ~/.codex, ~/.agents', async () => {
    const r = await resolveGlobalRoots({}, home);
    expect(r).toMatchObject({
      home,
      claudeRoot: join(home, '.claude'),
      claudeConfigJson: join(home, '.claude.json'),
      codexRoot: join(home, '.codex'),
      sharedRoot: join(home, '.agents'),
    });
  });

  it('honours CLAUDE_CONFIG_DIR (config JSON moves inside it) and CODEX_HOME', async () => {
    const claudeDir = join(base, 'alt-claude');
    const codexDir = join(base, 'alt-codex');
    const r = await resolveGlobalRoots({ CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir }, home);
    expect(r.claudeRoot).toBe(claudeDir);
    expect(r.claudeConfigJson).toBe(join(claudeDir, '.claude.json'));
    expect(r.codexRoot).toBe(codexDir);
    expect(r.sharedRoot).toBe(join(home, '.agents'));
  });

  it('finds the repo via AASC_RESOURCES_REPO, then ~/Documents/agent-skills, else null', async () => {
    expect((await resolveGlobalRoots({}, home)).repo).toBeNull();

    const fallback = mk('Documents', 'agent-skills');
    expect((await resolveGlobalRoots({}, home)).repo).toBeNull(); // no claude/ or codex/ inside yet
    mkdirSync(join(fallback, 'codex'));
    expect((await resolveGlobalRoots({}, home)).repo).toBe(fallback);

    const custom = join(base, 'custom-repo');
    mkdirSync(custom);
    expect((await resolveGlobalRoots({ AASC_RESOURCES_REPO: custom }, home)).repo).toBe(custom);
    // A configured path that does not exist falls back rather than disabling compare.
    expect((await resolveGlobalRoots({ AASC_RESOURCES_REPO: join(base, 'nope') }, home)).repo).toBe(fallback);
  });
});

describe('encodeProjectPath / decodeProjectDirName', () => {
  it('encodes every non-alphanumeric character as -', () => {
    expect(encodeProjectPath('/Users/k/.claude')).toBe('-Users-k--claude');
    expect(encodeProjectPath('/a/my_proj.v2/x y')).toBe('-a-my-proj-v2-x-y');
  });

  it('decodes against the filesystem, through a .dir and a name with _', async () => {
    const target = mk('dec', '.hidden', 'my_proj.v2');
    await expect(decodeProjectDirName(encodeProjectPath(target))).resolves.toEqual([target]);
  });

  it('keeps every real match when the encoding is ambiguous', async () => {
    const dashed = mk('amb', 'a-b');
    const nested = mk('amb', 'a', 'b');
    const found = await decodeProjectDirName(encodeProjectPath(dashed));
    expect([...found].sort()).toEqual([dashed, nested].sort());
  });

  it('returns nothing for a folder that no longer exists', async () => {
    await expect(decodeProjectDirName(encodeProjectPath(join(home, 'dec', 'gone')))).resolves.toEqual([]);
  });
});

describe('discoverProjects', () => {
  let projects: ProjectRecord[] = [];
  let encodedToProject = new Map<string, string>();
  const byPath = (p: string) => projects.find((x) => x.absPath === p);
  let plain = '';
  let dotted = '';
  let extra = '';
  let wtDir = '';
  let mainRepo = '';

  beforeAll(async () => {
    const root = join(home, 'disc');
    plain = mk('disc', 'plain');
    dotted = mk('disc', 'my_proj.v2');
    extra = mk('disc', 'extra');
    mk('disc', 'x', 'app');
    mk('disc', 'y', 'app');
    mainRepo = mk('disc', 'main-repo');
    mk('disc', 'main-repo', '.git', 'worktrees', 'feature');
    wtDir = mk('disc', 'main-repo', '.claude', 'worktrees', 'feature');
    writeFileSync(join(wtDir, '.git'), `gitdir: ${join(mainRepo, '.git', 'worktrees', 'feature')}\n`);
    mkdirSync(join(home, 'links'), { recursive: true });
    link(dotted, join(home, 'links', 'proj'), 'dir');
    mk('.codex');
    mk('.agents');

    const claudeRoot = mk('.claude');
    for (const p of [dotted, join(root, 'gone-proj'), home, join(root, 'x', 'app')]) {
      mkdirSync(join(claudeRoot, 'projects', encodeProjectPath(p), 'memory'), { recursive: true });
    }
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      projects: {
        [join(home, 'links', 'proj')]: {}, // symlink → must merge with the decoded dotted dir
        [plain]: {},
        [join(root, 'deleted-long-ago')]: {},
        [join(home, '.claude')]: {},
        [home]: {},
        [join(root, 'y', 'app')]: {},
        [wtDir]: {},
      },
    }));
    writeFileSync(join(home, '.codex', 'config.toml'), `[projects."${plain}"]\ntrust_level = "trusted"\n`);

    const roots = await resolveGlobalRoots({}, home);
    const result = await discoverProjects({
      roots,
      claudeJson: await readConfigFile(roots.claudeConfigJson, 'json'),
      codexConfig: await readConfigFile(join(roots.codexRoot, 'config.toml'), 'toml'),
      sessionProjectPaths: [plain, join(home, '.codex')],
      extraRoots: [extra, join(root, 'added-missing')],
    });
    projects = result.projects;
    encodedToProject = result.encodedToProject;
  });

  it('merges one folder reached by several sources, by realpath, with evidence unioned', () => {
    const p = byPath(plain);
    expect(p?.exists).toBe(true);
    expect(p?.evidence).toEqual(['claude-json', 'codex-config', 'aasc-session']);
  });

  it.skipIf(NO_SYMLINKS)('merges a symlinked path with the folder it resolves to', () => {
    const d = byPath(dotted);
    expect(d?.evidence).toEqual(['claude-projects', 'claude-json']);
    expect(projects.filter((x) => x.realPath === dotted)).toHaveLength(1);
  });

  it('keeps a missing project with exists:false — its memory is orphaned, not dropped', () => {
    const gone = projects.find((x) => x.name === 'gone-proj');
    expect(gone).toMatchObject({ exists: false, evidence: ['claude-projects'] });
    expect(byPath(join(home, 'disc', 'deleted-long-ago'))).toMatchObject({ exists: false, evidence: ['claude-json'] });
    expect(encodedToProject.get(encodeProjectPath(join(home, 'disc', 'gone-proj')))).toBe(gone?.id);
  });

  it('marks home as isHome and never lists a global root as a project', () => {
    expect(byPath(home)).toMatchObject({ isHome: true, evidence: ['claude-projects', 'claude-json'] });
    expect(byPath(join(home, '.claude'))).toBeUndefined();
    expect(byPath(join(home, '.codex'))).toBeUndefined();
  });

  it('records hand-added roots with evidence "added", existing or not', () => {
    expect(byPath(extra)).toMatchObject({ exists: true, evidence: ['added'] });
    expect(byPath(join(home, 'disc', 'added-missing'))).toMatchObject({ exists: false, evidence: ['added'] });
  });

  it('flags duplicate basenames on both projects', () => {
    const apps = projects.filter((x) => x.name === 'app');
    expect(apps).toHaveLength(2);
    expect(apps.every((x) => x.duplicateName)).toBe(true);
    expect(byPath(plain)?.duplicateName).toBeFalsy();
  });

  it('detects a linked worktree from its .git file', () => {
    expect(byPath(wtDir)?.worktreeOf).toBe(mainRepo);
    expect(byPath(plain)?.worktreeOf).toBeUndefined();
  });

  it('builds a stable basename-hash id and a display-only ResourceProject', () => {
    const p = byPath(plain) as ProjectRecord;
    expect(p.id).toMatch(/^plain-[0-9a-f]{8}$/);
    const rp = toResourceProject(
      byPath(wtDir) as ProjectRecord,
      (abs) => displayPath(abs, home),
      { skill: 2 },
    );
    expect(rp).toMatchObject({
      name: 'feature',
      path: '~/disc/main-repo/.claude/worktrees/feature',
      worktreeOf: '~/disc/main-repo',
      counts: { skill: 2 },
    });
    expect(JSON.stringify(rp)).not.toContain(home);
  });

  it('keeps going when the Codex config does not parse', async () => {
    writeFileSync(join(home, '.codex', 'config.toml'), '[projects\nbroken = ');
    const roots = await resolveGlobalRoots({}, home);
    const result = await discoverProjects({
      roots,
      claudeJson: await readConfigFile(roots.claudeConfigJson, 'json'),
      codexConfig: await readConfigFile(join(roots.codexRoot, 'config.toml'), 'toml'),
      sessionProjectPaths: [],
      extraRoots: [],
    });
    expect(result.projects.find((x) => x.absPath === plain)?.evidence).toEqual(['claude-json']);
  });
});

describe('walkProjectNested', () => {
  let proj = '';
  const opts = (over: Partial<Parameters<typeof walkProjectNested>[1]> = {}) => ({
    limit: createLimiter(8), maxDepth: 3, maxDirents: 20_000, blocked: new Set<string>(), ...over,
  });

  beforeAll(() => {
    proj = mk('nest', 'proj');
    for (const rel of [
      'CLAUDE.md', 'packages/api/CLAUDE.md', 'packages/api/AGENTS.md', 'a/b/c/CLAUDE.md', 'a/b/c/d/CLAUDE.md',
      'node_modules/x/CLAUDE.md', 'dist/CLAUDE.md', '.claude/worktrees/wt/CLAUDE.md', 'other/CLAUDE.md',
    ]) {
      mkdirSync(join(proj, rel, '..'), { recursive: true });
      writeFileSync(join(proj, rel), '#');
    }
    mkdirSync(join(proj, 'packages', 'api', '.claude', 'skills'), { recursive: true });
    mkdirSync(join(proj, '.codex', 'sub', '.claude'), { recursive: true });
  });

  it('finds nested instructions to depth 3 and nested .claude dirs, skipping the skip list', async () => {
    const r = await walkProjectNested(proj, opts());
    expect(r.instructions.map((i) => i.rel).sort()).toEqual([
      'a/b/c/CLAUDE.md', 'other/CLAUDE.md', 'packages/api/AGENTS.md', 'packages/api/CLAUDE.md',
    ]);
    expect(r.claudeDirs).toEqual([join(proj, 'packages', 'api', '.claude')]);
    expect(r.capped).toBe(false);
  });

  it('never enters a blocked dir (another project, a global root)', async () => {
    const r = await walkProjectNested(proj, opts({ blocked: new Set([join(proj, 'other')]) }));
    expect(r.instructions.map((i) => i.rel)).not.toContain('other/CLAUDE.md');
  });

  it('stops at the dirent cap and says so', async () => {
    const r = await walkProjectNested(proj, opts({ maxDirents: 3 }));
    expect(r.capped).toBe(true);
  });
});

describe('an unreadable project is inaccessible, not missing (review item B)', () => {
  it.skipIf(CANNOT_LOCK)(
    'keeps a project behind an unsearchable folder as inaccessible — never exists:false',
    async () => {
      const locked = mk('locked-parent');
      const proj = mk('locked-parent', 'proj');
      const gone = join(home, 'locked-sibling-gone');
      chmodSync(locked, 0o000);
      try {
        const roots = await resolveGlobalRoots({}, home);
        const { projects } = await discoverProjects({
          roots, claudeJson: { status: 'missing' }, codexConfig: { status: 'missing' },
          sessionProjectPaths: [], extraRoots: [proj, gone],
        });
        const found = projects.find((x) => x.absPath === proj) as ProjectRecord;
        expect(found).toMatchObject({ exists: false, inaccessible: true, evidence: ['added'] });
        expect(toResourceProject(found, (abs) => displayPath(abs, home), {}).exists).toBe(true);
        expect(projects.find((x) => x.absPath === gone)).toMatchObject({ exists: false });
        expect(projects.find((x) => x.absPath === gone)?.inaccessible).toBeUndefined();
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});
