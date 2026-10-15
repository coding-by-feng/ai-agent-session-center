// phoneRoutes.test.ts — the new phone frame's screen paths (AASC-39): parse and build,
// the parent chain a deep link restores, the `?m=` URL form, and old
// `?session=<id>&tab=` links mapped onto the new screens.
import { describe, it, expect } from 'vitest';
import {
  INFO_PAGES,
  PHONE_TABS,
  SETTINGS_SECTIONS,
  morePath,
  defaultSegment,
  diffPath,
  infoPath,
  legacyDeepLinkToPath,
  parsePhonePath,
  pathChain,
  phonePath,
  phonePathFromSearch,
  sessionPath,
  tabOfPath,
  tabRootPath,
  withPhonePath,
  withoutPhonePath,
} from './phoneRoutes';

describe('parsePhonePath / phonePath', () => {
  it('round-trips every tab root', () => {
    for (const tab of PHONE_TABS) {
      const path = tabRootPath(tab);
      expect(path).toBe(`/${tab}`);
      expect(parsePhonePath(path)).toEqual({ kind: 'tab-root', tab });
      expect(phonePath({ kind: 'tab-root', tab })).toBe(path);
    }
  });

  it('round-trips a session on each segment', () => {
    for (const segment of ['chat', 'changes', 'terminal'] as const) {
      const path = `/sessions/term-1/${segment}`;
      expect(parsePhonePath(path)).toEqual({ kind: 'session', sessionId: 'term-1', segment });
      expect(phonePath({ kind: 'session', sessionId: 'term-1', segment })).toBe(path);
    }
  });

  it('round-trips the More pages', () => {
    for (const page of ['history', 'prompts', 'review', 'agenda', 'settings', 'about', 'gallery'] as const) {
      expect(parsePhonePath(`/more/${page}`)).toEqual({ kind: 'more', page });
    }
  });

  it('round-trips the More pages AASC-47 adds', () => {
    for (const page of ['saved-prompts', 'phone'] as const) {
      expect(parsePhonePath(`/more/${page}`)).toEqual({ kind: 'more', page });
      expect(phonePath({ kind: 'more', page })).toBe(`/more/${page}`);
    }
  });

  it('puts each Settings page under /more/settings, and only there', () => {
    for (const page of SETTINGS_SECTIONS) {
      const path = `/more/settings/${page}`;
      expect(parsePhonePath(path)).toEqual({ kind: 'more', page });
      expect(phonePath({ kind: 'more', page })).toBe(path);
      expect(morePath(page)).toBe(path);
      expect(parsePhonePath(`/more/${page}`), page).toBeNull();
    }
    expect(parsePhonePath('/more/settings/history')).toBeNull();
    expect(parsePhonePath('/more/settings/appearance/x')).toBeNull();
    expect(morePath('history')).toBe('/more/history');
  });

  it('round-trips a session\'s Info and each screen it opens (AASC-46)', () => {
    expect(infoPath('term-1')).toBe('/sessions/term-1/info');
    expect(parsePhonePath('/sessions/term-1/info')).toEqual({ kind: 'session-info', sessionId: 'term-1', page: null });
    expect(phonePath({ kind: 'session-info', sessionId: 'term-1', page: null })).toBe('/sessions/term-1/info');
    expect([...INFO_PAGES]).toEqual(['files', 'notes', 'queue', 'agents', 'popups']);
    for (const page of INFO_PAGES) {
      const path = `/sessions/term-1/info/${page}`;
      expect(infoPath('term-1', page)).toBe(path);
      expect(parsePhonePath(path)).toEqual({ kind: 'session-info', sessionId: 'term-1', page });
      expect(phonePath({ kind: 'session-info', sessionId: 'term-1', page })).toBe(path);
    }
  });

  it('refuses a malformed Info path', () => {
    for (const bad of ['/sessions/term-1/info/nope', '/sessions/term-1/info/files/x', '/sessions/<x>/info',
      '/sessions/term-1/infos', '/sessions/term-1/info/']) {
      expect(parsePhonePath(bad), bad).toBeNull();
    }
  });

  it('refuses anything else', () => {
    for (const bad of ['', '/', 'sessions', '/nope', '/sessions/a/b/c', '/sessions/term-1/files',
      '/sessions/../etc/chat', '/sessions/<x>/chat', '/more/unknown', '/inbox/x', `/sessions/${'a'.repeat(65)}/chat`]) {
      expect(parsePhonePath(bad), bad).toBeNull();
    }
  });

  it('round-trips one file’s diff from Changes (AASC-44)', () => {
    expect(parsePhonePath('/sessions/term-1/changes/12')).toEqual({ kind: 'diff', sessionId: 'term-1', fileIndex: 12 });
    expect(diffPath('term-1', 0)).toBe('/sessions/term-1/changes/0');
    expect(phonePath({ kind: 'diff', sessionId: 'term-1', fileIndex: 3 })).toBe('/sessions/term-1/changes/3');
    for (const bad of ['/sessions/x/changes/-1', '/sessions/x/changes/a', '/sessions/x/changes/12345', '/sessions/x/chat/1', '/sessions/x/changes/1/2']) {
      expect(parsePhonePath(bad), bad).toBeNull();
    }
  });

  it('builds session paths, chat by default', () => {
    expect(sessionPath('abc')).toBe('/sessions/abc/chat');
    expect(sessionPath('abc', 'terminal')).toBe('/sessions/abc/terminal');
  });
});

