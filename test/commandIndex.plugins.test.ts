/**
 * Which plugins' commands and skills the `/` lists offer (Nov 19 2026).
 *
 * The catalog listed every plugin in ~/.claude/plugins/installed_plugins.json for every session. A plugin
 * installed for ONE project (`scope: project` / `local`, with its `projectPath`), or switched off in
 * `enabledPlugins`, is not loaded by Claude Code elsewhere: picking its skill on the phone typed
 * `/plugin:skill …`, the CLI answered "Unknown command" and the words after it were lost. On the dev machine
 * `claude-md-management` and `playwright` were installed for one project and offered in all of them.
 *
 * HOME points at a temp dir (os.homedir() reads it), so nothing here depends on the real ~/.claude.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getCommandIndex, clearCommandIndexCache } from '../server/commandIndex.js';

const root = mkdtempSync(join(tmpdir(), 'aasc-plugin-scope-'));
const home = join(root, 'home');
const projA = join(root, 'proj-a');
const projB = join(root, 'proj-b');
const realHome = process.env.HOME;

function plugin(name: string): string {
  const dir = join(home, '.claude', 'plugins', 'cache', name);
  mkdirSync(join(dir, 'skills', `${name}-skill`), { recursive: true });
  writeFileSync(join(dir, 'skills', `${name}-skill`, 'SKILL.md'), `---\nname: ${name}-skill\ndescription: A skill of ${name}\n---\n`);
  mkdirSync(join(dir, 'commands'), { recursive: true });
  writeFileSync(join(dir, 'commands', `${name}-cmd.md`), `---\ndescription: A command of ${name}\n---\nDo it.\n`);
  return dir;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

/** The plugins the list offers for a session in `projectPath`, by name. */
const offered = (projectPath: string | null): string[] =>
  [...new Set(getCommandIndex('claude', projectPath).filter((e) => e.source === 'plugin').map((e) => e.pluginName ?? ''))].sort();

beforeAll(() => {
  process.env.HOME = home;
  for (const dir of [projA, join(projA, 'packages', 'web'), projB]) mkdirSync(dir, { recursive: true });
  writeJson(join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'everywhere@market': [{ scope: 'user', installPath: plugin('everywhere') }],
      'legacy@market': [{ installPath: plugin('legacy') }],
      'only-a@market': [{ scope: 'project', projectPath: projA, installPath: plugin('only-a') }],
      'local-a@market': [{ scope: 'local', projectPath: projA, installPath: plugin('local-a') }],
      'off@market': [{ scope: 'user', installPath: plugin('off') }],
      'off-in-b@market': [{ scope: 'user', installPath: plugin('off-in-b') }],
    },
  });
  writeJson(join(home, '.claude', 'settings.json'), { enabledPlugins: { 'everywhere@market': true, 'off@market': false } });
  writeJson(join(projB, '.claude', 'settings.json'), { enabledPlugins: { 'off-in-b@market': false } });
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => clearCommandIndexCache());

describe('plugin commands and skills in the / list', () => {
  it('offers a plugin installed for one project only in that project (and folders inside it)', () => {
    expect(offered(projA)).toEqual(['everywhere', 'legacy', 'local-a', 'off-in-b', 'only-a']);
    expect(offered(join(projA, 'packages', 'web'))).toEqual(['everywhere', 'legacy', 'local-a', 'off-in-b', 'only-a']);
    expect(offered(projB)).not.toContain('only-a');
    expect(offered(projB)).not.toContain('local-a');
  });

  it('offers only plugins installed for every project when the session has no project folder', () => {
    expect(offered(null)).toEqual(['everywhere', 'legacy', 'off-in-b']);
  });

  it('leaves out a plugin switched off in enabledPlugins, for the user or for that project', () => {
    expect(offered(projA)).not.toContain('off');
    expect(offered(projB)).toEqual(['everywhere', 'legacy']);
  });

  it('lists both the commands and the skills of a plugin it offers', () => {
    const names = getCommandIndex('claude', projA).filter((e) => e.pluginName === 'only-a').map((e) => `${e.kind}:${e.name}`).sort();
    expect(names).toEqual(['command:only-a-cmd', 'skill:only-a-skill']);
  });

  it('is not fooled by a sibling folder whose name starts the same', () => {
    const sibling = `${projA}-two`;
    mkdirSync(sibling, { recursive: true });
    expect(offered(sibling)).not.toContain('only-a');
  });
});
