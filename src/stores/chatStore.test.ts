// chatStore.test.ts — the phone chat's pages (AASC-41): the newest page first,
// older pages prepended, new entries appended (asking again while the server says
// there is more), a reset dropping what was held, a late answer from before a reset
// ignored, overlapping refreshes coalesced, and at most five sessions kept.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatEntry, ChatPage } from '@/types/chat';
import type { ApiResult, PageCursor } from '@/lib/chat/chatApi';

const fetchChatPage = vi.fn<(id: string, cursor?: PageCursor) => Promise<ApiResult<ChatPage>>>();
vi.mock('@/lib/chat/chatApi', () => ({ fetchChatPage: (id: string, cursor?: PageCursor) => fetchChatPage(id, cursor) }));

const { useChatStore, retainChat, MAX_CHAT_SESSIONS } = await import('./chatStore');

const entry = (n: number): ChatEntry => ({ key: `${n}:0`, timestamp: n, kind: 'assistant', text: `reply ${n}` });
const page = (from: number, to: number, extra: Partial<ChatPage> = {}): ApiResult<ChatPage> => ({
  ok: true,
  data: {
    entries: Array.from({ length: to - from }, (_, i) => entry(from + i)),
    before: `b${from}`,
    after: `a${to}`,
    cli: 'claude',
    hasMore: from > 0,
    ...extra,
  },
});
const keys = (id: string) => useChatStore.getState().sessions[id]?.entries.map((e) => e.key) ?? [];

beforeEach(() => {
  fetchChatPage.mockReset();
  useChatStore.getState().clearAll();
});

