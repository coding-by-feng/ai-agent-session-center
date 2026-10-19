// sessionContentSearch.test.ts — searching what sessions said and did (prompts, answers,
// tools, events), shared by the desktop's ⇧⌘F search and the phone's Sessions search
// (Oct 20 2026), on textHighlight's one predicate.
import { describe, it, expect } from 'vitest';
import type { Session } from '@/types';
import { searchSessionContent } from './sessionContentSearch';

const s = (id: string, over: Partial<Session>): Session =>
  ({ sessionId: id, title: id, status: 'idle', promptHistory: [], responseLog: [], toolLog: [], events: [], ...over }) as unknown as Session;

describe('searchSessionContent', () => {
  it('finds prompts, answers and tool calls, case-insensitively', () => {
    const hits = searchSessionContent([
      s('a', { promptHistory: [{ text: 'Fix the Login redirect', timestamp: 1 }] as never }),
      s('b', { responseLog: [{ text: 'The login page works now.', timestamp: 2 }] as never, toolLog: [{ tool: 'Bash', input: 'npm run login-test', timestamp: 3 }] as never }),
    ], 'login');
    expect(hits.map((h) => [h.sessionId, h.field])).toEqual(expect.arrayContaining([['a', 'prompt'], ['b', 'response'], ['b', 'tool']]));
    expect(hits).toHaveLength(3);
  });

  it('treats an all-space query as none, and trims the ends', () => {
    const list = [s('a', { promptHistory: [{ text: 'a b', timestamp: 1 }] as never })];
    expect(searchSessionContent(list, '   ')).toEqual([]);
    expect(searchSessionContent(list, ' a b ')).toHaveLength(1);
  });

  it('lists working sessions first, then the newest hit, and stops at the limit', () => {
    const hits = searchSessionContent([
      s('idle', { status: 'idle', promptHistory: [{ text: 'deploy', timestamp: 9 }] as never }),
      s('busy', { status: 'working', promptHistory: [{ text: 'deploy', timestamp: 1 }] as never }),
    ], 'deploy');
    expect(hits.map((h) => h.sessionId)).toEqual(['busy', 'idle']);
    expect(searchSessionContent([s('x', { promptHistory: Array.from({ length: 5 }, (_, i) => ({ text: 'go', timestamp: i })) as never })], 'go', 2)).toHaveLength(2);
  });
});
