import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  linkSync,
  mkdirSync,
  rmSync,
  realpathSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createFileTrialStore } = require('../bin/trial/file-store.cjs');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function temp() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'aasc-trial-storage-'));
  dirs.push(dir);
  return dir;
}
const privateState = {
  version: 1,
  cookie: '__Host-aasc_trial=private-cookie',
  pending: { requestKey: 'request-1', prompt: '解释闭包' },
};

describe('CLI trial private storage', () => {
  it('durably round trips pending identity with private permissions and no transcript', () => {
    const filePath = join(temp(), 'aasc', 'trial.json');
    const store = createFileTrialStore({ filePath });
    expect(() => store.save(privateState)).toThrow();
    const release = store.acquireLock();
    try {
      expect(store.load()).toBeNull();
      store.save(privateState);
      expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(privateState);
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(statSync(join(filePath, '..')).mode & 0o777).toBe(0o700);
      expect(store.load()).toEqual(privateState);
      expect(readdirSync(join(filePath, '..')).filter((name) => name.includes('.tmp'))).toEqual([]);
      store.save(null);
      expect(store.load()).toBeNull();
    } finally {
      release();
    }
    expect(readdirSync(join(filePath, '..'))).toEqual([]);
  });
  it('refuses symlinked parents, credentials and locks without modifying the target', () => {
    const dir = temp();
    const target = join(dir, 'target');
    mkdirSync(target);
    const alias = join(dir, 'alias');
    symlinkSync(target, alias, 'dir');
    expect(() => createFileTrialStore({ filePath: join(alias, 'trial.json') })).toThrow();
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'do-not-change', { mode: 0o600 });
    const filePath = join(target, 'trial.json');
    symlinkSync(victim, filePath);
    const store = createFileTrialStore({ filePath });
    const release = store.acquireLock();
    expect(() => store.load()).toThrow();
    expect(() => store.save(privateState)).toThrow();
    release();
    expect(readFileSync(victim, 'utf8')).toBe('do-not-change');
    rmSync(filePath);
    symlinkSync(victim, `${filePath}.lock`);
    expect(() => store.acquireLock()).toThrow();
    expect(readFileSync(victim, 'utf8')).toBe('do-not-change');
  });
  it('refuses hardlinked credentials and oversized files', () => {
    const dir = temp();
    const filePath = join(dir, 'trial.json');
    const other = join(dir, 'other');
    writeFileSync(other, JSON.stringify(privateState), { mode: 0o600 });
    linkSync(other, filePath);
    const store = createFileTrialStore({ filePath });
    const release = store.acquireLock();
    expect(() => store.load()).toThrow();
    expect(() => store.save(privateState)).toThrow();
    rmSync(filePath);
    writeFileSync(filePath, 'x'.repeat(16385), { mode: 0o600 });
    expect(() => store.load()).toThrow();
    release();
  });
  it('serializes independent CLI processes and recovers a lock after its owner exits abruptly', async () => {
    const filePath = join(temp(), 'trial.json');
    const modulePath = require.resolve('../bin/trial/file-store.cjs');
    const child = spawn(
      process.execPath,
      [
        '-e',
        'const s=require(process.argv[1]).createFileTrialStore({filePath:process.argv[2]});s.acquireLock();process.stdout.write("locked");setInterval(()=>{},1000)',
        modulePath,
        filePath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      await once(child.stdout, 'data');
      const store = createFileTrialStore({ filePath });
      expect(() => store.acquireLock()).toThrow();
      child.kill('SIGKILL');
      await once(child, 'exit');
      const release = store.acquireLock();
      store.save(privateState);
      expect(store.load()).toEqual(privateState);
      release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
