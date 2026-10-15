// test/chatSecretCalls.test.ts — AASC-41: which tool calls touch a secret file (server/mobile/secretPaths.ts),
// judged on the call's raw input: Claude's file_path / path / notebook_path and Bash command, Codex's cmd,
// action.command, exec / js code and patches in any form.
import { describe, it, expect } from 'vitest';
import { pathLooksSecretIn, secretTouch } from '../server/chat/secretCalls.js';

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

// Decision 2: a path inside the session's project is judged from the project root down, so a worktree
// under <repo>/.claude/worktrees isn't hidden for the `.claude` above it; outside the project, in full.
describe('judged from the session’s project root', () => {
  const root = '/Users/me/repo/.claude/worktrees/x';

  it('lets a worktree project’s own files through', () => {
    expect(pathLooksSecretIn(`${root}/src/a.ts`, root)).toBe(false);
    expect(pathLooksSecretIn('src/a.ts', root)).toBe(false);
    expect(pathLooksSecretIn(root, root)).toBe(false);
    expect(secretTouch({ file_path: `${root}/src/a.ts`, content: 'x' }, root)).toBeNull();
    expect(secretTouch({ command: `cd ${root} && npm test`, description: 'Test' }, root)).toBeNull();
  });

  it('still hides a secret folder or file inside the project', () => {
    expect(pathLooksSecretIn(`${root}/.claude/settings.local.json`, root)).toBe(true);
    expect(pathLooksSecretIn(`${root}/.env`, root)).toBe(true);
    expect(pathLooksSecretIn(`${root}/keys/id_rsa`, root)).toBe(true);
    expect(secretTouch({ file_path: `${root}/.env` }, root)).toEqual({ content: true, paths: [`${root}/.env`] });
    expect(secretTouch({ command: `cat ${root}/.claude/settings.local.json` }, root)).toEqual({ content: false, paths: [] });
  });

  it('judges a path outside the project in full, absolute or relative', () => {
    expect(pathLooksSecretIn('/Users/me/repo/.claude/settings.json', root)).toBe(true);
    expect(pathLooksSecretIn('/Users/me/repo/.claude/worktrees/other/src/a.ts', root)).toBe(true);
    expect(pathLooksSecretIn('../../settings.local.json', root)).toBe(true);
    expect(pathLooksSecretIn('/Users/me/other-app/src/a.ts', root)).toBe(false);
    expect(secretTouch({ command: 'cat ../../settings.local.json' }, root)).toEqual({ content: false, paths: [] });
  });

  it('never trusts a project that is itself a secrets folder', () => {
    expect(pathLooksSecretIn('/Users/me/.ssh/config', '/Users/me/.ssh')).toBe(true);
    expect(pathLooksSecretIn('config', '/Users/me/.ssh')).toBe(true);
  });

  it('judges everything in full without a project root', () => {
    expect(pathLooksSecretIn(`${root}/src/a.ts`, null)).toBe(true);
    expect(pathLooksSecretIn('src/a.ts', undefined)).toBe(false);
  });
});
