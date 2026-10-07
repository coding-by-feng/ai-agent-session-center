import { describe, it, expect } from 'vitest';
import { uniqueProjectOptions } from './projectOptions';

describe('uniqueProjectOptions', () => {
  it('gives one option per path, joining the names it was recorded under', () => {
    expect(
      uniqueProjectOptions([
        { project_path: '/Users/me', project_name: 'Home' },
        { project_path: '/Users/me/app', project_name: 'app' },
        { project_path: '/Users/me', project_name: 'kasonzhan' },
      ]),
    ).toEqual([
      { value: '/Users/me', label: 'Home / kasonzhan' },
      { value: '/Users/me/app', label: 'app' },
    ]);
  });

  it('names a nameless project by its path and copes with no data yet', () => {
    expect(uniqueProjectOptions([{ project_path: '/srv/x', project_name: '' }])).toEqual([
      { value: '/srv/x', label: '/srv/x' },
    ]);
    expect(uniqueProjectOptions(undefined)).toEqual([]);
  });
});
