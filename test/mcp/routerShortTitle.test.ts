// test/mcp/routerShortTitle.test.ts — the router's title for a new session (server/mcp/router.ts `shortTitle`): the
// task's first words, at most 60 characters, and cleaned by the title rule (titleRule.ts, Ruling P3-23), because the
// title is typed as `-n "<title>"` and stored back as loose words a relaunch types again. Pure.
import { describe, expect, it, vi } from 'vitest';
import { shortTitle } from '../../server/mcp/router.js';
import { titleRefusal } from '../../server/mcp/titleRule.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

describe('shortTitle', () => {
  it('keeps a plain task as it is, and cuts a long one at a word with an ellipsis', () => {
    expect(shortTitle('Fix the login bug')).toBe('Fix the login bug');
    const long = shortTitle('word '.repeat(30));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('…')).toBe(true);
  });

  it('cleans shell syntax, quotes, line breaks and dash words out of the task', () => {
    expect(shortTitle('run it with --add-dir / ; then `report`')).toBe('run it with add-dir / then report');
    expect(shortTitle('w --allowedTools Bash\nnext line')).toBe('w allowedTools Bash next line');
    expect(shortTitle('$(rm -rf ~)')).toBe('rm rf ~');
    expect(shortTitle(';;;')).toBe('New session');
  });

  it('what it answers always passes the title rule', () => {
    for (const task of ['x -y ; touch /tmp/p', `${'-a '.repeat(40)}`, `${'word '.repeat(11)}--flag rest`, 'Kason\'s "boss" [now]?']) {
      expect(titleRefusal(shortTitle(task)), task).toBeNull();
    }
  });
});
