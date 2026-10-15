// test/chatTranscriptLocator.test.ts — AASC-41 / AASC-49: which file holds a session's conversation. Its own
// or none: never a neighbour's newest .jsonl, never the other CLI's folder. HOME and CODEX_HOME point at temp
// dirs, so nothing real is read.
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { locateTranscript, resetTranscriptLocatorCache } from '../server/chat/transcriptLocator.js';
import { tempDir } from './chatFixtures.js';

const CLAUDE_ID = '26bf87ee-a3f9-494c-b305-3354ed8f732c';
const OTHER_ID = '96c1e7a3-bac5-455d-9a23-dba22a2f3e96';
const CODEX_ID = '01a1288a-2ace-70c2-95a6-0b63700796e5';

let tmp = '';
let project = '';
let claudeDir = '';
let codexHome = '';
const saved: Record<string, string | undefined> = {};

function claudeFile(id: string): string {
  const file = join(claudeDir, `${id}.jsonl`);
  writeFileSync(file, '{}\n');
  return file;
}

function rollout(id: string, day = '2026/10/15'): string {
  const dir = join(codexHome, 'sessions', ...day.split('/'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-10-15T10-00-00-${id}.jsonl`);
  writeFileSync(file, '{}\n');
  return file;
}

beforeEach(() => {
  saved.HOME = process.env.HOME;
  saved.CODEX_HOME = process.env.CODEX_HOME;
  tmp = realpathSync(tempDir('aasc41-locate-'));
  const home = join(tmp, 'home');
  project = join(home, 'proj');
  mkdirSync(project, { recursive: true });
  claudeDir = join(home, '.claude', 'projects', `-${project.replace(/^\//, '').replace(/\//g, '-')}`);
  mkdirSync(claudeDir, { recursive: true });
  codexHome = join(home, '.codex');
  mkdirSync(join(codexHome, 'sessions'), { recursive: true });
  process.env.HOME = home;
  process.env.CODEX_HOME = codexHome;
  resetTranscriptLocatorCache();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('a Claude session', () => {
  it('reads the transcript its hook reported', async () => {
    const file = claudeFile(OTHER_ID);
    expect(await locateTranscript({ sessionId: CLAUDE_ID, cliSource: 'claude', projectPath: project, transcriptPath: file }))
      .toEqual({ cli: 'claude', path: file });
  });

  it('else its own <sessionId>.jsonl in the project folder', async () => {
    const file = claudeFile(CLAUDE_ID);
    expect(await locateTranscript({ sessionId: CLAUDE_ID, cliSource: 'claude', projectPath: project, transcriptPath: join(claudeDir, 'gone.jsonl') }))
      .toEqual({ cli: 'claude', path: file });
  });

  it('ignores a reported path that is not a transcript file', async () => {
    const notes = join(project, 'notes.txt');
    writeFileSync(notes, 'x');
    expect(await locateTranscript({ sessionId: CLAUDE_ID, cliSource: 'claude', projectPath: project, transcriptPath: notes })).toBeNull();
    expect(await locateTranscript({ sessionId: CLAUDE_ID, cliSource: 'claude', projectPath: project, transcriptPath: claudeDir })).toBeNull();
  });

  it('has none when only other conversations are in its project folder', async () => {
    claudeFile(OTHER_ID);
    expect(await locateTranscript({ sessionId: CLAUDE_ID, cliSource: 'claude', projectPath: project })).toBeNull();
  });

  it('never reads a Codex rollout, even one named after it', async () => {
    rollout(CODEX_ID);
    expect(await locateTranscript({ sessionId: CODEX_ID, cliSource: 'claude', projectPath: project })).toBeNull();
  });
});

describe('a Codex session', () => {
  it('reads its rollout', async () => {
    const file = rollout(CODEX_ID);
    expect(await locateTranscript({ sessionId: CODEX_ID, cliSource: 'codex', projectPath: project }))
      .toEqual({ cli: 'codex', path: file });
  });

  it('never reads ~/.claude/projects: not a reported path, not a file named after it, not the newest one', async () => {
    const named = claudeFile(CODEX_ID);
    claudeFile(OTHER_ID);
    expect(await locateTranscript({ sessionId: CODEX_ID, cliSource: 'codex', projectPath: project, transcriptPath: named })).toBeNull();
  });

  it('finds a rollout that appears after a miss, once the miss has gone stale', async () => {
    let now = 1_000_000;
    const session = { sessionId: CODEX_ID, cliSource: 'codex', projectPath: project };
    expect(await locateTranscript(session, { now: () => now })).toBeNull();
    const file = rollout(CODEX_ID);
    expect(await locateTranscript(session, { now: () => now })).toBeNull(); // the miss is remembered
    now += 11_000;
    expect(await locateTranscript(session, { now: () => now })).toEqual({ cli: 'codex', path: file });
  });

  it('looks again when the remembered rollout is gone', async () => {
    const first = rollout(CODEX_ID, '2026/10/14');
    const session = { sessionId: CODEX_ID, cliSource: 'codex', projectPath: project };
    expect(await locateTranscript(session)).toEqual({ cli: 'codex', path: first });
    rmSync(first);
    const moved = rollout(CODEX_ID, '2026/10/15');
    expect(await locateTranscript(session)).toEqual({ cli: 'codex', path: moved });
  });
});

describe('sessions with no readable conversation', () => {
  it('a CLI AASC cannot read', async () => {
    claudeFile(CLAUDE_ID);
    expect(await locateTranscript({ sessionId: CLAUDE_ID, cliSource: 'gemini', projectPath: project })).toBeNull();
  });

  it('a session on another machine (its files are not on this disk)', async () => {
    const file = claudeFile(CLAUDE_ID);
    expect(await locateTranscript({ sessionId: CLAUDE_ID, cliSource: 'claude', projectPath: project, transcriptPath: file, sshHost: 'buildbox' })).toBeNull();
    expect(await locateTranscript({ sessionId: CLAUDE_ID, cliSource: 'claude', projectPath: project, transcriptPath: file, sshHost: 'localhost' }))
      .toEqual({ cli: 'claude', path: file });
  });
});
