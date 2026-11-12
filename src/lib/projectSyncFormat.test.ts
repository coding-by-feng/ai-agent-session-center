import { describe, expect, it } from 'vitest';
import { actionLabel } from './projectSyncFormat';

const file = { kind: 'file' as const, size: 1, mtimeMs: 1, mode: 0o644 };

describe('actionLabel', () => {
  it('words keep by what the server holds: a copy, or nothing since it deleted the file', () => {
    expect(actionLabel({ change: 'drift', device: file }, 'keep')).toBe('Keep the server copy');
    expect(actionLabel({ change: 'drift' }, 'keep')).toBe('Leave it deleted on the server');
  });

  it('words a choice between two versions by side, and a plain copy by where it goes', () => {
    expect(actionLabel({ change: 'conflict', device: file }, 'push')).toBe('Keep this computer’s');
    expect(actionLabel({ change: 'conflict', device: file }, 'pull')).toBe('Keep the server’s');
    expect(actionLabel({ change: 'add' }, 'push')).toBe('Copy to the server');
    expect(actionLabel({ change: 'extra', device: file }, 'pull')).toBe('Copy here');
  });
});
