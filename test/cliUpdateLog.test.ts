// test/cliUpdateLog.test.ts — an agent CLI update's live log (Oct 26 2026): stdout/stderr chunks
// become the lines Settings ▸ ADVANCED ▸ Agent CLIs shows while `claude update` / `codex update` runs.
import { describe, it, expect } from 'vitest';
import { createUpdateLog, UPDATE_LOG_LINE_CAP } from '../server/cliUpdateLog.js';

const mask = (t: string) => t.split('/Users/me').join('~');

describe('createUpdateLog', () => {
  it('splits chunks into lines, keeping a line that arrives in pieces whole', () => {
    const log = createUpdateLog(40, mask);
    log.push('stdout', 'Updating Codex via `npm ins');
    log.push('stdout', 'tall -g @openai/codex`\nadded 1 pack');
    expect(log.lines()).toEqual(['Updating Codex via `npm install -g @openai/codex`', 'added 1 pack']);
  });

  it('lets a carriage return overwrite its line, even when \\r\\n is split across chunks', () => {
    const log = createUpdateLog(40, mask);
    log.push('stdout', 'Downloading 10%\rDownloading 55%\r');
    log.push('stdout', '\nDone\r\n');
    expect(log.lines()).toEqual(['Downloading 55%', 'Done']);
    log.push('stdout', 'Installing 1/3\rInstalling 3/3');
    expect(log.lines()).toEqual(['Downloading 55%', 'Done', 'Installing 3/3']);
  });

  it('strips ANSI, drops blank lines, masks the home folder and caps long lines', () => {
    const log = createUpdateLog(40, mask);
    log.push('stderr', '\x1b[31mnpm ERR!\x1b[0m EACCES /Users/me/.npm\n\n   \n');
    log.push('stdout', `${'x'.repeat(UPDATE_LOG_LINE_CAP + 50)}\n`);
    const lines = log.lines();
    expect(lines[0]).toBe('npm ERR! EACCES ~/.npm');
    expect(lines[1]).toHaveLength(UPDATE_LOG_LINE_CAP);
    expect(lines).toHaveLength(2);
  });

  it('keeps each stream’s unfinished line apart, and only the newest lines', () => {
    const log = createUpdateLog(3, mask);
    log.push('stdout', 'out-a ');
    log.push('stderr', 'warn\n');
    log.push('stdout', 'out-b\n1\n2\n3\n');
    expect(log.lines()).toEqual(['1', '2', '3']);
    const all = createUpdateLog(10, mask);
    all.push('stdout', 'out-a ');
    all.push('stderr', 'warn\n');
    all.push('stdout', 'out-b\n');
    expect(all.lines()).toEqual(['warn', 'out-a out-b']);
  });

  it('returns a new array each time, so a broadcast never changes under a listener', () => {
    const log = createUpdateLog(40, mask);
    log.push('stdout', 'one\n');
    const first = log.lines();
    log.push('stdout', 'two\n');
    expect(first).toEqual(['one']);
  });
});
