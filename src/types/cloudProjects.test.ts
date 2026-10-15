import { describe, expect, it } from 'vitest';
import { LocalProjectSchema } from './cloudProjects.js';

// The client renders `openUrl` as a link href, so only the local project browser may come through.
describe('LocalProjectSchema.openUrl', () => {
  const base = { state: 'ready', branch: 'main', localProjectId: 'local' } as const;
  it('accepts the project browser link the server builds', () => {
    expect(
      LocalProjectSchema.parse({ ...base, openUrl: '/project-browser?path=%2FUsers%2Fme%2Frepo' })
        .openUrl,
    ).toBe('/project-browser?path=%2FUsers%2Fme%2Frepo');
    expect(LocalProjectSchema.parse({ ...base, openUrl: null }).openUrl).toBeNull();
  });
  it.each([
    'javascript:alert(1)',
    'https://evil.example/',
    '//evil.example/project-browser?path=x',
    '/resources',
  ])('refuses %s', (openUrl) => {
    expect(LocalProjectSchema.safeParse({ ...base, openUrl }).success).toBe(false);
  });
});
