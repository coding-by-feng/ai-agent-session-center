import { describe, it, expect } from 'vitest';
import { createTranscriptLog } from '../../server/voice/transcriptLog.js';

describe('createTranscriptLog', () => {
  it('joins the deltas of one turn and starts a new line when the speaker changes', () => {
    const log = createTranscriptLog();
    log.add('user', 'What is ', 1000, 1200);
    log.add('user', 'running?', 1200, 1500);
    log.add('assistant', 'Three sessions.', 2000, 2600);
    expect(log.lines().map((l) => [l.role, l.text])).toEqual([
      ['user', 'What is running?'],
      ['assistant', 'Three sessions.'],
    ]);
  });

  it('starts a new line of the same speaker after a long pause', () => {
    const log = createTranscriptLog();
    log.add('user', 'one', 0, 500);
    log.add('user', 'two', 9000, 9400);
    expect(log.lines()).toHaveLength(2);
  });

  it('gives what the user said after an offset, and the last user line when nothing is newer', () => {
    const log = createTranscriptLog();
    log.add('user', 'check the project', 1000, 2000);
    log.add('assistant', 'Sure.', 2200, 2500);
    log.add('user', 'and the queue', 5000, 6000);
    expect(log.userSince(3000)).toBe('and the queue');
    expect(log.userSince(0)).toBe('check the project and the queue');
    expect(log.userSince(10_000)).toBe('and the queue');
  });

  it('answers an empty string when the user has said nothing', () => {
    expect(createTranscriptLog().userSince(0)).toBe('');
  });

  it('gives the newest lines that fit, oldest first', () => {
    const log = createTranscriptLog();
    log.add('user', 'a'.repeat(50), 0, 100);
    log.add('assistant', 'b'.repeat(50), 200, 300);
    log.add('user', 'c'.repeat(10), 400, 500);
    const recent = log.recent(80);
    expect(recent).toContain('c'.repeat(10));
    expect(recent).toContain('AASC: ');
    expect(recent).not.toContain('a'.repeat(50));
  });

  it('keeps at most maxLines lines', () => {
    const log = createTranscriptLog(3);
    for (let i = 0; i < 6; i += 1) log.add(i % 2 ? 'assistant' : 'user', `t${i}`, i * 1000, i * 1000 + 100);
    expect(log.lines().map((l) => l.text)).toEqual(['t3', 't4', 't5']);
  });
});
