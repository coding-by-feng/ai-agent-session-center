// test/sessionChanges.test.ts — AASC-44: what a session edited, built from the edit calls in its own transcript.
// Synthetic Claude transcripts and Codex rollouts in a temp dir; no file on disk other than the transcript is read
// (one test plants a real file at an edited path to prove it).
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSessionChanges } from '../server/chat/sessionChanges.js';
import { appendJsonl, claude, codex, tempDir, writeJsonl } from './chatFixtures.js';

let tmp = '';
let project = '';
let file = '';

beforeEach(() => {
  tmp = realpathSync(tempDir('aasc44-'));
  project = join(tmp, 'proj');
  mkdirSync(project, { recursive: true });
  file = join(tmp, 'transcript.jsonl');
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const p = (rel: string) => join(project, rel);
const claudeChanges = (records: unknown[]) => {
  writeJsonl(file, records);
  return buildSessionChanges({ cli: 'claude', path: file }, project);
};
const codexChanges = (records: unknown[]) => {
  writeJsonl(file, records);
  return buildSessionChanges({ cli: 'codex', path: file }, project);
};

/** A Claude tool result record carrying the CLI's own diff, as Claude Code writes it. */
function cliResult(id: string, toolUseResult: Record<string, unknown>) {
  return claude.user([claude.toolResult(id, 'The file has been updated.')], { toolUseResult });
}

describe('Claude edits', () => {
  it('uses the CLI’s own diff when the result carries one, with real line numbers', async () => {
    const hunk = { oldStart: 40, oldLines: 3, newStart: 40, newLines: 4, lines: [' a', '-b', '+B', '+C', ' d'] };
    const { files, total } = await claudeChanges([
      claude.call('e1', 'Edit', { file_path: p('src/a.ts'), old_string: 'b', new_string: 'B\nC' }),
      cliResult('e1', { filePath: p('src/a.ts'), oldString: 'b', newString: 'B\nC', structuredPatch: [hunk], originalFile: 'x' }),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'src/a.ts', added: 2, removed: 1, hunks: [hunk] });
    expect(total).toEqual({ added: 2, removed: 1 });
  });

  it('diffs old_string → new_string when there is no CLI diff', async () => {
    const { files } = await claudeChanges([
      claude.call('e1', 'Edit', { file_path: p('a.ts'), old_string: 'one\ntwo\nthree', new_string: 'one\n2\nthree' }),
      claude.result('e1', 'ok'),
    ]);
    expect(files[0]).toMatchObject({ path: 'a.ts', added: 1, removed: 1 });
    expect(files[0].hunks).toEqual([{ oldStart: 0, oldLines: 3, newStart: 0, newLines: 3, lines: [' one', '-two', '+2', ' three'] }]);
  });

  it('counts only edits that went through: not failed or declined ones, not ones still waiting', async () => {
    const { files } = await claudeChanges([
      claude.call('e1', 'Edit', { file_path: p('a.ts'), old_string: 'x', new_string: 'y' }),
      claude.result('e1', 'String to replace not found', true),
      claude.call('e2', 'Write', { file_path: p('b.ts'), content: 'new\n' }),
    ]);
    expect(files).toEqual([]);
  });

  it('applies MultiEdit’s edits in order', async () => {
    const { files } = await claudeChanges([
      claude.call('m1', 'MultiEdit', { file_path: p('a.ts'), edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c\nd', new_string: 'c' }] }),
      claude.result('m1', 'ok'),
    ]);
    expect(files[0]).toMatchObject({ added: 1, removed: 2 });
    expect(files[0].hunks.map((h) => h.lines)).toEqual([['-a', '+b'], [' c', '-d']]);
  });

  it('shows a first Write as all added, a later one as a diff, and an unknown overwrite as replaced', async () => {
    const { files } = await claudeChanges([
      claude.call('w1', 'Write', { file_path: p('new.ts'), content: 'a\nb\n' }),
      claude.result('w1', 'File created'),
      claude.call('w2', 'Write', { file_path: p('new.ts'), content: 'a\nB\n' }),
      claude.result('w2', 'File updated'),
      claude.call('e1', 'Edit', { file_path: p('old.ts'), old_string: 'q', new_string: 'r' }),
      claude.result('e1', 'ok'),
      claude.call('w3', 'Write', { file_path: p('old.ts'), content: 'x\ny\nz\n' }),
      claude.result('w3', 'File updated'),
    ]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['new.ts']).toMatchObject({ created: true, added: 3, removed: 1 });
    expect(byPath['new.ts'].hunks).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] },
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+B'] },
    ]);
    expect(byPath['old.ts']).toMatchObject({ replaced: true, added: 4, removed: 1 });
  });

  it('uses the CLI diff of a Write over an existing file', async () => {
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] };
    const { files } = await claudeChanges([
      claude.call('w1', 'Write', { file_path: p('a.ts'), content: 'new\n' }),
      cliResult('w1', { type: 'update', filePath: p('a.ts'), content: 'new\n', structuredPatch: [hunk], originalFile: 'old\n' }),
    ]);
    expect(files[0]).toMatchObject({ added: 1, removed: 1, hunks: [hunk] });
    expect(files[0]).not.toHaveProperty('created');
  });

  it('shows a NotebookEdit at cell level', async () => {
    const { files } = await claudeChanges([
      claude.call('n1', 'NotebookEdit', { notebook_path: p('nb.ipynb'), cell_id: 'c1', new_source: 'x = 1\nprint(x)', edit_mode: 'replace' }),
      claude.result('n1', 'Updated cell'),
    ]);
    expect(files[0]).toMatchObject({ path: 'nb.ipynb', added: 2, removed: 0, replaced: true });
  });

  it('keeps paths outside the project absolute, and lists the newest edit first', async () => {
    const outside = join(tmp, 'elsewhere', 'x.md');
    const { files } = await claudeChanges([
      claude.call('a', 'Write', { file_path: p('first.ts'), content: '1\n' }),
      claude.result('a', 'ok'),
      claude.call('b', 'Write', { file_path: outside, content: '2\n' }),
      claude.result('b', 'ok'),
      claude.call('c', 'Edit', { file_path: p('first.ts'), old_string: '1', new_string: '3' }),
      claude.result('c', 'ok'),
    ]);
    expect(files.map((f) => f.path)).toEqual(['first.ts', outside]);
    expect(files[0].lastAt).toBeGreaterThan(files[1].lastAt);
  });

  it('reads nothing but the transcript, even when the edited file exists', async () => {
    writeFileSync(p('a.ts'), 'completely different content on disk\n');
    const { files } = await claudeChanges([
      claude.call('w1', 'Write', { file_path: p('a.ts'), content: 'from the transcript\n' }),
      claude.result('w1', 'ok'),
    ]);
    expect(files[0].hunks).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+from the transcript'] }]);
  });

  it('lists at most 200 files, newest first, and says when it left some out', async () => {
    const records = Array.from({ length: 205 }, (_, i) => [
      claude.call(`w${i}`, 'Write', { file_path: p(`f${i}.ts`), content: 'x\n' }),
      claude.result(`w${i}`, 'ok'),
    ]).flat();
    const changes = await claudeChanges(records);
    expect(changes.files).toHaveLength(200);
    expect(changes.truncated).toBe(true);
    expect(changes.files[0].path).toBe('f204.ts');
    expect(changes.total).toEqual({ added: 205, removed: 0 });
  });

  it('keeps at most 512 KB of hunks per file, still counting every line', async () => {
    const big = `${'y'.repeat(1000)}\n`.repeat(300); // ~300 KB a write
    const { files } = await claudeChanges([
      claude.call('w1', 'Write', { file_path: p('big.txt'), content: big }),
      claude.result('w1', 'ok'),
      claude.call('w2', 'Write', { file_path: p('big2.txt'), content: big }),
      claude.result('w2', 'ok'),
      claude.call('w3', 'Write', { file_path: p('big.txt'), content: big.replace(/y/g, 'z') }),
      claude.result('w3', 'ok'),
    ]);
    const bigFile = files.find((f) => f.path === 'big.txt');
    expect(bigFile).toMatchObject({ truncated: true, added: 600, removed: 300 });
    expect(bigFile?.hunks).toHaveLength(1);
  });

  it('picks up edits written since the last build', async () => {
    writeJsonl(file, [claude.call('w1', 'Write', { file_path: p('a.ts'), content: 'a\n' }), claude.result('w1', 'ok')]);
    expect((await buildSessionChanges({ cli: 'claude', path: file }, project)).files).toHaveLength(1);
    appendJsonl(file, [claude.call('w2', 'Write', { file_path: p('b.ts'), content: 'b\n' }), claude.result('w2', 'ok')]);
    const again = await buildSessionChanges({ cli: 'claude', path: file }, project);
    expect(again.files.map((f) => f.path)).toEqual(['b.ts', 'a.ts']);
  });

  it('starts over when the transcript was rewritten in place', async () => {
    writeJsonl(file, [claude.call('w1', 'Write', { file_path: p('a.ts'), content: 'a\n' }), claude.result('w1', 'ok')]);
    expect((await buildSessionChanges({ cli: 'claude', path: file }, project)).files).toHaveLength(1);
    // Same file (same inode), other content, longer than before.
    writeJsonl(file, [
      claude.call('x1', 'Write', { file_path: p('other.ts'), content: 'o\n' }),
      claude.result('x1', 'a longer result text than the first transcript had, so the old offset still fits'),
      claude.call('x2', 'Write', { file_path: p('third.ts'), content: 't\n' }),
      claude.result('x2', 'ok'),
    ]);
    const again = await buildSessionChanges({ cli: 'claude', path: file }, project);
    expect(again.files.map((f) => f.path)).toEqual(['third.ts', 'other.ts']);
  });
});

