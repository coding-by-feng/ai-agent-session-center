// test/hookMqAppend.test.ts — the hook scripts' MQ append must write each line whole.
//
// Bash's echo flushes a long line in 1 KB pieces. Hooks that fire together (Codex runs a turn's
// tool hooks in parallel) interleaved their pieces in queue.jsonl, the server dropped the torn
// lines, and a lost first hook left a card deaf to its own agent: its queue typed the next prompt
// into a running Codex turn (Oct 30 2026). Measured with the old `echo >> file`: 250 of 320 lines
// torn at 6 KB with 8 writers.
//
// Running a whole script would append to the live dashboard queue (the path is hard-coded), so
// this runs each script's own `mq_append` function against a temp file.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const SCRIPTS = ['dashboard-hook.sh', 'dashboard-hook-codex.sh'];
const WRITERS = 8;
const LINES_PER_WRITER = 25;
const hasPerl = spawnSync('perl', ['-e', '1']).status === 0;

function extractMqAppend(script: string): string {
  const src = readFileSync(fileURLToPath(new URL(`../hooks/${script}`, import.meta.url)), 'utf8');
  const start = src.indexOf('mq_append() {');
  const end = src.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`mq_append not found in ${script}`);
  return src.slice(start, end + 3);
}

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'aasc-mq-append-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/** WRITERS bash processes append LINES_PER_WRITER lines each, all at once. Returns the torn count. */
async function runWriters(script: string, padChars: number, pad: (w: string) => string, env: NodeJS.ProcessEnv = process.env) {
  const out = join(dir, `${script}-${padChars}-${Math.random().toString(36).slice(2)}.jsonl`);
  const writer = join(dir, 'writer.sh');
  writeFileSync(writer, `${extractMqAppend(script)}
LINE="{\\"w\\":\\"$1\\",\\"pad\\":\\"$3\\"}"
for i in $(seq 1 ${LINES_PER_WRITER}); do mq_append "$LINE" "$2"; done
`);
  const ids = 'abcdefgh'.slice(0, WRITERS).split('');
  await Promise.all(ids.map((w) => new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/bash', [writer, w, out, pad(w).repeat(padChars)], { env, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', () => resolve());
  })));
  const lines = readFileSync(out, 'utf8').split('\n').filter(Boolean);
  let torn = 0;
  for (const line of lines) {
    try {
      const o = JSON.parse(line) as { w: string; pad: string };
      if (o.pad !== pad(o.w).repeat(padChars)) torn++;
    } catch {
      torn++;
    }
  }
  return { lines: lines.length, torn };
}

describe.each(SCRIPTS)('%s mq_append', (script) => {
  it('keeps short lines whole (the plain echo path)', async () => {
    const r = await runWriters(script, 600, (w) => w);
    expect(r).toEqual({ lines: WRITERS * LINES_PER_WRITER, torn: 0 });
  });

  it.skipIf(!hasPerl)('keeps 6 KB lines whole under concurrent writers', async () => {
    const r = await runWriters(script, 6000, (w) => w);
    expect(r).toEqual({ lines: WRITERS * LINES_PER_WRITER, torn: 0 });
  });

  it.skipIf(!hasPerl)('keeps 200 KB lines whole (a tool call carrying a whole file)', async () => {
    const r = await runWriters(script, 200_000, (w) => w);
    expect(r).toEqual({ lines: WRITERS * LINES_PER_WRITER, torn: 0 });
  });

  it.skipIf(!hasPerl)('counts bytes, not characters: 600 characters of CJK text (1200 bytes) take the one-write path', async () => {
    const r = await runWriters(script, 300, (w) => `${w}中`);
    expect(r).toEqual({ lines: WRITERS * LINES_PER_WRITER, torn: 0 });
  });

  it.skipIf(!hasPerl)('ignores a PERL_UNICODE or PERL5OPT exported by the user\'s shell', async () => {
    // PERL_UNICODE=SD puts a :utf8 layer on the handles, and syswrite then dies: every long line lost.
    const env = { ...process.env, PERL_UNICODE: 'SD', PERL5OPT: '-Mutf8' };
    const r = await runWriters(script, 6000, (w) => `${w}中`, env);
    expect(r).toEqual({ lines: WRITERS * LINES_PER_WRITER, torn: 0 });
  });

  // The fallback is only whole up to one pipe read (~16 KB); perl ships on macOS and Debian/Ubuntu.
  it('without perl, falls back to cat, still whole at 6 KB', async () => {
    const bin = join(dir, `bin-${script}`);
    mkdirSync(bin, { recursive: true });
    for (const tool of ['cat', 'seq']) {
      const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      symlinkSync(found, join(bin, tool));
    }
    const r = await runWriters(script, 6000, (w) => w, { ...process.env, PATH: bin });
    expect(r).toEqual({ lines: WRITERS * LINES_PER_WRITER, torn: 0 });
  });
});
