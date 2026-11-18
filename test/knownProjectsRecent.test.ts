// knownProjectsRecent.test.ts — New session's recent projects are ranked by how recently a session was
// active in them (Nov 18 2026), not by how many sessions they had: the folder you worked in this hour
// leads, the busiest folder of the month does not. Folders with no sessions keep A→Z at the end.
// (`rankProjects`, most used first, still orders the RESOURCES Projects list: knownProjectsRank.test.ts.)
import { describe, expect, it } from 'vitest';
import { liveProjectActivity, rankRecentProjects } from '../server/knownProjects.js';

describe('rankRecentProjects', () => {
  it('puts the folder with the newest activity first, however many sessions another had', () => {
    const ranked = rankRecentProjects(['/a', '/b', '/c'], [
      { project_path: '/a', recent: 1, last: 900 },
      { project_path: '/b', recent: 9, last: 50 },
      { project_path: '/c', recent: 3, last: 100 },
    ]);
    expect(ranked).toEqual(['/a', '/c', '/b']);
  });

  it('breaks a tie on the newest activity by the sessions in the window', () => {
    const ranked = rankRecentProjects(['/a', '/b'], [
      { project_path: '/a', recent: 2, last: 100 },
      { project_path: '/b', recent: 5, last: 100 },
    ]);
    expect(ranked).toEqual(['/b', '/a']);
  });

  it('ranks a folder used long ago by its last activity, above never-used ones', () => {
    const ranked = rankRecentProjects(['/a', '/old', '/z', '/busy'], [
      { project_path: '/old', recent: 0, last: 5 },
      { project_path: '/busy', recent: 4, last: 10 },
    ]);
    expect(ranked).toEqual(['/busy', '/old', '/a', '/z']);
  });

  it('keeps folders with no sessions in path order and treats a null last as no activity', () => {
    const ranked = rankRecentProjects(['/m', '/b', '/x'], [{ project_path: '/x', recent: 0, last: null }]);
    expect(ranked).toEqual(['/b', '/m', '/x']);
  });

  it('only ranks the given folders and never adds a session path that is not a known project', () => {
    const ranked = rankRecentProjects(['/a'], [{ project_path: '/elsewhere', recent: 50, last: 999 }]);
    expect(ranked).toEqual(['/a']);
  });

  it('counts a session in one of the project’s worktrees as activity in the project', () => {
    const ranked = rankRecentProjects(['/code/app', '/code/other'], [
      { project_path: '/code/other', recent: 3, last: 500 },
      { project_path: '/code/app', recent: 1, last: 100 },
      { project_path: '/code/app/.claude/worktrees/perf-remote-link', recent: 2, last: 900 },
    ]);
    expect(ranked).toEqual(['/code/app', '/code/other']); // and the worktree itself is never listed
  });

  it('takes the newest of several rows for one folder and adds up their sessions', () => {
    // The stored time can lag a session that is running: the live one is given as a second row.
    const ranked = rankRecentProjects(['/a', '/b', '/c'], [
      { project_path: '/a', recent: 1, last: 100 },
      { project_path: '/b', recent: 1, last: 300 },
      { project_path: '/a', recent: 0, last: 800 },
      { project_path: '/c', recent: 1, last: 300 },
      { project_path: '/c', recent: 4, last: null },
    ]);
    expect(ranked).toEqual(['/a', '/c', '/b']);
  });
});

describe('liveProjectActivity', () => {
  it('gives each running session’s folder its latest activity, and counts no session twice', () => {
    const rows = liveProjectActivity([
      { projectPath: '/a', lastActivityAt: 700 },
      { projectPath: '/b', lastActivityAt: 0 },
      { projectPath: '', lastActivityAt: 900 },
      { lastActivityAt: 900 },
      { projectPath: '/c' },
    ]);
    expect(rows).toEqual([{ project_path: '/a', recent: 0, last: 700 }]);
  });
});
