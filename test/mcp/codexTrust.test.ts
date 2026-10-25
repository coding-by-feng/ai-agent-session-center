// test/mcp/codexTrust.test.ts — the owner's Codex trust record, read-only (server/codexTrust.ts, Ruling P4-46). Every
// read goes through an injected reader: the real ~/.codex/config.toml is never touched.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexConfigPath, createCodexTrust, trustedFolders } from '../../server/codexTrust.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const RECORD = [
  'model = "gpt-5"',
  '',
  '[projects."/Users/me/app"]',
  'trust_level = "trusted"',
  '',
  '[projects."/Users/me/scratch"]',
  'trust_level = "untrusted"',
  '',
].join('\n');

function world(text: string | null, mtime: number | null = 1) {
  const state = { text, mtime };
  const read = vi.fn(() => {
    if (state.text === null) throw new Error('EACCES');
    return state.text;
  });
  const links: Record<string, string> = { '/link/app': '/Users/me/app' };
  // Like realpath(3): links resolved, a trailing slash dropped.
  const realpath = (p: string): string => links[p.replace(/(.)\/+$/, '$1')] ?? p.replace(/(.)\/+$/, '$1');
  const trust = createCodexTrust({ mtime: () => state.mtime, read, realpath });
  return { state, read, trust };
}

describe('the Codex trust record (Ruling P4-46)', () => {
  it('lists only the [projects."…"] tables marked trusted', () => {
    expect(trustedFolders(RECORD)).toEqual(['/Users/me/app']);
    expect(trustedFolders('[projects]\n"/x" = 1\n')).toEqual([]);
    expect(trustedFolders('not = [toml')).toEqual([]);
  });

  it('a key that names a symlink is not trusted for its target', () => {
    // Codex matches its own cwd against the keys as written (Ruling P4-51): a key naming the link is not the target.
    const { trust } = world('[projects."/link/app"]\ntrust_level = "trusted"\n');
    expect(trust.trusts('/Users/me/app')).toBe(false);
    expect(trust.trusts('/link/app')).toBe(false);
  });

  it('a key with a trailing slash is not trusted', () => {
    const { trust } = world('[projects."/Users/me/app/"]\ntrust_level = "trusted"\n');
    expect(trust.trusts('/Users/me/app')).toBe(false);
  });

  it('CODEX_HOME is read', () => {
    vi.stubEnv('CODEX_HOME', '/opt/codex-home');
    expect(codexConfigPath()).toBe('/opt/codex-home/config.toml');
    vi.stubEnv('CODEX_HOME', '');
    expect(codexConfigPath()).toMatch(/\/\.codex\/config\.toml$/);
    // The default reader follows it: a scratch CODEX_HOME, never the owner's file.
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'aasc-codex-home-')));
    const empty = realpathSync.native(mkdtempSync(join(tmpdir(), 'aasc-codex-empty-')));
    try {
      // The key as Codex writes it: the folder's physical path (macOS's tmpdir is under a /var → /private/var link).
      writeFileSync(join(home, 'config.toml'), `[projects."${home}"]\ntrust_level = "trusted"\n`);
      vi.stubEnv('CODEX_HOME', home);
      expect(createCodexTrust().trusts(home)).toBe(true);
      vi.stubEnv('CODEX_HOME', empty);
      expect(createCodexTrust().trusts(home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('compares the folder’s real path with the keys as written: a link to a trusted folder is trusted, a sub-folder is not', () => {
    const { trust } = world(RECORD);
    expect(trust.trusts('/Users/me/app')).toBe(true);
    expect(trust.trusts('/link/app')).toBe(true);
    expect(trust.trusts('/Users/me/app/sub')).toBe(false);
    expect(trust.trusts('/Users/me/scratch')).toBe(false);
  });

  it('parses again only when the file’s mtime changes', () => {
    const { state, read, trust } = world(RECORD);
    trust.trusts('/Users/me/app');
    trust.trusts('/Users/me/app');
    expect(read).toHaveBeenCalledTimes(1);
    state.text = '';
    state.mtime = 2;
    expect(trust.trusts('/Users/me/app')).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('an unreadable Codex config trusts nothing', () => {
    expect(world(null).trust.trusts('/Users/me/app')).toBe(false);
    expect(world(RECORD, null).trust.trusts('/Users/me/app')).toBe(false);
    expect(world('[projects."/Users/me/app"\ntrust_level = "trusted"').trust.trusts('/Users/me/app')).toBe(false);
  });
});
