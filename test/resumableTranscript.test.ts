// test/resumableTranscript.test.ts — `claude --resume <id>` is only safe when
// THAT session's transcript is actually on disk.
//
// The AI popup used `promptHistory.length > 0` as a proxy for "the parent has a
// resumable conversation". It doesn't prove one: prompt history survives
// workspace restore, /clear and session re-keys, and a session whose transcript
// was never persisted (see claudeSessionEnv.test.ts) or was cleaned up by
// Claude's retention still shows prompts. The fork then launched
//   claude --resume '<id>' --fork-session '<prompt>'
// which exits immediately with "No conversation found with session ID: <id>",
// leaving the user a dead shell instead of an answer.
//
// resolveResumableClaudeSessionId answers the real question — and must NOT
// reuse findTranscriptFile's "newest .jsonl in the dir" fallback, which would
// call an unrelated conversation resumable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveResumableClaudeSessionId } from '../server/extractPreviousAnswer.js';

const SESSION_ID = '26bf87ee-a3f9-494c-b305-3354ed8f732c';
const OTHER_ID = '96c1e7a3-bac5-455d-9a23-dba22a2f3e96';
const PROJECT_PATH = '/Users/x/Documents/second-brain';
const ENCODED = '-Users-x-Documents-second-brain';

let home: string;
let projectDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'aasc-transcript-'));
  process.env.HOME = home; // os.homedir() honours $HOME on POSIX
  projectDir = join(home, '.claude', 'projects', ENCODED);
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

const writeTranscript = (dir: string, id: string) =>
  writeFileSync(join(dir, `${id}.jsonl`), '{"type":"user"}\n');

describe('resolveResumableClaudeSessionId', () => {
  it('returns the id when that session\'s transcript exists', () => {
    writeTranscript(projectDir, SESSION_ID);
    expect(resolveResumableClaudeSessionId(SESSION_ID, PROJECT_PATH, null)).toBe(SESSION_ID);
  });

  it('returns null when the project dir has no transcript at all', () => {
    expect(resolveResumableClaudeSessionId(SESSION_ID, PROJECT_PATH, null)).toBeNull();
  });

  it('returns null when only OTHER conversations exist in the dir', () => {
    // The bug this guards: findTranscriptFile falls back to the newest .jsonl in
    // the directory, so a dir full of unrelated sessions looks resumable.
    writeTranscript(projectDir, OTHER_ID);
    writeTranscript(projectDir, 'c44170d7-f851-4eaf-a953-7fccec326cf4');
    expect(resolveResumableClaudeSessionId(SESSION_ID, PROJECT_PATH, null)).toBeNull();
  });

  it('accepts the un-dashed project-dir encoding', () => {
    const alt = join(home, '.claude', 'projects', 'Users-x-Documents-second-brain');
    mkdirSync(alt, { recursive: true });
    writeTranscript(alt, SESSION_ID);
    expect(resolveResumableClaudeSessionId(SESSION_ID, PROJECT_PATH, null)).toBe(SESSION_ID);
  });

  it('falls back to the recorded transcriptPath when it exists (session-id drift)', () => {
    // A re-keyed/aliased card can carry a stale id while the hook-reported
    // transcript names the id Claude will actually find.
    const recorded = join(projectDir, `${OTHER_ID}.jsonl`);
    writeTranscript(projectDir, OTHER_ID);
    expect(resolveResumableClaudeSessionId(SESSION_ID, PROJECT_PATH, recorded)).toBe(OTHER_ID);
  });

  it('prefers the session id over the recorded transcriptPath', () => {
    writeTranscript(projectDir, SESSION_ID);
    writeTranscript(projectDir, OTHER_ID);
    const recorded = join(projectDir, `${OTHER_ID}.jsonl`);
    expect(resolveResumableClaudeSessionId(SESSION_ID, PROJECT_PATH, recorded)).toBe(SESSION_ID);
  });

  it('returns null when the recorded transcriptPath no longer exists', () => {
    const recorded = join(projectDir, `${OTHER_ID}.jsonl`);
    expect(resolveResumableClaudeSessionId(SESSION_ID, PROJECT_PATH, recorded)).toBeNull();
  });

  it('rejects a transcript filename that is not a shell-safe token', () => {
    const weird = join(projectDir, "bad; rm -rf ~'.jsonl");
    writeFileSync(weird, '{}\n');
    expect(resolveResumableClaudeSessionId(SESSION_ID, PROJECT_PATH, weird)).toBeNull();
  });

  it('returns null for a missing session id or project path', () => {
    writeTranscript(projectDir, SESSION_ID);
    expect(resolveResumableClaudeSessionId('', PROJECT_PATH, null)).toBeNull();
    expect(resolveResumableClaudeSessionId(SESSION_ID, '', null)).toBeNull();
  });

  it('returns null for a dashboard-internal term-* id', () => {
    // Never interpolate an internal placeholder into --resume; it would open
    // Claude's interactive session picker and block the shell.
    writeTranscript(projectDir, SESSION_ID);
    expect(resolveResumableClaudeSessionId('term-1785383529519-i4poz1', PROJECT_PATH, null)).toBeNull();
  });
});
