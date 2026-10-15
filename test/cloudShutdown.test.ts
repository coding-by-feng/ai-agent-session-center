import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { projectFixture } from './cloudProjectsFixture.js';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
async function harness(
  cloud: { stop(): Promise<void> },
  cloudJobs: Promise<{ close(): Promise<void> }>,
) {
  const source = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  // Graceful shutdown —');
  const end = source.indexOf('  // Expose shutdown', start);
  const code = ts.transpile(source.slice(start, end) + '\nreturn gracefulShutdown;', {
    target: ts.ScriptTarget.ES2022,
  });
  const closeDb = vi.fn(),
    closed = deferred(),
    server = {
      close: vi.fn((cb: () => void) => {
        void closed.promise.then(cb);
      }),
      closeAllConnections: vi.fn(),
    };
  const noop = () => {};
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const shutdown = new Function(
    'cloud',
    'cloudJobs',
    'server',
    'log',
    'stopPeriodicSave',
    'stopPlanUsage',
    'stopHeartbeat',
    'stopMqReader',
    'stopTokenCleanup',
    'saveSnapshot',
    'getMqOffset',
    'closeDb',
    code,
  )(cloud, cloudJobs, server, log, noop, noop, noop, noop, noop, noop, noop, closeDb) as (
    signal: string,
  ) => Promise<void>;
  return { shutdown, closeDb, closed, server, log };
}
it('duplicate shutdown callers share cloud cancellation, job drain and HTTP completion', async () => {
  const stop = deferred(),
    jobs = deferred();
  const cloud = { stop: vi.fn(() => stop.promise) },
    close = vi.fn(() => jobs.promise);
  const h = await harness(cloud, Promise.resolve({ close }));
  const first = h.shutdown('test'),
    second = h.shutdown('electron-quit');
  let done = false;
  void first.then(() => {
    done = true;
  });
  h.closed.resolve();
  await vi.waitFor(() => expect(close).toHaveBeenCalled());
  expect(first).toBe(second);
  expect(done).toBe(false);
  expect(h.closeDb).not.toHaveBeenCalled();
  stop.resolve();
  await Promise.resolve();
  expect(done).toBe(false);
  jobs.resolve();
  await first;
  expect(cloud.stop).toHaveBeenCalledTimes(1);
  expect(h.closeDb).toHaveBeenCalledTimes(1);
});
it('shutdown waits for a running project clone and resource queue cleanup before closing DB', async () => {
  const f = await projectFixture();
  const clone = deferred(),
    resource = deferred();
  f.git.clone.mockImplementation(async () => {
    await clone.promise;
  });
  const job = await f.service.getProject(
    f.project.id,
    { parentPath: f.home, directoryName: 'shutdown', transport: 'https', resourceVersions: [] },
    f.binding,
  );
  await vi.waitFor(() => expect(f.git.clone).toHaveBeenCalled());
  const jobDone = f.jobs.wait(job.id);
  const queued = f.jobs.enqueue(() => resource.promise);
  try {
    const h = await harness({ stop: async () => {} }, Promise.resolve(f.jobs));
    let done = false;
    const result = h.shutdown('test').then(() => {
      done = true;
    });
    h.closed.resolve();
    await new Promise((r) => setImmediate(r));
    expect(done).toBe(false);
    expect(h.closeDb).not.toHaveBeenCalled();
    clone.resolve();
    await new Promise((r) => setImmediate(r));
    expect(done).toBe(false);
    resource.resolve();
    await queued;
    await result;
    expect(h.closeDb).toHaveBeenCalledTimes(1);
  } finally {
    clone.resolve();
    resource.resolve();
    await queued;
  }
  expect((await jobDone).state).toBe('cancelled');
});
it('HTTP timeout is observable and never bypasses cloud cleanup', async () => {
  vi.useFakeTimers();
  const stop = deferred();
  try {
    const h = await harness(
      { stop: () => stop.promise },
      Promise.resolve({ close: async () => {} }),
    );
    let done = false;
    const result = h.shutdown('timeout-test').then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(h.log.warn).toHaveBeenCalled();
    expect(done).toBe(false);
    stop.resolve();
    await result;
    expect(done).toBe(true);
  } finally {
    stop.resolve();
    vi.useRealTimers();
  }
});
it('a failed cleanup waits for the other safe boundary and rejects instead of reporting success', async () => {
  const jobs = deferred();
  const h = await harness(
    {
      stop: async () => {
        throw Error('synthetic failure');
      },
    },
    Promise.resolve({ close: () => jobs.promise }),
  );
  const result = h.shutdown('failure');
  const checked = expect(result).rejects.toThrow('synthetic failure');
  h.closed.resolve();
  await new Promise((r) => setImmediate(r));
  expect(h.closeDb).not.toHaveBeenCalled();
  jobs.resolve();
  await checked;
  expect(h.log.error).toHaveBeenCalled();
  expect(h.closeDb).toHaveBeenCalledTimes(1);
});
