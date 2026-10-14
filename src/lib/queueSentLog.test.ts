import { describe, it, expect } from 'vitest';
import {
  appendQueueSent,
  isQueueSent,
  QUEUE_SENT_CAP,
  type QueueSent,
} from './queueSentLog';

const T = 1_700_000_000_000;
const MIN = 60_000;

describe('appendQueueSent', () => {
  it('returns a new array with the record appended', () => {
    const log: QueueSent[] = [{ text: 'a', sentAt: T }];
    const next = appendQueueSent(log, { text: 'b', sentAt: T + 1 });
    expect(next).toEqual([{ text: 'a', sentAt: T }, { text: 'b', sentAt: T + 1 }]);
    expect(log).toHaveLength(1);
  });

  it('drops the oldest records beyond the cap', () => {
    const log = Array.from({ length: QUEUE_SENT_CAP }, (_, i) => ({ text: `p${i}`, sentAt: T + i }));
    const next = appendQueueSent(log, { text: 'new', sentAt: T + 9999 });
    expect(next).toHaveLength(QUEUE_SENT_CAP);
    expect(next[0].text).toBe('p1');
    expect(next[next.length - 1].text).toBe('new');
  });

  it('ignores a record whose text is blank (an image-only send has nothing to match)', () => {
    expect(appendQueueSent([], { text: '  \n ', sentAt: T })).toEqual([]);
  });
});

describe('isQueueSent', () => {
  const log: QueueSent[] = [{ text: 'including model select /raab', sentAt: T }];

  it('matches the transcript text even with image paths appended after it', () => {
    expect(isQueueSent(log, 'including model select /raab\n/tmp/claude-queue-images/x.png', T + 2000)).toBe(true);
  });

  it('tolerates whitespace reflow between what was sent and what was recorded', () => {
    expect(isQueueSent(log, '  including  model\nselect /raab ', T + 1000)).toBe(true);
  });

  it('does not match a prompt typed long after the send', () => {
    expect(isQueueSent(log, 'including model select /raab', T + 6 * MIN)).toBe(false);
  });

  it('does not match a different prompt', () => {
    expect(isQueueSent(log, 'fix the header', T + 1000)).toBe(false);
  });

  it('compares only the first 80 characters of a long prompt', () => {
    const long = `${'x'.repeat(80)} tail the transcript rewrote`;
    const sent = appendQueueSent([], { text: `${'x'.repeat(80)} original tail`, sentAt: T });
    expect(isQueueSent(sent, long, T)).toBe(true);
  });

  it('does not let a short queued prompt claim a longer hand-typed one that starts the same', () => {
    const sent: QueueSent[] = [{ text: 'fix', sentAt: T }];
    expect(isQueueSent(sent, 'fix the login redirect', T + 1000)).toBe(false);
    expect(isQueueSent(sent, 'fix', T + 1000)).toBe(true);
    expect(isQueueSent(sent, 'fix\n/tmp/claude-queue-images/a.png', T + 1000)).toBe(true);
  });

  it('matches a queued slash command recorded as "name args"', () => {
    expect(isQueueSent([{ text: '/effort high', sentAt: T }], '/effort high', T + 500)).toBe(true);
  });
});