describe('chatStore', () => {
  it('opens on the newest page', async () => {
    fetchChatPage.mockResolvedValueOnce(page(1800, 2000));
    await useChatStore.getState().open('s1');
    expect(fetchChatPage).toHaveBeenCalledWith('s1', undefined);
    const s = useChatStore.getState().sessions.s1;
    expect(s).toMatchObject({ status: 'ready', cli: 'claude', hasOlder: true, before: 'b1800', after: 'a2000' });
    expect(s.entries).toHaveLength(200);
  });

  it('prepends an older page without duplicating an entry', async () => {
    fetchChatPage.mockResolvedValueOnce(page(1800, 2000));
    await useChatStore.getState().open('s1');
    fetchChatPage.mockResolvedValueOnce(page(1600, 1801));
    await useChatStore.getState().loadOlder('s1');
    expect(fetchChatPage).toHaveBeenLastCalledWith('s1', { before: 'b1800' });
    expect(keys('s1')).toHaveLength(400);
    expect(keys('s1')[0]).toBe('1600:0');
    expect(useChatStore.getState().sessions.s1.before).toBe('b1600');
  });

  it('stops asking for older pages at the start', async () => {
    fetchChatPage.mockResolvedValueOnce(page(0, 50));
    await useChatStore.getState().open('s1');
    expect(useChatStore.getState().sessions.s1.hasOlder).toBe(false);
    await useChatStore.getState().loadOlder('s1');
    expect(fetchChatPage).toHaveBeenCalledTimes(1);
  });

  it('appends new entries, asking again while there is more', async () => {
    fetchChatPage.mockResolvedValueOnce(page(0, 10));
    await useChatStore.getState().open('s1');
    fetchChatPage
      .mockResolvedValueOnce(page(10, 12, { hasMore: true }))
      .mockResolvedValueOnce(page(12, 13, { hasMore: false }));
    await useChatStore.getState().refresh('s1');
    expect(fetchChatPage.mock.calls.slice(1).map((c) => c[1])).toEqual([{ after: 'a10' }, { after: 'a12' }]);
    expect(keys('s1')).toHaveLength(13);
    expect(useChatStore.getState().sessions.s1.after).toBe('a13');
  });

  it('drops what it holds on a reset (a /clear started a new transcript)', async () => {
    fetchChatPage.mockResolvedValueOnce(page(0, 10));
    await useChatStore.getState().open('s1');
    const version = useChatStore.getState().sessions.s1.version;
    fetchChatPage.mockResolvedValueOnce({ ok: true, data: { entries: [entry(900)], before: 'x', after: 'y', cli: 'claude', hasMore: false, reset: true } });
    await useChatStore.getState().refresh('s1');
    expect(keys('s1')).toEqual(['900:0']);
    expect(useChatStore.getState().sessions.s1.version).toBe(version + 1);
  });

  it('ignores an older page that answers after a reset', async () => {
    fetchChatPage.mockResolvedValueOnce(page(100, 200));
    await useChatStore.getState().open('s1');
    let answerOlder!: (r: ApiResult<ChatPage>) => void;
    fetchChatPage.mockImplementationOnce(() => new Promise((r) => { answerOlder = r; }));
    const older = useChatStore.getState().loadOlder('s1');
    fetchChatPage.mockResolvedValueOnce({ ok: true, data: { entries: [entry(5000)], before: 'n', after: 'm', cli: 'claude', hasMore: false, reset: true } });
    await useChatStore.getState().refresh('s1');
    answerOlder(page(0, 100));
    await older;
    expect(keys('s1')).toEqual(['5000:0']);
  });

  it('reloads the newest page when the server refuses a stale cursor', async () => {
    fetchChatPage.mockResolvedValueOnce(page(0, 10));
    await useChatStore.getState().open('s1');
    fetchChatPage
      .mockResolvedValueOnce({ ok: false, status: 400, message: 'bad cursor' })
      .mockResolvedValueOnce(page(50, 60));
    await useChatStore.getState().refresh('s1');
    expect(keys('s1')[0]).toBe('50:0');
  });

  it('coalesces refreshes that overlap into one more read', async () => {
    fetchChatPage.mockResolvedValueOnce(page(0, 10));
    await useChatStore.getState().open('s1');
    let first!: (r: ApiResult<ChatPage>) => void;
    fetchChatPage.mockImplementationOnce(() => new Promise((r) => { first = r; }));
    fetchChatPage.mockResolvedValueOnce(page(11, 12, { hasMore: false }));
    const a = useChatStore.getState().refresh('s1');
    void useChatStore.getState().refresh('s1');
    void useChatStore.getState().refresh('s1');
    first(page(10, 11, { hasMore: false }));
    await a;
    await vi.waitFor(() => expect(keys('s1')).toHaveLength(12));
    expect(fetchChatPage).toHaveBeenCalledTimes(3);
  });

  it('keeps the entries and says so when a refresh fails', async () => {
    fetchChatPage.mockResolvedValueOnce(page(0, 10));
    await useChatStore.getState().open('s1');
    fetchChatPage.mockResolvedValueOnce({ ok: false, status: 0, message: 'offline' });
    await useChatStore.getState().refresh('s1');
    expect(keys('s1')).toHaveLength(10);
    expect(useChatStore.getState().sessions.s1.refreshError).toBe('offline');
  });

  it('reports a failed first load', async () => {
    fetchChatPage.mockResolvedValueOnce({ ok: false, status: 404, message: 'not here' });
    await useChatStore.getState().open('s1');
    expect(useChatStore.getState().sessions.s1).toMatchObject({ status: 'error', error: 'not here' });
  });

  it('keeps at most five sessions, never one on screen', async () => {
    fetchChatPage.mockImplementation(async () => page(0, 3));
    const release = retainChat('s0');
    for (let i = 0; i <= MAX_CHAT_SESSIONS; i += 1) await useChatStore.getState().open(`s${i}`);
    const held = Object.keys(useChatStore.getState().sessions);
    expect(held).toHaveLength(MAX_CHAT_SESSIONS);
    expect(held).toContain('s0');
    expect(held).not.toContain('s1');
    release();
  });

  it('remembers where the view was', async () => {
    fetchChatPage.mockResolvedValueOnce(page(0, 3));
    await useChatStore.getState().open('s1');
    useChatStore.getState().rememberView('s1', { firstKey: '1:0', anchorKey: '2:0', anchorOffset: 12, following: false });
    expect(useChatStore.getState().sessions.s1.view).toEqual({ firstKey: '1:0', anchorKey: '2:0', anchorOffset: 12, following: false });
  });
});
