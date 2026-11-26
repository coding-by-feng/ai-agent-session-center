// diskUsage.test.ts — how the disk chip reads a disk (Nov 26 2026).
import { describe, it, expect } from 'vitest';
import { diskTone, formatBytes, parseDiskReply, usedPercent } from './diskUsage';

const GB = 1024 ** 3;

describe('diskTone', () => {
  it('is ok with room to spare', () => {
    expect(diskTone(200 * GB, 500 * GB)).toBe('ok');
  });
  it('is low under 20 GB or under 10% free', () => {
    expect(diskTone(19 * GB, 100 * GB)).toBe('low');
    expect(diskTone(150 * GB, 2000 * GB)).toBe('low');
    expect(diskTone(20 * GB, 100 * GB)).toBe('ok');
  });
  it('is critical under 5 GB or under 5% free', () => {
    expect(diskTone(3.8 * GB, 494 * GB)).toBe('critical');
    expect(diskTone(90 * GB, 2000 * GB)).toBe('critical');
    expect(diskTone(5 * GB, 60 * GB)).toBe('low');
  });
  it('treats an unknown total as no ratio', () => {
    expect(diskTone(50 * GB, 0)).toBe('ok');
  });
});

describe('formatBytes', () => {
  it('keeps one decimal under 10 and whole numbers above', () => {
    expect(formatBytes(3.8 * GB)).toBe('3.8 GB');
    expect(formatBytes(4 * GB)).toBe('4 GB');
    expect(formatBytes(182.4 * GB)).toBe('182 GB');
    expect(formatBytes(1.2 * 1024 * GB)).toBe('1.2 TB');
    expect(formatBytes(640 * 1024 ** 2)).toBe('640 MB');
    expect(formatBytes(0)).toBe('0 B');
  });
});

describe('usedPercent', () => {
  it('rounds to a whole percent', () => {
    expect(usedPercent(3.8 * GB, 494 * GB)).toBe(99);
    expect(usedPercent(0, 0)).toBe(0);
  });
});

describe('parseDiskReply', () => {
  it('takes a well-formed reading', () => {
    expect(parseDiskReply({ ok: true, freeBytes: 1, totalBytes: 2, path: '/x' })).toEqual({ freeBytes: 1, totalBytes: 2, path: '/x' });
  });
  it('refuses anything else', () => {
    for (const body of [null, 'x', { ok: false }, { ok: true, freeBytes: '1', totalBytes: 2, path: '/x' }, { ok: true, freeBytes: 1, totalBytes: 0, path: '/x' }, { ok: true, freeBytes: 1, totalBytes: Infinity, path: '/x' }]) {
      expect(parseDiskReply(body)).toBeNull();
    }
  });
});
