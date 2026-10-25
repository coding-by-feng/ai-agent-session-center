// test/mcp/routerResolveWork.test.ts — how much work resolveProject does, counted in operations and never in
// milliseconds: a loaded machine cannot fail these, and a loop that grows with every repeat of a name or a path cannot
// pass them. A task can be 60 000 characters (a pasted log names the same project or path thousands of times) and a
// person can have thousands of projects, several of them with one name (`web`, `app`, `api`).
import { describe, expect, it } from 'vitest';
import type { KnownProject } from '../../server/mcp/projectIndex.js';
import { namedProjects, openNames, resolveProject, type NameMention } from '../../server/mcp/resolveProject.js';
import { HOME, RANGI, SITE, project, resolveEnv } from './routerFixtures.js';
import { NOW } from './toolHarness.js';

const words = (word: string, times: number): string[] => Array.from({ length: times }, () => word);
const foldersOf = (list: readonly KnownProject[]): string[] => list.map((p) => p.folder);

/** An array that counts how many of its elements are read. */
function counting<T>(items: T[], onRead: () => void): T[] {
  return new Proxy(items, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) onRead();
      return Reflect.get(target, key, receiver);
    },
  });
}

describe('naming projects: work follows the words of the task, not how often a name repeats', () => {
  const webs = Array.from({ length: 20 }, (_, i) => project(`${HOME}/w${i}/web`, { sources: ['history'], lastActiveAt: NOW - i }));

  it('asks about each project once, however often its name is in the task', () => {
    const asked: string[] = [];

    const named = namedProjects(words('web', 4_000), webs, (folder) => (asked.push(folder), true));

    expect(named).toHaveLength(20);
    expect(asked).toHaveLength(20);
  });

  it('asks about no project whose name is not in the task, however long the task', () => {
    const asked: string[] = [];

    const named = namedProjects(words('lib', 4_000), webs, (folder) => (asked.push(folder), true));

    expect(named).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('names every project that shares a written name, the most recent first', () => {
    const named = namedProjects(words('web', 4_000), [...webs].reverse(), () => true);

    expect(foldersOf(named)).toEqual(foldersOf(webs));
  });

  it('a name written thousands of times does not name the projects that cannot be used', () => {
    const named = namedProjects(words('web', 4_000), webs, (folder) => folder.includes('/w7/') || folder.includes('/w9/'));

    expect(foldersOf(named)).toEqual([`${HOME}/w7/web`, `${HOME}/w9/web`]);
  });

  it('thousands of mentions inside a longer name name only the longer project, until one stands alone', () => {
    const both = [project(SITE, { sources: ['history'] }), project(RANGI, { sources: ['history'] })];
    const inside = Array.from({ length: 4_000 }, () => ['rangi', 'site']).flat();

    expect(foldersOf(namedProjects(inside, both, () => true))).toEqual([RANGI]);
    expect(foldersOf(namedProjects([...inside, 'site'], both, () => true))).toEqual([RANGI, SITE]);
  });

  it('projects whose names share their first word are told apart by their other words, reading each word of the task a few times', () => {
    const apps = Array.from({ length: 3_000 }, (_, i) => project(`${HOME}/code/my-app-${i}`, { sources: ['history'] }));
    const task = [...words('my', 4_000), 'app', '41'];
    let reads = 0;

    const named = namedProjects(counting(task, () => (reads += 1)), apps, () => true);

    expect(foldersOf(named)).toEqual([`${HOME}/code/my-app-41`]);
    // One pass to place the words, then only the few places a name's rarest word is: not 4 000 places for each of 3 000 names.
    expect(reads).toBeLessThanOrEqual(2 * task.length);
  });
});

describe('covered mentions: each is read a few times, never once per longer mention', () => {
  it('three names on the same words, two thousand times over, name only the longest', () => {
    let reads = 0;
    const times = 2_000;
    const spans = (offset: number, length: number) =>
      Array.from({ length: times }, (_, i) => ({ start: 3 * i + offset, end: 3 * i + offset + length }));
    const mention = (rank: number, offset: number): NameMention => ({
      projects: [project(`${HOME}/code/n${rank}`)],
      rank,
      spans: counting(spans(offset, rank), () => (reads += 1)),
    });
    // `a b c` written as three words, `b c` inside it, and `c` inside both.
    const names = [mention(1, 2), mention(3, 0), mention(2, 1)];

    const open = openNames(names, 3 * times);

    expect(open.map((n) => n.rank)).toEqual([3]);
    // Every mention is read in two passes (is it covered? then it covers): a nested search would read millions.
    expect(reads).toBeLessThanOrEqual(2 * 3 * times);
  });

  it('a mention that starts where a longer one does not undo the longer one’s reach, whatever the order', () => {
    const name = (id: string, rank: number, ...spans: Array<[number, number]>): NameMention => ({
      projects: [project(`${HOME}/code/${id}`)],
      rank,
      spans: spans.map(([start, end]) => ({ start, end })),
    });
    const idsOf = (names: readonly NameMention[]): string[] => names.map((n) => n.projects[0].folder.split('/').pop() ?? '').sort();
    // Two names of two words each start at the first word: one spelled out (`a b`), one written together (`ab`).
    const spelled = name('spelled', 2, [0, 2]);
    const together = name('together', 2, [0, 1]);
    const inner = name('inner', 1, [1, 2]); // `b`, inside `a b`

    expect(idsOf(openNames([spelled, together, inner], 2))).toEqual(['spelled', 'together']);
    expect(idsOf(openNames([together, spelled, inner], 2))).toEqual(['spelled', 'together']);
  });
});

describe('paths in the task: work follows the paths, not the paths times the projects', () => {
  /** Projects whose folders are read through a counter. */
  function counted(length: number): { projects: KnownProject[]; reads: () => number } {
    let reads = 0;
    const projects = Array.from({ length }, (_, i) => {
      const plain = project(`${HOME}/code/proj-${i}`, { sources: ['history'], lastActiveAt: NOW - i });
      return Object.defineProperty({ ...plain }, 'folder', {
        enumerable: true,
        get: () => {
          reads += 1;
          return plain.folder;
        },
      }) as KnownProject;
    });
    return { projects, reads: () => reads };
  }

  it('looks up two thousand different paths without reading every project for each', () => {
    const { projects, reads } = counted(200);
    const task = Array.from({ length: 2_000 }, (_, i) => `${HOME}/code/proj-${i % 200}/src/file${i}.ts`).join(' ');

    const r = resolveProject(task, {}, projects, resolveEnv());

    expect(r.ranked.map((p) => p.by)).toEqual(Array.from({ length: 10 }, () => 'path'));
    expect(r.ranked[0].folder).toBe(`${HOME}/code/proj-0`);
    expect(r.confidence).toBe('medium');
    expect(reads()).toBeLessThanOrEqual(3 * projects.length);
  });

  it('looks up a path written two thousand times once', () => {
    const { projects, reads } = counted(200);
    const task = `${HOME}/code/proj-5/src/a.ts `.repeat(2_000);

    const r = resolveProject(task, {}, projects, resolveEnv());

    expect(r.ranked[0]).toMatchObject({ folder: `${HOME}/code/proj-5`, by: 'path' });
    expect(r.confidence).toBe('high');
    expect(reads()).toBeLessThanOrEqual(3 * projects.length);
  });
});
