// editDiff.test.ts — the inline diff a chat edit row expands to (AASC-41): Claude's
// Edit / MultiEdit / Write / NotebookEdit inputs and Codex's apply_patch (patch text
// or FileChange map), each as per-file hunks with counts; redacted inputs show no lines.
import { describe, it, expect } from 'vitest';
import { editFiles, editTotals, isEditTool, parseApplyPatch } from './editDiff';

describe('editFiles', () => {
  it('diffs an Edit’s old and new text, position unknown', () => {
    const [file] = editFiles('Edit', {
      file_path: '/p/src/ui/icons.tsx',
      old_string: 'a\n<rect y="10.5" />\nc',
      new_string: 'a\n<rect y="7" />\nc',
    });
    expect(file.path).toBe('/p/src/ui/icons.tsx');
    expect(file.added).toBe(1);
    expect(file.removed).toBe(1);
    expect(file.positionKnown).toBe(false);
    expect(file.hunks[0].lines).toEqual([' a', '-<rect y="10.5" />', '+<rect y="7" />', ' c']);
  });

  it('applies a MultiEdit’s edits as one hunk each', () => {
    const [file] = editFiles('MultiEdit', {
      file_path: 'x.ts',
      edits: [{ old_string: 'one', new_string: 'uno' }, { old_string: 'two', new_string: 'dos\ntres' }],
    });
    expect(file.hunks).toHaveLength(2);
    expect(file.added).toBe(3);
    expect(file.removed).toBe(2);
  });

  it('shows a Write as all lines added', () => {
    const [file] = editFiles('Write', { file_path: 'new.md', content: '# Title\n\nBody\n' });
    expect(file.added).toBe(3);
    expect(file.removed).toBe(0);
    expect(file.hunks[0].lines).toEqual(['+# Title', '+', '+Body']);
  });

  it('reads a NotebookEdit’s new source', () => {
    const [file] = editFiles('NotebookEdit', { notebook_path: 'a.ipynb', new_source: 'print(1)\nprint(2)' });
    expect(file.path).toBe('a.ipynb');
    expect(file.added).toBe(2);
  });

  it('parses a Codex apply_patch text into files', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@ function a',
      ' keep',
      '-old',
      '+new',
      '*** Add File: src/b.ts',
      '+export const b = 1;',
      '*** Delete File: src/c.ts',
      '*** End Patch',
    ].join('\n');
    const files = editFiles('apply_patch', patch);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([['src/a.ts', 1, 1], ['src/b.ts', 1, 0], ['src/c.ts', 0, 0]]);
    expect(files[1].created).toBe(true);
    expect(files[2].deleted).toBe(true);
    expect(editTotals(files)).toEqual({ added: 2, removed: 1 });
  });

  it('reads a Codex FileChange map (unified diff, add, delete, move)', () => {
    const files = editFiles('apply_patch', {
      changes: {
        'src/a.ts': { type: 'update', unified_diff: '@@ -3,2 +3,2 @@\n ctx\n-old\n+new\n', move_path: 'src/a2.ts' },
        'src/n.ts': { type: 'add', content: 'x\ny\n' },
        'src/d.ts': { type: 'delete', content: 'gone\n' },
      },
    });
    expect(files[0]).toMatchObject({ path: 'src/a2.ts', added: 1, removed: 1, positionKnown: true });
    expect(files[0].hunks[0].oldStart).toBe(3);
    expect(files[1]).toMatchObject({ path: 'src/n.ts', added: 2, created: true });
    expect(files[2]).toMatchObject({ path: 'src/d.ts', removed: 1, deleted: true });
  });

  it('treats an old Codex shell apply_patch the same', () => {
    const files = editFiles('apply_patch', '*** Begin Patch\n*** Update File: z.py\n@@\n-a\n+b\n*** End Patch');
    expect(files[0].path).toBe('z.py');
  });

  it('shows a redacted edit by its path only', () => {
    expect(editFiles('Edit', { file_path: '.env', redacted: true })).toEqual([
      { path: '.env', hunks: [], added: 0, removed: 0, positionKnown: false, redacted: true },
    ]);
    const patch = editFiles('apply_patch', { redacted: true, paths: ['.env', 'config/secrets.yml'] });
    expect(patch.map((f) => [f.path, f.redacted])).toEqual([['.env', true], ['config/secrets.yml', true]]);
  });

  it('returns nothing for a tool that is not an edit or an input it can’t read', () => {
    expect(editFiles('Read', { file_path: 'a' })).toEqual([]);
    expect(editFiles('Edit', 'cut json')).toEqual([]);
    expect(isEditTool('Write')).toBe(true);
    expect(isEditTool('Bash')).toBe(false);
  });

  it('shows two very different texts as a rewrite instead of diffing them for long', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `old line ${i}`).join('\n');
    const after = Array.from({ length: 3000 }, (_, i) => `brand new ${i * 7}`).join('\n');
    const [file] = editFiles('Edit', { file_path: 'big.txt', old_string: before, new_string: after });
    expect(file.removed).toBe(3000);
    expect(file.added).toBe(3000);
  });

  it('returns the same result for the same input object (no second diff)', () => {
    const input = { file_path: 'a', old_string: 'x', new_string: 'y' };
    expect(editFiles('Edit', input)).toBe(editFiles('Edit', input));
  });
});

describe('parseApplyPatch', () => {
  it('keeps blank context lines inside an update and a move', () => {
    const ops = parseApplyPatch('*** Begin Patch\n*** Update File: a\n*** Move to: b\n@@\n x\n\n-y\n+z\n*** End Patch');
    expect(ops[0].movePath).toBe('b');
    expect(ops[0].hunks[0].lines).toEqual([' x', ' ', '-y', '+z']);
  });
});