describe('tabOfPath / pathChain', () => {
  it('puts a path in its tab', () => {
    expect(tabOfPath('/sessions/x/chat')).toBe('sessions');
    expect(tabOfPath('/inbox')).toBe('inbox');
    expect(tabOfPath('/queue')).toBe('queue');
    expect(tabOfPath('/more/gallery')).toBe('more');
    expect(tabOfPath('/sessions/x/changes/2')).toBe('sessions');
    expect(tabOfPath('/sessions/x/info/files')).toBe('sessions');
    expect(tabOfPath('/more/settings/appearance')).toBe('more');
  });

  it('lists the screens a deep link stacks, root first', () => {
    expect(pathChain('/sessions')).toEqual(['/sessions']);
    expect(pathChain('/sessions/x/terminal')).toEqual(['/sessions', '/sessions/x/terminal']);
    expect(pathChain('/more/history')).toEqual(['/more', '/more/history']);
    expect(pathChain('/more/gallery')).toEqual(['/more', '/more/about', '/more/gallery']);
    expect(pathChain('/sessions/x/changes/2')).toEqual(['/sessions', '/sessions/x/changes', '/sessions/x/changes/2']);
  });

  it('stacks Info over its session, and an Info screen over Info', () => {
    expect(pathChain('/sessions/x/info')).toEqual(['/sessions', '/sessions/x/chat', '/sessions/x/info']);
    expect(pathChain('/sessions/x/info/notes')).toEqual(['/sessions', '/sessions/x/chat', '/sessions/x/info', '/sessions/x/info/notes']);
  });

  it('stacks a settings page over Settings', () => {
    for (const page of SETTINGS_SECTIONS) {
      expect(pathChain(`/more/settings/${page}`)).toEqual(['/more', '/more/settings', `/more/settings/${page}`]);
    }
    expect(pathChain('/more/phone')).toEqual(['/more', '/more/phone']);
    expect(pathChain('/more/saved-prompts')).toEqual(['/more', '/more/saved-prompts']);
  });
});

describe('the ?m= URL form', () => {
  it('reads the path back, ignoring an invalid one', () => {
    expect(phonePathFromSearch('?m=/sessions/s1/chat')).toBe('/sessions/s1/chat');
    expect(phonePathFromSearch('?theme=light&m=%2Fmore%2Fgallery')).toBe('/more/gallery');
    expect(phonePathFromSearch('?m=/nope')).toBeNull();
    expect(phonePathFromSearch('')).toBeNull();
  });

  it('writes it readably and keeps the other parameters', () => {
    expect(withPhonePath('http://mac:3333/?theme=light', '/sessions/s1/chat')).toBe('/?theme=light&m=/sessions/s1/chat');
    expect(withPhonePath('http://mac:3333/?m=/inbox#x', '/queue')).toBe('/?m=/queue#x');
    expect(withoutPhonePath('http://mac:3333/?theme=light&m=/queue')).toBe('/?theme=light');
    expect(withoutPhonePath('http://mac:3333/?m=/queue')).toBe('/');
  });
});

describe('old ?session=<id>&tab= links', () => {
  const idle = () => false;
  const waiting = () => true;

  it('open the chat, or the terminal when it was asked for', () => {
    expect(legacyDeepLinkToPath('?session=s1&tab=conversation', idle)).toBe('/sessions/s1/chat');
    expect(legacyDeepLinkToPath('?session=s1', idle)).toBe('/sessions/s1/chat');
    expect(legacyDeepLinkToPath('?session=s1&tab=terminal', idle)).toBe('/sessions/s1/terminal');
  });

  it('send an approval or a question to the chat, where the waiting card is', () => {
    // Today's shell maps approval / input taps to tab=terminal; the session still waiting says why.
    expect(legacyDeepLinkToPath('?session=s1&tab=terminal', waiting)).toBe('/sessions/s1/chat');
    expect(legacyDeepLinkToPath('?session=s1&tab=terminal&kind=approval', idle)).toBe('/sessions/s1/chat');
    expect(legacyDeepLinkToPath('?session=s1&tab=terminal&kind=input', idle)).toBe('/sessions/s1/chat');
  });

  it('ignore a missing or malformed id', () => {
    expect(legacyDeepLinkToPath('', idle)).toBeNull();
    expect(legacyDeepLinkToPath('?tab=terminal', idle)).toBeNull();
    expect(legacyDeepLinkToPath('?session=a%20b', idle)).toBeNull();
  });
});

describe('defaultSegment', () => {
  it('opens Claude Code and Codex on the chat, anything else on the terminal', () => {
    expect(defaultSegment('claude')).toBe('chat');
    expect(defaultSegment('codex')).toBe('chat');
    expect(defaultSegment(null)).toBe('terminal');
  });
});
