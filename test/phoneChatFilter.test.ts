// phoneChatFilter.test.ts — a paired phone reads a shared session's chat and edits, but never the
// content of a secret file the agent touched (AASC-41 / AASC-44, the rule AASC-28 set for files).
import { describe, it, expect } from 'vitest';
import { filterPhoneChatAnswer, filterPhoneChangesAnswer } from '../server/mobile/phoneChatFilter.js';
import { pathLooksSecret } from '../server/mobile/secretPaths.js';

const HIDDEN = '[Hidden on phones: this touched a secret file]';

function chat(entries: unknown[]): unknown {
  return { success: true, data: { entries, before: 'b', after: 'a', cli: 'claude', hasMore: false } };
}
const entriesOf = (body: unknown) => (body as { data: { entries: Array<Record<string, unknown>> } }).data.entries;

describe('pathLooksSecret', () => {
  it.each([
    '/Users/me/app/.env', '/Users/me/app/.env.local', 'config/credentials.json', '/Users/me/.ssh/config',
    '/Users/me/.aws/credentials', 'certs/server.pem', '~/.ssh/id_ed25519', 'C:\\Users\\me\\.ssh\\id_rsa',
    '/Users/me/.codex/auth.json', '/Users/me/.config/gh/hosts.yml',
  ])('treats %s as secret', (p) => expect(pathLooksSecret(p)).toBe(true));

  it.each(['/Users/me/app/src/env.ts', 'README.md', '/Users/me/library-app/index.ts', 'docs/keys-guide.md'])(
    'lets %s through', (p) => expect(pathLooksSecret(p)).toBe(false));
});

