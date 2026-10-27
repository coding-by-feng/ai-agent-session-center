// knownProjectsRank.test.ts — New session's recent projects are ranked by use (sessions in the
// last 30 days, then the newest activity), not by path; folders with no sessions keep A→Z at the end.
import { describe, expect, it } from 'vitest';
import { rankProjects, PROJECT_ACTIVITY_WINDOW_MS } from '../server/knownProjects.js';

describe('rankProjects', () => {
  it('puts the folder with the most recent sessions first', () => {
    const ranked = rankProjects(['/a', '/b', '/c'], [
      { project_path: '/a', recent: 1, last: 100 },
      { project_path: '/b', recent: 9, last: 50 },
      { project_path: '/c', recent: 3, last: 10 },
    ]);
    expect(ranked).toEqual(['/b', '/c', '/a']);
  });

  it('breaks a tie on session count by the newest activity', () => {
    const ranked = rankProjects(['/a', '/b'], [
      { project_path: '/a', recent: 2, last: 100 },
      { project_path: '/b', recent: 2, last: 900 },
    ]);
    expect(ranked).toEqual(['/b', '/a']);
  });

  it('ranks a folder used only before the window by its last activity, above never-used ones', () => {
    const ranked = rankProjects(['/a', '/old', '/z', '/busy'], [
      { project_path: '/old', recent: 0, last: 5 },
      { project_path: '/busy', recent: 4, last: 1 },
    ]);
    expect(ranked).toEqual(['/busy', '/old', '/a', '/z']);
  });

  it('keeps folders with no sessions in path order and treats a null last as no activity', () => {
    const ranked = rankProjects(['/m', '/b', '/x'], [{ project_path: '/x', recent: 0, last: null }]);
    expect(ranked).toEqual(['/b', '/m', '/x']);
  });

  it('only ranks the given folders and never adds a session path that is not a known project', () => {
    const ranked = rankProjects(['/a'], [{ project_path: '/elsewhere', recent: 50, last: 999 }]);
    expect(ranked).toEqual(['/a']);
  });

  it('uses a 30-day window', () => {
    expect(PROJECT_ACTIVITY_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