describe('Codex edits', () => {
  it('reads the file changes Codex reports, with the unified diff’s line numbers', async () => {
    const { files, total } = await codexChanges([
      codex.fileChange('fc1', {
        [p('src/a.ts')]: { type: 'update', unified_diff: '@@ -10,2 +10,3 @@\n keep\n-old\n+new\n+more\n', move_path: null },
        [p('docs/new.md')]: { type: 'add', content: '# New\n\nText\n' },
      }),
      codex.fileChange('fc2', { [p('gone.txt')]: { type: 'delete', content: 'a\nb\n' } }),
      codex.fileChange('fc3', { [p('src/a.ts')]: { type: 'update', unified_diff: '@@ -1 +1 @@\n-x\n+y\n', move_path: null } }, 'failed'),
    ]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['src/a.ts']).toMatchObject({ added: 2, removed: 1 });
    expect(byPath['src/a.ts'].hunks).toEqual([{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 3, lines: [' keep', '-old', '+new', '+more'] }]);
    expect(byPath['docs/new.md']).toMatchObject({ added: 3, removed: 0, created: true });
    expect(byPath['gone.txt']).toMatchObject({ added: 0, removed: 2, deleted: true });
    expect(total).toEqual({ added: 5, removed: 3 });
  });

  it('follows a move to the new path', async () => {
    const { files } = await codexChanges([
      codex.fileChange('fc1', { [p('old/name.ts')]: { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n', move_path: p('new/name.ts') } }),
    ]);
    expect(files.map((f) => f.path)).toEqual(['new/name.ts']);
  });

  it('parses an apply_patch call that succeeded, and skips one that failed', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+export const a = 1;',
      '+export const b = 2;',
      '*** Update File: src/old.ts',
      '*** Move to: src/renamed.ts',
      '@@ function f',
      ' keep',
      '-drop',
      '+add',
      '*** End of File',
      '*** Delete File: src/dead.ts',
      '*** End Patch',
    ].join('\n');
    const { files } = await codexChanges([
      codex.customCall('p1', 'apply_patch', patch),
      codex.customOutput('p1', JSON.stringify({ output: 'Success. Updated the following files:\nA src/new.ts', metadata: { exit_code: 0 } })),
      codex.customCall('p2', 'apply_patch', '*** Begin Patch\n*** Add File: src/never.ts\n+x\n*** End Patch'),
      codex.customOutput('p2', JSON.stringify({ output: 'apply_patch verification failed', metadata: { exit_code: 1 } })),
    ]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['src/dead.ts', 'src/new.ts', 'src/renamed.ts']);
    expect(byPath['src/new.ts']).toMatchObject({ added: 2, removed: 0, created: true });
    expect(byPath['src/renamed.ts']).toMatchObject({ added: 1, removed: 1 });
    expect(byPath['src/renamed.ts'].hunks).toEqual([{ oldStart: 0, oldLines: 2, newStart: 0, newLines: 2, lines: [' keep', '-drop', '+add'] }]);
    expect(byPath['src/dead.ts']).toMatchObject({ deleted: true });
  });

  it('reads a patch passed to the shell tool', async () => {
    const { files } = await codexChanges([
      codex.functionCall('s1', 'shell', { command: ['apply_patch', '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\n'] }),
      codex.functionOutput('s1', JSON.stringify({ output: 'Done!', metadata: { exit_code: 0 } })),
    ]);
    expect(files).toMatchObject([{ path: 'a.txt', added: 1 }]);
  });

  it('counts an edit once when a rollout has both the patch call and the file change, from the file change', async () => {
    const { files, total } = await codexChanges([
      codex.customCall('p1', 'apply_patch', '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch'),
      codex.customOutput('p1', 'Success.'),
      // Codex's record of what happened is the file change (here it says two lines landed).
      codex.fileChange('fc1', { [p('a.txt')]: { type: 'add', content: 'hi\nthere\n' } }),
    ]);
    expect(files).toMatchObject([{ path: 'a.txt', added: 2 }]);
    expect(total).toEqual({ added: 2, removed: 0 });
  });
});
