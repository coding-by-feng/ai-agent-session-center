// knownProjectsDecode.test.ts — a Claude Code project folder name decodes back to the real folder, even when the
// folder's name holds a character the encoding turned into `-` (`_`, a space): the known-projects list a phone and a
// central are judged against must not lose a project for its name.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { decodeProjectDir } from '../server/knownProjects.js';

let base: string;
const encode = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-');

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-known-')));
  mkdirSync(join(base, 'Stage', 'thesis_data_backup'), { recursive: true });
  mkdirSync(join(base, 'agent-manager'), { recursive: true });
  mkdirSync(join(base, 'My Drive', 'notes'), { recursive: true });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('decodeProjectDir', () => {
  it('decodes a folder whose name holds a hyphen', () => {
    const folder = join(base, 'agent-manager');
    expect(decodeProjectDir(encode(folder))).toBe(folder);
  });

  it('decodes a folder whose name holds an underscore', () => {
    const folder = join(base, 'Stage', 'thesis_data_backup');
    expect(decodeProjectDir(encode(folder))).toBe(folder);
  });

  it('decodes a folder reached through a name with a space', () => {
    const folder = join(base, 'My Drive', 'notes');
    expect(decodeProjectDir(encode(folder))).toBe(folder);
  });

  it('returns null for a folder that is not there', () => {
    expect(decodeProjectDir(encode(join(base, 'Stage', 'gone_away')))).toBeNull();
  });
});
