import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRuntimeWatch, type RuntimeWatch } from '../server/sessionRuntimeWatch.js';
import type { RuntimeReading } from '../server/sessionRuntime.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const effortLine = (level: string, iso: string) => JSON.stringify({
  type: 'system', subtype: 'local_command', timestamp: iso,
  content: `<local-command-stdout>Set effort level to ${level} (this session only)</local-command-stdout>`,
  commandRun: { command: 'effort', args: level },
}) + '\n';

let root: string;
let dir: string;
let watch: RuntimeWatch | null;
let bySession: Array<[string, RuntimeReading]>;
let byTranscript: Array<[string, RuntimeReading]>;

function makeWatch(target = dir): RuntimeWatch {
  watch = createRuntimeWatch(
    {
      applyToSession: (id, r) => { bySession.push([id, r]); },
      applyToTranscript: (p, r) => { byTranscript.push([p, r]); },
    },
    { dir: target, debounceMs: 20 },
  );
  watch.start();
  return watch;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aasc-runtime-'));
  dir = join(root, 'runtime');
  mkdirSync(dir, { mode: 0o700 });
  bySession = [];
  byTranscript = [];
  watch = null;
});

afterEach(() => {
  watch?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('createRuntimeWatch — status-line snapshots', () => {
  it('reads snapshots already there at start, then each one the tap writes', async () => {
    writeFileSync(join(dir, `${SID}.json`), JSON.stringify({ session_id: SID, ts: 1000, model: { display_name: 'Opus 5.5' }, effort: { level: 'high' } }));
    makeWatch();
    expect(await waitFor(() => bySession.length >= 1)).toBe(true);
    expect(bySession[0]).toEqual([SID, { model: 'Opus 5.5', modelAt: 1000, effort: 'high', effortAt: 1000, effortSet: false }]);

    writeFileSync(join(dir, `${SID}.json`), JSON.stringify({ session_id: SID, ts: 2000, model: { display_name: 'Opus 5.5' }, effort: { level: 'max' } }));
    expect(await waitFor(() => bySession.some(([, r]) => r.effort === 'max'))).toBe(true);
  });

  it('ignores temp files, foreign names, oversized and malformed snapshots', async () => {
    makeWatch();
    writeFileSync(join(dir, `.${SID}.123.tmp`), '{}');
    writeFileSync(join(dir, 'not a session.json'), JSON.stringify({ ts: 1, model: { id: 'x' } }));
    writeFileSync(join(dir, 'big.json'), JSON.stringify({ ts: 1, model: { id: 'x' }, pad: 'x'.repeat(40_000) }));
    writeFileSync(join(dir, 'bad.json'), '{nope');
    writeFileSync(join(dir, 'ok.json'), JSON.stringify({ ts: 1, model: { id: 'claude-opus-5-5' } }));
    expect(await waitFor(() => bySession.length >= 1)).toBe(true);
    await sleep(150);
    expect(bySession.map(([id]) => id)).toEqual(['ok']);
  });

  it('never reads a directory that is a symlink or writable by others (shared /tmp ground)', async () => {
    const real = join(root, 'elsewhere');
    mkdirSync(real, { mode: 0o700 });
    writeFileSync(join(real, `${SID}.json`), JSON.stringify({ ts: 1, model: { id: 'x' } }));
    const link = join(root, 'linked');
    symlinkSync(real, link);
    makeWatch(link);
    await sleep(200);
    expect(bySession).toEqual([]);
    watch!.stop();

    chmodSync(dir, 0o777);
    writeFileSync(join(dir, `${SID}.json`), JSON.stringify({ ts: 1, model: { id: 'x' } }));
    makeWatch(dir);
    await sleep(200);
    expect(bySession).toEqual([]);
  });

  it('a directory created after start is picked up on a later sync', async () => {
    const late = join(root, 'late');
    makeWatch(late);
    mkdirSync(late, { mode: 0o700 });
    writeFileSync(join(late, `${SID}.json`), JSON.stringify({ ts: 5, model: { id: 'claude-haiku-4-5' } }));
    watch!.syncTranscripts([], { retryDirNow: true });
    expect(await waitFor(() => bySession.length >= 1)).toBe(true);
  });
});

describe('createRuntimeWatch — transcripts', () => {
  it('reads a transcript as soon as it is tracked, and again on every append', async () => {
    const t = join(root, 'session.jsonl');
    writeFileSync(t, effortLine('high', '2026-10-14T03:00:01.000Z'));
    makeWatch();
    watch!.syncTranscripts([t]);
    expect(await waitFor(() => byTranscript.some(([, r]) => r.effort === 'high'))).toBe(true);

    appendFileSync(t, effortLine('max', '2026-10-14T03:00:02.000Z'));
    expect(await waitFor(() => byTranscript.some(([, r]) => r.effort === 'max'))).toBe(true);
    expect(byTranscript.every(([p]) => p === t)).toBe(true);
  });

  it('stops listening to a transcript once no live session uses it', async () => {
    const t = join(root, 'session.jsonl');
    writeFileSync(t, effortLine('high', '2026-10-14T03:00:01.000Z'));
    makeWatch();
    watch!.syncTranscripts([t]);
    expect(await waitFor(() => byTranscript.length >= 1)).toBe(true);

    watch!.syncTranscripts([]);
    const before = byTranscript.length;
    appendFileSync(t, effortLine('low', '2026-10-14T03:00:03.000Z'));
    await sleep(200);
    expect(byTranscript.length).toBe(before);
  });

  it('a transcript that does not exist yet is retried on the next sync', async () => {
    const t = join(root, 'later.jsonl');
    makeWatch();
    watch!.syncTranscripts([t]);
    await sleep(80);
    expect(byTranscript).toEqual([]);
    writeFileSync(t, effortLine('medium', '2026-10-14T03:00:04.000Z'));
    watch!.syncTranscripts([t]);
    expect(await waitFor(() => byTranscript.some(([, r]) => r.effort === 'medium'))).toBe(true);
  });

  it('only ever reads .jsonl transcripts', async () => {
    const t = join(root, 'notes.txt');
    writeFileSync(t, effortLine('max', '2026-10-14T03:00:01.000Z'));
    makeWatch();
    watch!.syncTranscripts([t]);
    await sleep(150);
    expect(byTranscript).toEqual([]);
  });
});
