// test/sshManager.pendingLinks.test.ts — RC-5 fix verification.
// Verifies that the sshManager's `pendingLinks` storage holds multiple PendingLink
// entries per workDir, and that tryLinkByWorkDir/consumePendingLink behave FIFO.
//
// Background: prior to RC-5, pendingLinks was a Map<string, PendingLink>, which
// meant registering more than one terminal for the same working directory caused
// the second registration to overwrite the first. During workspace import this
// collapsed multiple sessions sharing a project path onto a single card.
//
// We use the internal test hooks (`__resetPendingLinksForTest`,
// `__addPendingLinkForTest`) to register pending links without spawning real
// PTYs. These helpers are only exposed for tests and have no effect in
// production code paths.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  tryLinkByWorkDir,
  consumePendingLink,
  __addPendingLinkForTest,
  __resetPendingLinksForTest,
  __getPendingLinksSizeForTest,
  __getPendingLinksForWorkDirForTest,
} from '../server/sshManager.js';

describe('sshManager.pendingLinks — FIFO array per workDir (RC-5 fix)', () => {
  beforeEach(() => {
    __resetPendingLinksForTest();
  });

  it('stores multiple pending links for the same workDir', () => {
    const workDir = '/tmp/multi-pending';
    __addPendingLinkForTest(workDir, { terminalId: 'term-A', host: 'localhost', createdAt: Date.now() });
    __addPendingLinkForTest(workDir, { terminalId: 'term-B', host: 'localhost', createdAt: Date.now() });
    __addPendingLinkForTest(workDir, { terminalId: 'term-C', host: 'localhost', createdAt: Date.now() });

    const links = __getPendingLinksForWorkDirForTest(workDir);
    expect(links).toHaveLength(3);
    expect(links?.map(l => l.terminalId)).toEqual(['term-A', 'term-B', 'term-C']);
  });

  it('tryLinkByWorkDir consumes the FIRST entry (FIFO) and leaves the rest', () => {
    const workDir = '/tmp/fifo-test';
    __addPendingLinkForTest(workDir, { terminalId: 'term-1', host: 'localhost', createdAt: Date.now() });
    __addPendingLinkForTest(workDir, { terminalId: 'term-2', host: 'localhost', createdAt: Date.now() });
    __addPendingLinkForTest(workDir, { terminalId: 'term-3', host: 'localhost', createdAt: Date.now() });

    const first = tryLinkByWorkDir(workDir, 'sess-1');
    expect(first).toBe('term-1');

    const remaining = __getPendingLinksForWorkDirForTest(workDir);
    expect(remaining).toHaveLength(2);
    expect(remaining?.map(l => l.terminalId)).toEqual(['term-2', 'term-3']);

    const second = tryLinkByWorkDir(workDir, 'sess-2');
    expect(second).toBe('term-2');
    const third = tryLinkByWorkDir(workDir, 'sess-3');
    expect(third).toBe('term-3');

    // Map key should be deleted once the array is empty
    expect(__getPendingLinksForWorkDirForTest(workDir)).toBeUndefined();
    expect(__getPendingLinksSizeForTest()).toBe(0);
  });

  it('returns null when no pending links exist for the workDir', () => {
    expect(tryLinkByWorkDir('/tmp/no-such-dir', 'sess-x')).toBeNull();
  });

  it('matches workDir with trailing slash variant', () => {
    __addPendingLinkForTest('/tmp/slash-test', { terminalId: 'term-S', host: 'localhost', createdAt: Date.now() });

    const result = tryLinkByWorkDir('/tmp/slash-test/', 'sess-S');
    expect(result).toBe('term-S');
    expect(__getPendingLinksSizeForTest()).toBe(0);
  });

  it('consumePendingLink by terminalId removes the matching entry, keeps siblings', () => {
    const workDir = '/tmp/consume-test';
    __addPendingLinkForTest(workDir, { terminalId: 'term-X', host: 'localhost', createdAt: Date.now() });
    __addPendingLinkForTest(workDir, { terminalId: 'term-Y', host: 'localhost', createdAt: Date.now() });
    __addPendingLinkForTest(workDir, { terminalId: 'term-Z', host: 'localhost', createdAt: Date.now() });

    consumePendingLink(workDir);
    // Default consumePendingLink (by workDir, no terminalId) should remove the front entry
    const remaining = __getPendingLinksForWorkDirForTest(workDir);
    expect(remaining).toHaveLength(2);
    expect(remaining?.map(l => l.terminalId)).toEqual(['term-Y', 'term-Z']);
  });

  it('consumePendingLink with terminalId removes only that specific entry', () => {
    const workDir = '/tmp/specific-consume';
    __addPendingLinkForTest(workDir, { terminalId: 'term-Q', host: 'localhost', createdAt: Date.now() });
    __addPendingLinkForTest(workDir, { terminalId: 'term-R', host: 'localhost', createdAt: Date.now() });
    __addPendingLinkForTest(workDir, { terminalId: 'term-S', host: 'localhost', createdAt: Date.now() });

    consumePendingLink(workDir, 'term-R');
    const remaining = __getPendingLinksForWorkDirForTest(workDir);
    expect(remaining).toHaveLength(2);
    expect(remaining?.map(l => l.terminalId)).toEqual(['term-Q', 'term-S']);
  });

  it('removes the map key when last entry is consumed by terminalId', () => {
    const workDir = '/tmp/last-entry';
    __addPendingLinkForTest(workDir, { terminalId: 'term-only', host: 'localhost', createdAt: Date.now() });

    consumePendingLink(workDir, 'term-only');
    expect(__getPendingLinksForWorkDirForTest(workDir)).toBeUndefined();
    expect(__getPendingLinksSizeForTest()).toBe(0);
  });

  it('isolates entries across distinct workDirs', () => {
    __addPendingLinkForTest('/tmp/dir-A', { terminalId: 'term-A1', host: 'localhost', createdAt: Date.now() });
    __addPendingLinkForTest('/tmp/dir-A', { terminalId: 'term-A2', host: 'localhost', createdAt: Date.now() });
    __addPendingLinkForTest('/tmp/dir-B', { terminalId: 'term-B1', host: 'localhost', createdAt: Date.now() });

    expect(tryLinkByWorkDir('/tmp/dir-A', 'sess-A')).toBe('term-A1');
    expect(tryLinkByWorkDir('/tmp/dir-B', 'sess-B')).toBe('term-B1');
    expect(__getPendingLinksForWorkDirForTest('/tmp/dir-A')?.map(l => l.terminalId)).toEqual(['term-A2']);
    expect(__getPendingLinksForWorkDirForTest('/tmp/dir-B')).toBeUndefined();
  });
});
