// test/mcp/paths.test.ts — how the central registry (and scope.ts after it) names a project folder,
// so that two spellings of one folder are one scope key.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeFolder } from '../../server/mcp/paths.js';

describe('normalizeFolder', () => {
  it('expands a leading ~ to the home folder', () => {
    expect(normalizeFolder('~/x')).toBe(join(homedir(), 'x'));
    expect(normalizeFolder('~')).toBe(resolve(homedir()));
  });

  it('drops a trailing slash', () => {
    expect(normalizeFolder('/a/proj/')).toBe('/a/proj');
    expect(normalizeFolder('/a/proj///')).toBe('/a/proj');
  });

  it('resolves . and .. segments', () => {
    expect(normalizeFolder('/a/./proj/../proj')).toBe('/a/proj');
  });

  it('keeps the root as /', () => {
    expect(normalizeFolder('/')).toBe('/');
  });

  it('gives every spelling of one folder the same name', () => {
    const spellings = ['/a/proj', '/a/proj/', '/a//proj', '/a/./proj', '/a/x/../proj/'];
    expect(new Set(spellings.map(normalizeFolder))).toEqual(new Set(['/a/proj']));
  });

  it('leaves a ~ that does not start the path, or names another user, unexpanded', () => {
    expect(normalizeFolder('/a/~/b')).toBe('/a/~/b');
    expect(normalizeFolder('~other/x')).toBe(resolve('~other/x'));
  });
});
