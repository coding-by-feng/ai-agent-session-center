// test/chatSecretCalls.test.ts — AASC-41: which tool calls touch a secret file (server/mobile/secretPaths.ts),
// judged on the call's raw input: Claude's file_path / path / notebook_path and Bash command, Codex's cmd,
// action.command, exec / js code and patches in any form.
import { describe, it, expect } from 'vitest';
import { secretTouch } from '../server/chat/secretCalls.js';

describe('secretTouch', () => {
  it('a Read, Edit or Write of a secret file carries its content', () => {
    expect(secretTouch({ file_path: '/Users/me/app/.env' })).toEqual({ content: true, paths: ['/Users/me/app/.env'] });
    expect(secretTouch({ file_path: 'creds/server.key', old_string: 'a', new_string: 'SECRET' })).toEqual({ content: true, paths: ['creds/server.key'] });
    expect(secretTouch({ notebook_path: '/Users/me/.aws/notes.ipynb', new_source: 'x' })).toEqual({ content: true, paths: ['/Users/me/.aws/notes.ipynb'] });
    expect(secretTouch({ path: '/Users/me/.ssh', pattern: 'Host' })).toEqual({ content: true, paths: ['/Users/me/.ssh'] });
  });

  it('a command that names a secret file touches it, without its input carrying the content', () => {
    expect(secretTouch({ command: 'cat .env | grep KEY' })).toEqual({ content: false, paths: [] });
    expect(secretTouch({ command: ['bash', '-lc', 'cat ~/.aws/credentials'] })).toEqual({ content: false, paths: [] });
  });

  it('reads Codex’s cmd and action.command, script code and any other argument', () => {
    expect(secretTouch({ cmd: 'cat .env', workdir: '/p' })).toEqual({ content: false, paths: [] });
    expect(secretTouch({ type: 'exec', command: ['bash', '-lc', 'cat ~/.ssh/config'] })).toEqual({ content: false, paths: [] });
    expect(secretTouch('const r = await tools.exec_command({ cmd: "grep KEY .env.local" });')).toEqual({ content: false, paths: [] });
    expect(secretTouch({ code: 'await fs.readFile("config/credentials.json")', title: 'Read' })).toEqual({ content: false, paths: [] });
    expect(secretTouch({ server: 'fs', arguments: { target: { file: '/Users/me/.aws/credentials' } } })).toEqual({ content: false, paths: [] });
  });

  it('a patch to a secret file carries its content, in any form, naming every file it edits', () => {
    expect(secretTouch({ changes: { '/Users/me/app/.env': { type: 'add' }, '/Users/me/app/a.ts': { type: 'add' } } }))
      .toEqual({ content: true, paths: ['/Users/me/app/.env', '/Users/me/app/a.ts'] });
    expect(secretTouch('*** Begin Patch\n*** Update File: config/credentials.json\n+token\n*** End Patch'))
      .toEqual({ content: true, paths: ['config/credentials.json'] });
    // A patch written inside an exec script, its newlines as \n escapes.
    expect(secretTouch('await tools.apply_patch("*** Begin Patch\\n*** Add File: /p/.env\\n+S=1\\n*** End Patch");'))
      .toEqual({ content: true, paths: ['/p/.env'] });
  });

  it('leaves ordinary calls alone', () => {
    expect(secretTouch({ file_path: 'src/app.ts' })).toBeNull();
    expect(secretTouch({ command: 'npm test -- src/env.test.ts' })).toBeNull();
    expect(secretTouch('*** Begin Patch\n*** Update File: src/a.ts\n+x\n*** End Patch')).toBeNull();
    expect(secretTouch(undefined)).toBeNull();
  });
});