// Entries as the chat's page reader marks them (server/chat/secretMarks.ts): the filter hides by the marks.
describe('filterPhoneChatAnswer', () => {
  it('hides what a Read of a secret file returned, keeping which file it was', () => {
    const out = entriesOf(filterPhoneChatAnswer(chat([
      { kind: 'tool_use', key: '1:0', timestamp: 1, id: 't1', name: 'Read', input: { file_path: '/Users/me/app/.env' }, secret: true, secretInput: true, editPaths: ['/Users/me/app/.env'] },
      { kind: 'tool_result', key: '2:0', timestamp: 2, toolUseId: 't1', isError: false, output: 'API_KEY=sk-123', truncated: false, secret: true },
    ])));
    expect(out[0].input).toEqual({ file_path: '/Users/me/app/.env', redacted: true });
    expect(out[1]).toMatchObject({ output: HIDDEN, truncated: false });
  });

  it('hides the content of an edit or a write to a secret file', () => {
    const out = entriesOf(filterPhoneChatAnswer(chat([
      { kind: 'tool_use', key: '1:0', timestamp: 1, id: 't1', name: 'Edit', input: { file_path: 'creds/server.key', old_string: 'a', new_string: 'SECRET' }, secret: true, secretInput: true, editPaths: ['creds/server.key'] },
      { kind: 'tool_use', key: '2:0', timestamp: 2, id: 't2', name: 'Write', input: { file_path: '/Users/me/.ssh/config', content: 'Host x' }, inputTruncated: true, secret: true, secretInput: true, editPaths: ['/Users/me/.ssh/config'] },
    ])));
    expect(out[0].input).toEqual({ file_path: 'creds/server.key', redacted: true });
    expect(out[1].input).toEqual({ file_path: '/Users/me/.ssh/config', redacted: true });
    expect(out[1]).not.toHaveProperty('inputTruncated');
  });

  it('hides what a shell command printed when it names a secret file, but keeps the command', () => {
    const out = entriesOf(filterPhoneChatAnswer(chat([
      { kind: 'tool_use', key: '1:0', timestamp: 1, id: 't1', name: 'Bash', input: { command: 'cat .env | grep KEY' }, secret: true },
      { kind: 'tool_result', key: '2:0', timestamp: 2, toolUseId: 't1', isError: false, output: 'KEY=abc', truncated: false, secret: true },
      { kind: 'tool_use', key: '3:0', timestamp: 3, id: 't2', name: 'exec_command', input: { cmd: 'cat ~/.aws/credentials' }, secret: true },
      { kind: 'tool_result', key: '4:0', timestamp: 4, toolUseId: 't2', isError: false, output: 'aws_secret=1', truncated: false, secret: true },
    ])));
    expect(out[0].input).toEqual({ command: 'cat .env | grep KEY' });
    expect(out[1].output).toBe(HIDDEN);
    expect(out[2].input).toEqual({ cmd: 'cat ~/.aws/credentials' });
    expect(out[3].output).toBe(HIDDEN);
  });

  it('hides a Codex patch that touches a secret file, in either form', () => {
    const out = entriesOf(filterPhoneChatAnswer(chat([
      { kind: 'tool_use', key: '1:0', timestamp: 1, id: 'c1', name: 'apply_patch', input: { changes: { '/Users/me/app/.env': { add: 'X=1' }, '/Users/me/app/a.ts': { add: 'y' } } }, secret: true, secretInput: true, editPaths: ['/Users/me/app/.env', '/Users/me/app/a.ts'] },
      { kind: 'tool_use', key: '2:0', timestamp: 2, id: 'c2', name: 'exec', input: 'await tools.apply_patch("*** Begin Patch\\n*** Update File: config/credentials.json…', inputTruncated: true, secret: true, secretInput: true, editPaths: ['config/credentials.json'] },
    ])));
    expect(out[0].input).toEqual({ redacted: true, paths: ['/Users/me/app/.env', '/Users/me/app/a.ts'] });
    expect(out[1].input).toEqual({ redacted: true, paths: ['config/credentials.json'] });
  });

  it('hides a result whose call the reader couldn’t find (fail closed)', () => {
    const out = entriesOf(filterPhoneChatAnswer(chat([
      { kind: 'tool_result', key: '2:0', timestamp: 2, toolUseId: 'gone', isError: false, output: 'who knows', truncated: false, callUnknown: true },
    ])));
    expect(out[0]).toMatchObject({ output: HIDDEN, truncated: false });
  });

  it('leaves unmarked tool calls, prose and other answers alone', () => {
    const entries = [
      { kind: 'user', key: '0:0', timestamp: 0, text: 'fix the build, see .env' },
      { kind: 'tool_use', key: '1:0', timestamp: 1, id: 't1', name: 'Read', input: { file_path: 'src/app.ts' } },
      { kind: 'tool_result', key: '2:0', timestamp: 2, toolUseId: 't1', isError: false, output: 'export {}', truncated: false },
    ];
    expect(entriesOf(filterPhoneChatAnswer(chat(entries)))).toEqual(entries);
    expect(filterPhoneChatAnswer({ success: false, error: 'x' })).toEqual({ success: false, error: 'x' });
  });
});

describe('filterPhoneChangesAnswer', () => {
  it('keeps a secret file in the list, so indexes still line up, but marks it and drops its hunks', () => {
    const list = filterPhoneChangesAnswer({ success: true, data: { files: [
      { path: 'src/a.ts', added: 1, removed: 0, lastAt: 2 },
      { path: '.env', added: 3, removed: 1, lastAt: 1 },
    ], total: { added: 4, removed: 1 }, cli: 'claude' } }) as { data: { files: Array<Record<string, unknown>> } };
    expect(list.data.files[0]).toEqual({ path: 'src/a.ts', added: 1, removed: 0, lastAt: 2 });
    expect(list.data.files[1]).toEqual({ path: '.env', added: 3, removed: 1, lastAt: 1, redacted: true });

    const one = filterPhoneChangesAnswer({ success: true, data: { path: '.env', added: 3, removed: 1, lastAt: 1, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-A=1', '+A=2'] }] } }) as { data: Record<string, unknown> };
    expect(one.data).toMatchObject({ path: '.env', hunks: [], redacted: true });
  });
});
