// phoneProjectFiles.test.ts — what the phone's Project tab remembers per project
// (AASC-56): the folder, the open files (like the desktop's tabs), the recent
// ones, and the file you were reading, so the tab comes back where you left it.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PROJECT_FILES,
  MAX_OPEN_FILES,
  MAX_RECENT_FILES,
  closedAllFiles,
  closedFile,
  leftFile,
  loadProjectFiles,
  movedToDir,
  openedFile,
  recentNotOpen,
  saveProjectFiles,
  projectFilesKey,
} from './phoneProjectFiles';

const ROOT = '/Users/me/proj';

beforeEach(() => localStorage.clear());

describe('opening and closing files', () => {
  it('opens a file: it joins the open files and leads the recent ones, and is the one being read', () => {
    const s = openedFile(openedFile(EMPTY_PROJECT_FILES, '/a.ts'), '/b.md');
    expect(s.open).toEqual(['/a.ts', '/b.md']);
    expect(s.recent).toEqual(['/b.md', '/a.ts']);
    expect(s.current).toBe('/b.md');
  });

  it('opening an open file again keeps its place among the open ones', () => {
    const s = openedFile(openedFile(openedFile(EMPTY_PROJECT_FILES, '/a.ts'), '/b.md'), '/a.ts');
    expect(s.open).toEqual(['/a.ts', '/b.md']);
    expect(s.recent).toEqual(['/a.ts', '/b.md']);
  });

  it('keeps at most MAX_OPEN_FILES open (the oldest goes) and MAX_RECENT_FILES recent', () => {
    let s = EMPTY_PROJECT_FILES;
    for (let i = 0; i < MAX_RECENT_FILES + 3; i++) s = openedFile(s, `/f${i}.ts`);
    expect(s.open).toHaveLength(MAX_OPEN_FILES);
    expect(s.open[0]).toBe(`/f${MAX_RECENT_FILES + 3 - MAX_OPEN_FILES}.ts`);
    expect(s.recent).toHaveLength(MAX_RECENT_FILES);
    expect(s.recent[0]).toBe(`/f${MAX_RECENT_FILES + 2}.ts`);
  });

  it('closes one file, or all, and stops reading a closed one', () => {
    const s = openedFile(openedFile(EMPTY_PROJECT_FILES, '/a.ts'), '/b.md');
    const one = closedFile(s, '/b.md');
    expect(one.open).toEqual(['/a.ts']);
    expect(one.current).toBeNull();
    expect(one.recent).toEqual(['/b.md', '/a.ts']);
    expect(closedFile(s, '/a.ts').current).toBe('/b.md');
    const all = closedAllFiles(s);
    expect(all.open).toEqual([]);
    expect(all.current).toBeNull();
  });

  it('leaving a file (Back) keeps it open but reads none', () => {
    const s = leftFile(openedFile(EMPTY_PROJECT_FILES, '/a.ts'));
    expect(s.open).toEqual(['/a.ts']);
    expect(s.current).toBeNull();
  });

  it('remembers the folder', () => {
    expect(movedToDir(EMPTY_PROJECT_FILES, '/src/lib').dir).toBe('/src/lib');
  });

  it('lists the recent files that are not open', () => {
    const s = closedFile(openedFile(openedFile(EMPTY_PROJECT_FILES, '/a.ts'), '/b.md'), '/a.ts');
    expect(recentNotOpen(s)).toEqual(['/a.ts']);
  });

  it('never changes the state it was given', () => {
    const s = openedFile(EMPTY_PROJECT_FILES, '/a.ts');
    const copy = JSON.parse(JSON.stringify(s));
    openedFile(s, '/b.ts');
    closedFile(s, '/a.ts');
    closedAllFiles(s);
    leftFile(s);
    expect(s).toEqual(copy);
  });
});

describe('storage, per project', () => {
  it('saves and loads, keyed by the project folder', () => {
    const s = movedToDir(openedFile(EMPTY_PROJECT_FILES, '/src/a.ts'), '/src');
    saveProjectFiles(ROOT, s);
    expect(localStorage.getItem(projectFilesKey(ROOT))).not.toBeNull();
    expect(loadProjectFiles(ROOT)).toEqual(s);
    expect(loadProjectFiles('/other')).toEqual(EMPTY_PROJECT_FILES);
  });

  it('distrusts what it reads: bad JSON or shapes give the empty state, paths are normalised', () => {
    localStorage.setItem(projectFilesKey(ROOT), '{nope');
    expect(loadProjectFiles(ROOT)).toEqual(EMPTY_PROJECT_FILES);
    localStorage.setItem(projectFilesKey(ROOT), JSON.stringify({ dir: 5, open: 'x' }));
    expect(loadProjectFiles(ROOT)).toEqual(EMPTY_PROJECT_FILES);
    localStorage.setItem(projectFilesKey(ROOT), JSON.stringify({ dir: 'src//lib/', open: ['a.ts', '/../b.ts'], recent: ['a.ts'], current: 'a.ts' }));
    const s = loadProjectFiles(ROOT);
    expect(s.dir).toBe('/src/lib');
    expect(s.open).toEqual(['/a.ts', '/b.ts']);
    expect(s.current).toBe('/a.ts');
  });

  it('caps what it reads', () => {
    const many = Array.from({ length: 40 }, (_, i) => `/f${i}`);
    localStorage.setItem(projectFilesKey(ROOT), JSON.stringify({ dir: '/', open: many, recent: many, current: null }));
    const s = loadProjectFiles(ROOT);
    expect(s.open).toHaveLength(MAX_OPEN_FILES);
    expect(s.recent).toHaveLength(MAX_RECENT_FILES);
  });
});
