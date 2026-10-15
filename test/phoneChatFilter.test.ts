// phoneChatFilter.test.ts — a paired phone reads a shared session's chat and edits, but never the
// content of a secret file the agent touched (AASC-41 / AASC-44, the rule AASC-28 set for files).
import { describe, it, expect } from 'vitest';
import { filterPhoneChangesAnswer, phoneCallRedaction } from '../server/mobile/phoneChatFilter.js';
import { pathLooksSecret } from '../server/mobile/secretPaths.js';


describe('pathLooksSecret', () => {
  it.each([
    '/Users/me/app/.env', '/Users/me/app/.env.local', 'config/credentials.json', '/Users/me/.ssh/config',
    '/Users/me/.aws/credentials', 'certs/server.pem', '~/.ssh/id_ed25519', 'C:\\Users\\me\\.ssh\\id_rsa',
    '/Users/me/.codex/auth.json', '/Users/me/.config/gh/hosts.yml',
  ])('treats %s as secret', (p) => expect(pathLooksSecret(p)).toBe(true));

  it.each(['/Users/me/app/src/env.ts', 'README.md', '/Users/me/library-app/index.ts', 'docs/keys-guide.md'])(
    'lets %s through', (p) => expect(pathLooksSecret(p)).toBe(false));
});

describe('phoneCallRedaction', () => {
  it('hides what a Read of a secret file returned, keeping which file it was', () => {
    expect(phoneCallRedaction({ file_path: '/Users/me/app/.env' })).toEqual({ input: { file_path: '/Users/me/app/.env', redacted: true } });
  });

  it('hides the content of an edit or a write to a secret file', () => {
    expect(phoneCallRedaction({ file_path: 'creds/server.key', old_string: 'a', new_string: 'SECRET' }))
      .toEqual({ input: { file_path: 'creds/server.key', redacted: true } });
    expect(phoneCallRedaction({ file_path: '/Users/me/.ssh/config', content: 'Host x' }))
      .toEqual({ input: { file_path: '/Users/me/.ssh/config', redacted: true } });
  });

  it('hides what a shell command printed when it names a secret file, but keeps the command', () => {
    expect(phoneCallRedaction({ command: 'cat .env | grep KEY' })).toEqual({});
    expect(phoneCallRedaction({ command: ['bash', '-lc', 'cat ~/.aws/credentials'] })).toEqual({});
  });

  it('reads Codex’s cmd and action.command, script code and any other argument', () => {
    expect(phoneCallRedaction({ cmd: 'cat .env', workdir: '/p' })).toEqual({});
    expect(phoneCallRedaction({ type: 'exec', command: ['bash', '-lc', 'cat ~/.ssh/config'] })).toEqual({});
    expect(phoneCallRedaction('const r = await tools.exec_command({ cmd: "grep KEY .env.local" });')).toEqual({});
    expect(phoneCallRedaction({ code: 'await fs.readFile("config/credentials.json")', title: 'Read' })).toEqual({});
    expect(phoneCallRedaction({ server: 'fs', arguments: { target: { file: '/Users/me/.aws/credentials' } } })).toEqual({});
  });

  it('hides a Codex patch that touches a secret file, in any form', () => {
    expect(phoneCallRedaction({ changes: { '/Users/me/app/.env': { add: 'X=1' }, '/Users/me/app/a.ts': { add: 'y' } } }))
      .toEqual({ input: { redacted: true, paths: ['/Users/me/app/.env', '/Users/me/app/a.ts'] } });
    expect(phoneCallRedaction('*** Begin Patch\n*** Update File: config/credentials.json\n+token\n*** End Patch'))
      .toEqual({ input: { redacted: true, paths: ['config/credentials.json'] } });
    // A patch written inside an exec script, its newlines as \n escapes.
    expect(phoneCallRedaction('await tools.apply_patch("*** Begin Patch\\n*** Add File: /p/.env\\n+S=1\\n*** End Patch");'))
      .toEqual({ input: { redacted: true, paths: ['/p/.env'] } });
  });

  it('leaves ordinary tool calls alone', () => {
    expect(phoneCallRedaction({ file_path: 'src/app.ts' })).toBeNull();
    expect(phoneCallRedaction({ command: 'npm test -- src/env.test.ts' })).toBeNull();
    expect(phoneCallRedaction('*** Begin Patch\n*** Update File: src/a.ts\n+x\n*** End Patch')).toBeNull();
    expect(phoneCallRedaction(undefined)).toBeNull();
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
