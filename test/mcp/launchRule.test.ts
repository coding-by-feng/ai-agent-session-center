// test/mcp/launchRule.test.ts — the folder rule every session a central opens obeys (server/mcp/launchRule.ts):
// the phone's launch rule for a folder (a known project root, or an existing folder inside home with no hidden or
// private segment, never home itself or above it) and the one extra rule a project central adds (its folder or
// below). Pure: no test here reads the disk; `folder` is the real path the caller already resolved.
import { describe, expect, it } from 'vitest';
import { LAUNCH_REFUSALS, inCentralScope, isKnownProject, launchRefusal } from '../../server/mcp/launchRule.js';
import type { ToolContext } from '../../server/mcp/registry.js';
import type { CentralKind } from '../../server/mcp/types.js';

const HOME = '/home/tester';

const ctxOf = (kind: CentralKind, scopeRef: string | null): Pick<ToolContext, 'central'> => ({
  central: { centralId: 'c1', kind, scopeRef, cli: 'claude', permissionMode: null, toolsets: [], token: '', terminalId: null, createdAt: 1 },
});

describe('launchRefusal', () => {
  it('home, / and dot-folders are refused', () => {
    expect(launchRefusal(HOME, [], HOME)).toBe(LAUNCH_REFUSALS.homeOrAbove);
    expect(launchRefusal(`${HOME}/`, [], HOME)).toBe(LAUNCH_REFUSALS.homeOrAbove);
    expect(launchRefusal('/', [], HOME)).toBe(LAUNCH_REFUSALS.homeOrAbove);
    expect(launchRefusal('/home', [], HOME)).toBe(LAUNCH_REFUSALS.homeOrAbove);
    expect(launchRefusal(`${HOME}/.config/proj`, [], HOME)).toBe(LAUNCH_REFUSALS.hiddenOrPrivate);
    expect(launchRefusal(`${HOME}/code/.hidden/proj`, [], HOME)).toBe(LAUNCH_REFUSALS.hiddenOrPrivate);
    expect(launchRefusal(`${HOME}/.proj`, [], HOME)).toBe(LAUNCH_REFUSALS.hiddenOrPrivate);
  });

  it('secret segments are refused, a known project included', () => {
    for (const folder of [`${HOME}/Library/proj`, `${HOME}/code/.ssh`, `${HOME}/code/.git/hooks`, `${HOME}/code/.CLAUDE/x`, `${HOME}/code/id_rsa`]) {
      expect(launchRefusal(folder, [], HOME), folder).toBe(LAUNCH_REFUSALS.hiddenOrPrivate);
      expect(launchRefusal(folder, [folder], HOME), `${folder} (known)`).toBe(LAUNCH_REFUSALS.hiddenOrPrivate);
    }
    // `library` is private only directly under home: a project may well be called that.
    expect(launchRefusal(`${HOME}/code/library`, [], HOME)).toBeNull();
  });

  it('a folder outside home is refused', () => {
    expect(launchRefusal('/tmp/proj', [], HOME)).toBe(LAUNCH_REFUSALS.outsideHome);
    expect(launchRefusal('/home/tester2/proj', [], HOME)).toBe(LAUNCH_REFUSALS.outsideHome);
    expect(launchRefusal('/Volumes/ext/proj', [], HOME)).toBe(LAUNCH_REFUSALS.outsideHome);
  });

  it('a known project outside home is allowed, as the phone allows it, but only its exact folder', () => {
    const external = '/Volumes/ext/proj';
    expect(launchRefusal(external, [external], HOME)).toBeNull();
    expect(launchRefusal(`${external}/`, [external], HOME)).toBeNull();
    // Known means exactly the project root: below it, above it or beside it stays outside home.
    expect(launchRefusal(`${external}/sub`, [external], HOME)).toBe(LAUNCH_REFUSALS.outsideHome);
    expect(launchRefusal('/Volumes/ext', [external], HOME)).toBe(LAUNCH_REFUSALS.outsideHome);
    expect(launchRefusal(`${external}/../other`, [external], HOME)).toBe(LAUNCH_REFUSALS.outsideHome);
  });

  it('a known project outside home never passes through a private folder', () => {
    for (const folder of ['/Volumes/ext/.ssh', '/Volumes/ext/code/.git/hooks', '/Volumes/ext/id_rsa']) {
      expect(launchRefusal(folder, [folder], HOME), folder).toBe(LAUNCH_REFUSALS.hiddenOrPrivate);
    }
  });

  it('a folder written with .. cannot reach a private one', () => {
    expect(launchRefusal(`${HOME}/proj/../.ssh`, [], HOME)).toBe(LAUNCH_REFUSALS.hiddenOrPrivate);
    expect(launchRefusal(`${HOME}/proj/../../etc`, [], HOME)).toBe(LAUNCH_REFUSALS.outsideHome);
    expect(launchRefusal(`${HOME}/proj/..`, [], HOME)).toBe(LAUNCH_REFUSALS.homeOrAbove);
  });

  it('a folder inside home is allowed, in a project or below it', () => {
    expect(launchRefusal(`${HOME}/proj`, [], HOME)).toBeNull();
    expect(launchRefusal(`${HOME}/Documents/claude/agent-manager`, [], HOME)).toBeNull();
    expect(launchRefusal(`${HOME}/proj/packages/web`, [`${HOME}/proj`], HOME)).toBeNull();
    // A name that merely starts like another folder is not inside it.
    expect(launchRefusal(`${HOME}proj`, [], HOME)).toBe(LAUNCH_REFUSALS.outsideHome);
  });

  it('a known project may sit in a hidden folder, never a private one', () => {
    const hidden = `${HOME}/.openclaw/proj`;
    expect(launchRefusal(hidden, [], HOME)).toBe(LAUNCH_REFUSALS.hiddenOrPrivate);
    expect(launchRefusal(hidden, [hidden], HOME)).toBeNull();
    // Known means exactly the project root, not everything below it.
    expect(launchRefusal(`${hidden}/sub`, [hidden], HOME)).toBe(LAUNCH_REFUSALS.hiddenOrPrivate);
  });

  it('a relative or blank folder is refused', () => {
    expect(launchRefusal('proj', [], HOME)).toBe(LAUNCH_REFUSALS.notAbsolute);
    expect(launchRefusal('../proj', [], HOME)).toBe(LAUNCH_REFUSALS.notAbsolute);
    expect(launchRefusal('', [], HOME)).toBe(LAUNCH_REFUSALS.notAbsolute);
    expect(launchRefusal('   ', [], HOME)).toBe(LAUNCH_REFUSALS.notAbsolute);
  });

  it('~ means the home folder it is given', () => {
    expect(launchRefusal('~/proj', [], HOME)).toBeNull();
    expect(launchRefusal('~', [], HOME)).toBe(LAUNCH_REFUSALS.homeOrAbove);
    expect(launchRefusal('~/.ssh', [], HOME)).toBe(LAUNCH_REFUSALS.hiddenOrPrivate);
  });

  it('a refusal never repeats the folder it refuses', () => {
    for (const folder of ['/tmp/very-secret-name', `${HOME}/.vault-of-secrets`, `${HOME}/Library/x`, HOME, 'relative/odd name']) {
      expect(launchRefusal(folder, [], HOME) ?? '', folder).not.toContain('very-secret-name');
      expect(launchRefusal(folder, [], HOME) ?? '', folder).not.toContain('vault-of-secrets');
      expect(launchRefusal(folder, [], HOME) ?? '', folder).not.toContain('odd name');
    }
  });
});

