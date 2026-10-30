import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const roots: string[] = [];
const servers: Server[] = [];
const entrypoint = resolve('bin/cli.js');
const nativeStatus = {
  available: true,
  mode: 'native_qa',
  policyVersion: 'native-qa-v1',
  runtime: 'claude-code',
  client: 'aasc',
  turnLimit: 3,
  inputLimit: 600,
  contextTokenLimit: 2500,
  outputTokenLimit: 800,
  historyPairs: 2,
  timeoutMs: 45000,
  concurrentTurns: 1,
};
const session = () => ({
  id: 'session-1',
  state: 'active',
  remaining: 3,
  completed: 0,
  reserved: 0,
  expiresAt: Date.now() + 86400000,
  transcriptExpiresAt: Date.now() + 86400000 * 30,
  turns: [] as any[],
});
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
function home() {
  const path = mkdtempSync(join(realpathSync(tmpdir()), 'aasc-trial-cli-'));
  roots.push(path);
  return path;
}
function run(
  args: string[],
  input: string,
  directory: string,
  loader?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...(loader ? ['--import', loader] : []), entrypoint, 'trial', ...args],
      { cwd: directory, env: { ...process.env, HOME: directory }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
async function fixture(
  directory: string,
  handler: (path: string, body: any, res: any, headers: any) => void,
) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    handler(
      req.url || '',
      chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
      res,
      req.headers,
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const loader = join(directory, 'transport-fixture.mjs');
  // Test-only transport injection; the shipped entrypoint accepts no server URL/environment override.
  writeFileSync(
    loader,
    `const original=globalThis.fetch;globalThis.fetch=(url,options)=>{const u=new URL(url);if(u.origin!=='https://xclaude.dev')throw Error('wrong target');return original(${JSON.stringify(origin)}+u.pathname,options);};`,
  );
  return loader;
}
function json(res: any, value: any, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
function status(res: any) {
  res.setHeader(
    'Set-Cookie',
    '__Host-aasc_trial=private-cookie; Secure; HttpOnly; Path=/; SameSite=Strict',
  );
  json(res, nativeStatus);
}

describe('existing AASC CLI trial entrypoint', () => {
  it('shows Chinese help without first-run setup, hooks, server or project changes', async () => {
    const directory = home();
    const result = await run(['help'], '', directory);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('问答');
    expect(result.stdout).toContain('activate');
    expect(result.stdout + result.stderr).not.toContain('Setup');
    expect(readdirSync(directory)).toEqual([]);
  });
  it('rejects activation codes and prompts in argv without echoing the secret', async () => {
    const directory = home();
    const result = await run(['activate', 'never-echo-private-code'], '', directory);
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).not.toContain('never-echo-private-code');
    expect(readdirSync(directory)).toEqual([]);
  });
  it('activates from stdin, retrieves safe history and logs out using the real bin entrypoint', async () => {
    const directory = home();
    let activated = false;
    let asked = false;
    let current = session();
    const loader = await fixture(directory, (path, body, res, headers) => {
      expect(headers.origin).toBe('https://xclaude.dev');
      if (path.endsWith('/status')) return status(res);
      expect(headers.cookie).toBe('__Host-aasc_trial=private-cookie');
      if (path.endsWith('/activate')) {
        activated = body.code === 'stdin-only-code';
        return json(res, current);
      }
      if (path.endsWith('/session')) return json(res, current);
      if (path.endsWith('/turns')) {
        asked = true;
        current = {
          ...current,
          completed: 1,
          remaining: 2,
          turns: [
            {
              id: 'turn-1',
              ...body,
              answer: '\u001b[2J闭包保存词法环境\u001b]52;c;YXR0YWNr\u0007',
              status: 'completed',
              createdAt: Date.now(),
            },
          ],
        };
        return json(res, current);
      }
      res.writeHead(204);
      res.end();
    });
    const activation = await run(['activate'], 'stdin-only-code\n', directory, loader);
    expect(activation.code).toBe(0);
    expect(activated).toBe(true);
    expect(activation.stdout + activation.stderr).not.toContain('stdin-only-code');
    const ask = await run(['ask'], '什么是闭包？', directory, loader);
    expect(ask.code).toBe(0);
    expect(asked).toBe(true);
    expect(ask.stdout).toContain('闭包保存词法环境');
    expect(ask.stdout).not.toMatch(/[\u001b\u0007]/);
    expect(ask.stdout).not.toContain('private-cookie');
    const history = await run(['history'], '', directory, loader);
    expect(history.code).toBe(0);
    expect(history.stdout).toContain('什么是闭包？');
    const local = JSON.parse(readFileSync(join(directory, '.config/aasc/trial.json'), 'utf8'));
    expect(local.cookie).toBe('__Host-aasc_trial=private-cookie');
    expect(local.pending).toBeNull();
    expect(local).not.toHaveProperty('turns');
    const logout = await run(['logout'], '', directory, loader);
    expect(logout.code).toBe(0);
    expect(readdirSync(join(directory, '.config/aasc'))).toEqual([]);
    expect(readdirSync(directory).sort()).toEqual(['.config', 'transport-fixture.mjs']);
  });
  it('keeps one request across CLI process restarts and only manual retry can resubmit it', async () => {
    const directory = home();
    const posted: any[] = [];
    const loader = await fixture(directory, (path, body, res) => {
      if (path.endsWith('/status')) return status(res);
      if (path.endsWith('/session')) return json(res, session());
      posted.push(body);
      if (posted.length === 1) return res.destroy();
      json(res, {
        ...session(),
        completed: 1,
        remaining: 2,
        turns: [
          { id: 'turn-1', ...body, answer: '已回答', status: 'completed', createdAt: Date.now() },
        ],
      });
    });
    const first = await run(['ask'], '解释幂等', directory, loader);
    expect(first.code).toBe(1);
    expect(posted).toHaveLength(1);
    const blocked = await run(['ask'], '不同问题', directory, loader);
    expect(blocked.code).toBe(1);
    expect(posted).toHaveLength(1);
    const retry = await run(['retry'], '', directory, loader);
    expect(retry.code).toBe(0);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual(posted[0]);
    expect(retry.stdout).toContain('已回答');
  });
});
