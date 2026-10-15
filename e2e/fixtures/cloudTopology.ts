import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
export interface CloudTestTopology {
  beUrl: string;
  aUrl: string;
  bUrl: string;
  root: string;
  a: { home: string; binding: Record<string, string | number> };
  b: { home: string; binding: Record<string, string | number> };
  control(action: string, data?: unknown): Promise<any>;
  stop(): Promise<void>;
}
export async function startCloudTopology(): Promise<CloudTestTopology> {
  const beRoot = process.env.AASC_TEST_BE_ROOT;
  if (!beRoot)
    throw new Error(
      'Set AASC_TEST_BE_ROOT to the explicit backend checkout (no sibling fallback).',
    );
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aasc-cloud-acceptance-')));
  const cwd = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  await writeFile(
    join(root, 'fixture-owner.json'),
    JSON.stringify({
      parentPid: process.pid,
      createdAt: new Date().toISOString(),
      kind: 'aasc-cloud-acceptance',
    }),
    { mode: 0o600 },
  );
  let child: ChildProcess | undefined;
  let stopped = false,
    output = '',
    seq = 0;
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    let timedOut = false;
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((done) => {
          let force: ReturnType<typeof setTimeout> | undefined;
          const timer = setTimeout(() => {
            timedOut = true;
            child!.kill('SIGTERM');
            force = setTimeout(() => child!.kill('SIGKILL'), 5000);
          }, 15000);
          child!.once('exit', () => {
            clearTimeout(timer);
            clearTimeout(force);
            done();
          });
          if (child!.connected) child!.send({ id: ++seq, action: 'stop' });
          else child!.kill('SIGTERM');
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    if (timedOut)
      throw new Error('Fixture shutdown exceeded its deadline; owned child terminated.');
  };
  try {
    child = spawn(process.execPath, ['--import', 'tsx', 'e2e/fixtures/cloudTopologyRunner.ts'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // Allowlist, never inherit tokens, agent markers, hooks, Git config or SSH agent.
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: root,
        TMPDIR: root,
        APP_USER_DATA: join(root, 'runtime'),
        VITEST: 'true',
        NODE_ENV: 'test',
        AASC_TEST_BE_ROOT: resolve(beRoot),
        AASC_CLOUD_FIXTURE_ROOT: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    child.stdout!.on('data', (b) => {
      output = (output + b).slice(-16000);
    });
    child.stderr!.on('data', (b) => {
      output = (output + b).slice(-16000);
    });
    const ready = await new Promise<any>((res, rej) => {
      const timer = setTimeout(
        () => rej(new Error('Fixture startup timed out\n' + output)),
        45_000,
      );
      child!.once('error', rej);
      child!.on('exit', (code) => {
        if (code && !stopped) console.error(output);
        clearTimeout(timer);
        rej(new Error(`Fixture exited ${code}\n${output}`));
        for (const p of pending.values()) p.reject(new Error(output));
      });
      child!.on('message', (m: any) => {
        if (m.ready) {
          clearTimeout(timer);
          res(m.ready);
        } else if (m.id) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          m.error ? p?.reject(new Error(m.error)) : p?.resolve(m.value);
        }
      });
    });
    return {
      ...ready,
      root,
      stop,
      control(action, data) {
        return new Promise((res, rej) => {
          const id = ++seq;
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error('Fixture control timed out: ' + action));
          }, 15000);
          pending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              res(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              rej(e);
            },
          });
          child!.send({ id, action, data });
        });
      },
    };
  } catch (e) {
    await stop();
    throw e;
  }
}
export const test = base.extend<{ topology: CloudTestTopology; a: Page; b: Page }>({
  topology: async ({}, use) => {
    const t = await startCloudTopology();
    try {
      await use(t);
    } finally {
      await t.stop();
      await expect(stat(t.root)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  },
  a: async ({ browser, topology }, use) => {
    const c = await browser.newContext();
    const p = await c.newPage();
    try {
      await p.goto(topology.aUrl + '/resources?section=cloud&cloudTab=resources');
      await use(p);
    } finally {
      await c.close();
    }
  },
  b: async ({ browser, topology }, use) => {
    const c = await browser.newContext();
    const p = await c.newPage();
    try {
      await p.goto(topology.bUrl + '/resources?section=cloud&cloudTab=resources');
      await use(p);
    } finally {
      await c.close();
    }
  },
});
export { expect };
export function headers(t: CloudTestTopology, device: 'a' | 'b', notes = false) {
  const b = t[device].binding,
    p = notes ? 'x-aasc-notes-' : 'x-aasc-cloud-';
  return {
    'content-type': 'application/json',
    [p + 'backend']: String(b.backendOrigin),
    [p + 'account']: String(b.accountId),
    [p + 'generation']: String(b.generation),
  };
}
export async function api(
  t: CloudTestTopology,
  device: 'a' | 'b',
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  notes = false,
) {
  const res = await fetch(t[(device + 'Url') as 'aUrl' | 'bUrl'] + path, {
    signal: AbortSignal.timeout(15000),
    method,
    headers: headers(t, device, notes),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, ...(await res.json()) };
}
export async function ok(
  t: CloudTestTopology,
  device: 'a' | 'b',
  path: string,
  body?: unknown,
  method?: string,
  notes = false,
) {
  const r = await api(t, device, path, body, method, notes);
  expect(r, path).toMatchObject({ status: 200, success: true });
  return r.data;
}
export async function job(t: CloudTestTopology, device: 'a' | 'b', id: string) {
  let result: any;
  await expect
    .poll(async () => {
      result = await ok(t, device, '/api/resources/cloud/jobs/' + id);
      return result.state;
    })
    .not.toMatch(/^(queued|running)$/);
  return result;
}
export async function publish(t: CloudTestTopology, name = 'acceptance') {
  const plan = await ok(t, 'a', '/api/resources/cloud/publish-plans', {
    selection: [{ scope: 'global', type: 'skill', include: true }],
  });
  expect(plan.blocked).toEqual([]);
  const published = await job(
    t,
    'a',
    (await ok(t, 'a', `/api/resources/cloud/publish-plans/${plan.id}/run`, {})).id,
  );
  expect(published.state).toBe('complete');
  return (await ok(t, 'b', '/api/resources/cloud/resources')).items.find(
    (r: any) => r.manifest.name === name,
  );
}
