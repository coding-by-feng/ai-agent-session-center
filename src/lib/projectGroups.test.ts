import { describe, it, expect } from 'vitest';
import {
  groupSessionsByProject,
  normalizeProjectPath,
  projectColorIndex,
  projectKey,
} from './projectGroups';
import type { Session } from '@/types/session';

const session = (over: Partial<Session> & { sessionId: string }): Session =>
  ({
    status: 'idle',
    title: '',
    projectName: '',
    projectPath: '',
    ...over,
  }) as Session;

const ids = (list: readonly Session[]) => list.map((s) => s.sessionId);

describe('normalizeProjectPath', () => {
  it('strips trailing separators and surrounding whitespace', () => {
    expect(normalizeProjectPath('/Users/me/app/')).toBe('/Users/me/app');
    expect(normalizeProjectPath('/Users/me/app///')).toBe('/Users/me/app');
    expect(normalizeProjectPath('  /Users/me/app  ')).toBe('/Users/me/app');
  });

  it('reads both separators, so one Windows directory has one spelling', () => {
    expect(normalizeProjectPath('C:\\work\\app\\')).toBe('C:/work/app');
    expect(normalizeProjectPath('C:\\work/app')).toBe('C:/work/app');
    expect(normalizeProjectPath('C:/work/app')).toBe('C:/work/app');
  });

  it('collapses doubled separators', () => {
    expect(normalizeProjectPath('/w//app')).toBe('/w/app');
    expect(normalizeProjectPath('/w///app//')).toBe('/w/app');
  });

  it('keeps the filesystem root as a root', () => {
    expect(normalizeProjectPath('/')).toBe('/');
    expect(normalizeProjectPath('///')).toBe('/');
  });

  it('returns an empty string when there is no path to group by', () => {
    expect(normalizeProjectPath('')).toBe('');
    expect(normalizeProjectPath('   ')).toBe('');
    expect(normalizeProjectPath(undefined)).toBe('');
    expect(normalizeProjectPath(null)).toBe('');
  });
});

