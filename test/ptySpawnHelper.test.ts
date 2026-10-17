// node-pty starts every terminal through a small `spawn-helper` binary that must be executable.
// Its own postinstall (and ours, bin/postinstall.js) set the bit, but npm 11 runs no install
// scripts until the user approves them, so an `npx ai-agent-session-center` install shipped the
// helper as 0644 and every terminal failed with "posix_spawnp failed". The server now repairs
// the bit itself before any terminal starts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureSpawnHelperExecutable, spawnHelperCandidates } from '../server/ptySpawnHelper.js';

let root: string;

const helper = (...parts: string[]) => {
  const file = path.join(root, ...parts, 'spawn-helper');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'binary');
  return file;
};
const mode = (file: string) => statSync(file).mode & 0o777;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aasc-pty-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('spawnHelperCandidates', () => {
  it('looks in a local build and in every prebuild folder', () => {
    helper('prebuilds', 'darwin-arm64');
    helper('prebuilds', 'darwin-x64');
    const found = spawnHelperCandidates(root).map((f) => path.relative(root, f)).sort();
    expect(found).toEqual([
      'build/Debug/spawn-helper',
      'build/Release/spawn-helper',
      'prebuilds/darwin-arm64/spawn-helper',
      'prebuilds/darwin-x64/spawn-helper',
    ]);
  });

  it('copes with a node-pty that has no prebuilds folder', () => {
    expect(spawnHelperCandidates(root).map((f) => path.relative(root, f)).sort()).toEqual([
      'build/Debug/spawn-helper',
      'build/Release/spawn-helper',
    ]);
  });
});

describe('ensureSpawnHelperExecutable', () => {
  it('makes a helper that npm left at 0644 executable', () => {
    const file = helper('prebuilds', 'darwin-arm64');
    chmodSync(file, 0o644);
    const result = ensureSpawnHelperExecutable({ ptyRoot: root, platform: 'darwin' });
    expect(result.fixed).toEqual([file]);
    expect(result.failed).toEqual([]);
    expect(mode(file) & 0o111).toBe(0o111);
  });

  it('leaves an executable helper alone', () => {
    const file = helper('build', 'Release');
    chmodSync(file, 0o755);
    const result = ensureSpawnHelperExecutable({ ptyRoot: root, platform: 'linux' });
    expect(result).toEqual({ fixed: [], failed: [] });
    expect(mode(file)).toBe(0o755);
  });

  it('reports a helper it cannot change instead of throwing', () => {
    const file = helper('prebuilds', 'linux-x64');
    chmodSync(file, 0o644);
    const result = ensureSpawnHelperExecutable({
      ptyRoot: root,
      platform: 'linux',
      chmod: () => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
    });
    expect(result.fixed).toEqual([]);
    expect(result.failed).toEqual([{ file, error: 'operation not permitted' }]);
  });

  it('does nothing on Windows, where node-pty has no spawn-helper', () => {
    const file = helper('prebuilds', 'win32-x64');
    chmodSync(file, 0o644);
    expect(ensureSpawnHelperExecutable({ ptyRoot: root, platform: 'win32' })).toEqual({ fixed: [], failed: [] });
    expect(mode(file)).toBe(0o644);
  });

  it('does nothing when node-pty cannot be found', () => {
    expect(ensureSpawnHelperExecutable({ ptyRoot: null, platform: 'darwin' })).toEqual({ fixed: [], failed: [] });
  });
});