describe('isKnownProject', () => {
  it('an unknown folder inside home is allowed and not known', () => {
    const folder = `${HOME}/scratch/new-idea`;
    expect(launchRefusal(folder, [`${HOME}/proj`], HOME)).toBeNull();
    expect(isKnownProject(folder, [`${HOME}/proj`])).toBe(false);
  });

  it('a known project is its exact folder, in any spelling', () => {
    expect(isKnownProject(`${HOME}/proj`, [`${HOME}/proj`])).toBe(true);
    expect(isKnownProject(`${HOME}/proj/`, [`${HOME}/proj`])).toBe(true);
    expect(isKnownProject(`${HOME}/proj`, [`${HOME}/other/../proj/`])).toBe(true);
    expect(isKnownProject(`${HOME}/proj/sub`, [`${HOME}/proj`])).toBe(false);
    expect(isKnownProject(`${HOME}/proj2`, [`${HOME}/proj`])).toBe(false);
    expect(isKnownProject(`${HOME}/proj`, [])).toBe(false);
  });
});

describe('inCentralScope', () => {
  it('a project central cannot open outside its folder', () => {
    const ctx = ctxOf('project', `${HOME}/proj`);
    expect(inCentralScope(ctx, `${HOME}/other`)).toBe(false);
    expect(inCentralScope(ctx, `${HOME}/proj2`)).toBe(false);
    expect(inCentralScope(ctx, HOME)).toBe(false);
    expect(inCentralScope(ctx, '/')).toBe(false);
    expect(inCentralScope(ctx, `${HOME}/proj/../other`)).toBe(false);
  });

  it('a project central may open its own folder and anything below it', () => {
    const ctx = ctxOf('project', `${HOME}/proj/`);
    expect(inCentralScope(ctx, `${HOME}/proj`)).toBe(true);
    expect(inCentralScope(ctx, `${HOME}/proj/packages/web`)).toBe(true);
  });

  it('a project central with no folder opens nothing: an unclear scope never widens', () => {
    expect(inCentralScope(ctxOf('project', null), `${HOME}/proj`)).toBe(false);
    expect(inCentralScope(ctxOf('project', '  '), `${HOME}/proj`)).toBe(false);
  });

  it('a room or global central is held to the launch rule only', () => {
    expect(inCentralScope(ctxOf('room', 'r1'), `${HOME}/anywhere`)).toBe(true);
    expect(inCentralScope(ctxOf('global', null), `${HOME}/anywhere`)).toBe(true);
  });

  it('a kind this build does not know opens nothing, folder or no folder', () => {
    const odd = ctxOf('global', null);
    expect(inCentralScope({ central: { ...odd.central, kind: 'galaxy' as CentralKind } }, `${HOME}/proj`)).toBe(false);
    // With a folder it could be held to, it still is not taken for a project central.
    expect(inCentralScope({ central: { ...odd.central, kind: 'galaxy' as CentralKind, scopeRef: `${HOME}/proj` } }, `${HOME}/proj`)).toBe(false);
  });
});