describe('projectKey', () => {
  it('is the same for every spelling of one local directory', () => {
    const a = projectKey(session({ sessionId: 'a', projectPath: '/Users/me/app' }));
    const b = projectKey(session({ sessionId: 'b', projectPath: '/Users/me/app/', sshHost: 'localhost' }));
    const c = projectKey(session({ sessionId: 'c', projectPath: '/Users/me/app', sshHost: '127.0.0.1' }));
    expect(a).toBe('localhost|/Users/me/app');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('differs for the same path on another host', () => {
    const local = projectKey(session({ sessionId: 'a', projectPath: '/srv/app' }));
    const remote = projectKey(session({ sessionId: 'b', projectPath: '/srv/app', sshHost: 'Build-Box' }));
    expect(remote).toBe('build-box|/srv/app');
    expect(remote).not.toBe(local);
  });

  it('reads the host from sshConfig when the card was created from a hook and carries no sshHost', () => {
    // sessionMatcher copies sshConfig onto a card it creates from a hook, but not sshHost.
    const remote = projectKey(
      session({ sessionId: 'a', projectPath: '/srv/app', sshConfig: { host: 'Build-Box' } as Session['sshConfig'] }),
    );
    expect(remote).toBe('build-box|/srv/app');
    const local = projectKey(
      session({ sessionId: 'b', projectPath: '/srv/app', sshConfig: { host: 'localhost' } as Session['sshConfig'] }),
    );
    expect(local).toBe('localhost|/srv/app');
  });

  it('prefers sshHost over sshConfig.host', () => {
    const key = projectKey(
      session({ sessionId: 'a', projectPath: '/srv/app', sshHost: 'one', sshConfig: { host: 'two' } as Session['sshConfig'] }),
    );
    expect(key).toBe('one|/srv/app');
  });

  it('is null for a session with no project path', () => {
    expect(projectKey(session({ sessionId: 'a', projectPath: '' }))).toBeNull();
    expect(projectKey(session({ sessionId: 'a', projectPath: '  ' }))).toBeNull();
  });
});

describe('groupSessionsByProject', () => {
  it('puts sessions that share a directory in one group, keeping their incoming order', () => {
    const { groups, ungrouped } = groupSessionsByProject([
      session({ sessionId: 's1', projectPath: '/w/app', projectName: 'app' }),
      session({ sessionId: 's2', projectPath: '/w/kts', projectName: 'kts' }),
      session({ sessionId: 's3', projectPath: '/w/app/', projectName: 'app' }),
    ]);
    expect(groups.map((g) => g.path)).toEqual(['/w/app', '/w/kts']);
    expect(ids(groups[0].sessions)).toEqual(['s1', 's3']);
    expect(ids(groups[1].sessions)).toEqual(['s2']);
    expect(ungrouped).toEqual([]);
  });

  it('leaves sessions without a path out of every group, in order', () => {
    const { groups, ungrouped } = groupSessionsByProject([
      session({ sessionId: 'x1', projectPath: '' }),
      session({ sessionId: 'a', projectPath: '/w/app', projectName: 'app' }),
      session({ sessionId: 'x2', projectPath: '' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(ids(ungrouped)).toEqual(['x1', 'x2']);
  });

  it('orders the groups alphabetically by label whatever order the sessions arrive in', () => {
    const input = [
      session({ sessionId: '1', projectPath: '/w/zeta' }),
      session({ sessionId: '2', projectPath: '/w/Alpha' }),
      session({ sessionId: '3', projectPath: '/w/mid' }),
    ];
    const forward = groupSessionsByProject(input).groups.map((g) => g.label);
    const backward = groupSessionsByProject([...input].reverse()).groups.map((g) => g.label);
    expect(forward).toEqual(['Alpha', 'mid', 'zeta']);
    expect(backward).toEqual(forward);
  });

  describe('launchPath', () => {
    it("is the path a session really used, as it stored it — not the grouping key's tidied spelling", () => {
      const { groups } = groupSessionsByProject([
        session({ sessionId: '1', projectPath: '/w/app/' }),
        session({ sessionId: '2', projectPath: '/w/app' }),
      ]);
      expect(groups[0].path).toBe('/w/app');
      expect(groups[0].launchPath).toBe('/w/app/');
    });

    it('keeps a space the key trims: that folder really ends in one, and a launch must name it', () => {
      const { groups } = groupSessionsByProject([session({ sessionId: '1', projectPath: '/w/app ' })]);
      expect(groups[0].path).toBe('/w/app');
      expect(groups[0].launchPath).toBe('/w/app ');
    });

    it('does not turn "C:\\" into the drive-relative "C:"', () => {
      const { groups } = groupSessionsByProject([session({ sessionId: '1', projectPath: 'C:\\' })]);
      expect(groups[0].launchPath).toBe('C:\\');
    });
  });

  describe('labels', () => {
    it("names a group for its directory, whatever its sessions call themselves", () => {
      const { groups } = groupSessionsByProject([
        session({ sessionId: '1', projectPath: '/Users/me', projectName: 'Home' }),
        session({ sessionId: '2', projectPath: '/Users/me', projectName: 'me' }),
        session({ sessionId: '3', projectPath: '/w/some-app', projectName: '' }),
        session({ sessionId: '4', projectPath: 'C:\\work\\win-app', projectName: 'ignored' }),
      ]);
      expect(groups.map((g) => g.label).sort()).toEqual(['me', 'some-app', 'win-app']);
    });

    it('cannot be flipped, or the frame moved, by a session joining or leaving with another name', () => {
      // A home-directory frame holds two discovered cards named for the folder and, later, one the
      // dashboard started and named "Home". A label drawn from the sessions' names would flip, and the
      // frame — sorted by that label — would jump past its neighbour.
      const base = [
        session({ sessionId: 'a', projectPath: '/Users/lz', projectName: 'lz' }),
        session({ sessionId: 'b', projectPath: '/Users/me', projectName: 'me' }),
        session({ sessionId: 'c', projectPath: '/Users/me', projectName: 'me' }),
      ];
      const before = groupSessionsByProject(base).groups.map((g) => g.label);
      const after = groupSessionsByProject([
        ...base,
        session({ sessionId: 'd', projectPath: '/Users/me', projectName: 'Home' }),
        session({ sessionId: 'e', projectPath: '/Users/me', projectName: 'Home' }),
      ]).groups.map((g) => g.label);
      expect(before).toEqual(['lz', 'me']);
      expect(after).toEqual(before);
    });

    it('tells two projects with one name apart by their parent folder', () => {
      const { groups } = groupSessionsByProject([
        session({ sessionId: '1', projectPath: '/work/app' }),
        session({ sessionId: '2', projectPath: '/play/app' }),
        session({ sessionId: '3', projectPath: '/work/other' }),
      ]);
      const labels = groups.map((g) => g.label);
      expect(labels).toContain('work/app');
      expect(labels).toContain('play/app');
      expect(labels).toContain('other'); // an unrelated project keeps its plain name
      expect(new Set(labels).size).toBe(labels.length);
    });

    it('keeps going up the path until the clashing names are distinct', () => {
      const { groups } = groupSessionsByProject([
        session({ sessionId: '1', projectPath: '/a/x/app' }),
        session({ sessionId: '2', projectPath: '/b/x/app' }),
      ]);
      expect(groups.map((g) => g.label).sort()).toEqual(['a/x/app', 'b/x/app']);
    });

    it('does not change where a clashing project sits: order is by the plain name', () => {
      const input = [
        session({ sessionId: '1', projectPath: '/work/app' }),
        session({ sessionId: '2', projectPath: '/play/app' }),
        session({ sessionId: '3', projectPath: '/zzz/beta' }),
        session({ sessionId: '4', projectPath: '/aaa/alpha' }),
      ];
      const order = groupSessionsByProject(input).groups.map((g) => g.path);
      // alpha, then the two "app"s (by key), then beta — never regrouped under their longer labels.
      expect(order).toEqual(['/aaa/alpha', '/play/app', '/work/app', '/zzz/beta']);
    });

    it('falls back to the full path when no folder depth tells two projects apart', () => {
      // On a case-sensitive disk these are different directories whose every folder name matches
      // case-insensitively, so no number of parent folders separates them.
      const { groups } = groupSessionsByProject([
        session({ sessionId: '1', projectPath: '/Users/me/App' }),
        session({ sessionId: '2', projectPath: '/Users/me/app' }),
      ]);
      const labels = groups.map((g) => g.label).sort();
      expect(labels).toEqual(['/Users/me/App', '/Users/me/app']);
    });
  });

  it('treats local spellings as one host and flags it launchable', () => {
    const { groups } = groupSessionsByProject([
      session({ sessionId: '1', projectPath: '/w/app' }),
      session({ sessionId: '2', projectPath: '/w/app', sshHost: 'localhost' }),
      session({ sessionId: '3', projectPath: '/w/app', sshHost: '127.0.0.1' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ host: 'localhost', local: true, key: 'localhost|/w/app' });
  });

  it('gives a remote host its own, non-launchable group labelled with the host', () => {
    const { groups } = groupSessionsByProject([
      session({ sessionId: '1', projectPath: '/srv/app' }),
      session({ sessionId: '2', projectPath: '/srv/app', sshHost: 'build-box' }),
    ]);
    expect(groups).toHaveLength(2);
    const remote = groups.find((g) => !g.local)!;
    const local = groups.find((g) => g.local)!;
    expect(remote.label).toBe('app@build-box');
    expect(remote.host).toBe('build-box');
    expect(local.label).toBe('app');
  });

  it('finds a remote project through sshConfig too, so it is never offered a LOCAL launch', () => {
    const { groups } = groupSessionsByProject([
      session({ sessionId: '1', projectPath: '/srv/app', sshConfig: { host: 'build-box' } as Session['sshConfig'] }),
    ]);
    expect(groups[0]).toMatchObject({ host: 'build-box', local: false, label: 'app@build-box' });
  });

  it('returns nothing for an empty list', () => {
    expect(groupSessionsByProject([])).toEqual({ groups: [], ungrouped: [] });
  });

  it('does not modify the sessions it was given', () => {
    const input = [session({ sessionId: '1', projectPath: '/w/app/', projectName: 'app' })];
    const snapshot = JSON.stringify(input);
    groupSessionsByProject(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('colours', () => {
  const project = (n: number, extra: Partial<Session> = {}) =>
    session({ sessionId: `s${n}`, projectPath: `/w/p${n}`, ...extra });

  it('projectColorIndex is deterministic and stays inside the palette', () => {
    for (const key of ['localhost|/a', 'localhost|/b', 'build|/srv/app', '']) {
      const i = projectColorIndex(key, 8);
      expect(i).toBe(projectColorIndex(key, 8));
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(8);
    }
  });

  it('a lone project gets its own hashed colour', () => {
    const { groups } = groupSessionsByProject([session({ sessionId: '1', projectPath: '/w/app' })], 8);
    expect(groups[0].colorIndex).toBe(projectColorIndex(groups[0].key, 8));
  });

  it('moves a project off a colour its neighbour already took', () => {
    // Find two directories whose hashed colours collide, so the test does not
    // depend on which colours the hash happens to hand out.
    const seen = new Map<number, string>();
    let pair: [string, string] | null = null;
    for (let n = 0; n < 200 && !pair; n++) {
      const path = `/w/project-${n}`;
      const colour = projectColorIndex(`localhost|${path}`, 8);
      const earlier = seen.get(colour);
      if (earlier) pair = [earlier, path];
      else seen.set(colour, path);
    }
    expect(pair).not.toBeNull();
    const { groups } = groupSessionsByProject(
      pair!.map((path, i) => session({ sessionId: String(i), projectPath: path })),
      8,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].colorIndex).not.toBe(groups[1].colorIndex);
  });

  it('gives the first eight projects eight different colours', () => {
    const { groups } = groupSessionsByProject(Array.from({ length: 8 }, (_, i) => project(i)), 8);
    expect(new Set(groups.map((g) => g.colorIndex)).size).toBe(8);
  });

  it('reuses a colour only once all eight are taken — the first eight stay distinct', () => {
    const { groups } = groupSessionsByProject(Array.from({ length: 11 }, (_, i) => project(i)), 8);
    expect(groups).toHaveLength(11);
    groups.forEach((g) => {
      expect(g.colorIndex).toBeGreaterThanOrEqual(0);
      expect(g.colorIndex).toBeLessThan(8);
    });
    // Colours are handed out in key order, so the eight keys that sort first are the eight distinct ones.
    const inKeyOrder = [...groups].sort((a, b) => (a.key < b.key ? -1 : 1)).slice(0, 8);
    expect(new Set(inKeyOrder.map((g) => g.colorIndex)).size).toBe(8);
  });

  it('does not depend on what the sessions are called, or on the order they arrive in', () => {
    const colours = (list: Session[]) =>
      Object.fromEntries(groupSessionsByProject(list, 8).groups.map((g) => [g.path, g.colorIndex]));
    const plain = Array.from({ length: 6 }, (_, i) => project(i));
    const renamed = plain.map((s, i) => ({ ...s, projectName: i % 2 ? 'Home' : 'me' }));
    expect(colours(renamed)).toEqual(colours(plain));
    expect(colours([...plain].reverse())).toEqual(colours(plain));
  });

  it("keeps a project's colour when others are filtered out, if the whole workspace is given as the palette's universe", () => {
    // Colour collisions are resolved among the projects that share the palette. Resolving them among only
    // the VISIBLE ones recoloured a project every time the room filter changed what was visible.
    //
    // Needs a real collision to mean anything: find two directories whose hashed colours are the same.
    const seen = new Map<number, string>();
    let pair: [string, string] | null = null;
    for (let n = 0; n < 200 && !pair; n++) {
      const path = `/w/project-${n}`;
      const colour = projectColorIndex(`localhost|${path}`, 8);
      const earlier = seen.get(colour);
      if (earlier) pair = [earlier, path];
      else seen.set(colour, path);
    }
    expect(pair).not.toBeNull();
    // The one that sorts second by key is the one moved off its hashed colour.
    const [first, second] = [...pair!].sort((a, b) => (`localhost|${a}` < `localhost|${b}` ? -1 : 1));
    const everything = [first, second, '/w/other-a', '/w/other-b'].map((p, i) =>
      session({ sessionId: `u${i}`, projectPath: p }),
    );
    const secondSession = everything[1];
    const colourOfSecond = (shown: Session[], universe?: Session[]) =>
      groupSessionsByProject(shown, 8, universe).groups.find((g) => g.path === second)!.colorIndex;

    const inFullView = colourOfSecond(everything, everything);
    expect(inFullView).not.toBe(projectColorIndex(`localhost|${second}`, 8)); // it really was moved

    // Filtered down to it alone, or to any subset that still holds it, it keeps that colour.
    expect(colourOfSecond([secondSession], everything)).toBe(inFullView);
    expect(colourOfSecond([secondSession, everything[2]], everything)).toBe(inFullView);
    expect(colourOfSecond([everything[3], secondSession], everything)).toBe(inFullView);

    // Without the universe it can only be resolved among what is shown, and alone it takes its hashed colour.
    expect(colourOfSecond([secondSession])).toBe(projectColorIndex(`localhost|${second}`, 8));
  });

  it('gives a project in the shown list a colour even when the universe omits it', () => {
    const { groups } = groupSessionsByProject([project(1)], 8, []);
    expect(groups[0].colorIndex).toBeGreaterThanOrEqual(0);
    expect(groups[0].colorIndex).toBeLessThan(8);
  });
});
