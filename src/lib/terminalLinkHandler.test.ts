import { afterEach, describe, expect, it, vi } from 'vitest';
import { openTerminalUrl, TERMINAL_LINK_HANDLER } from './terminalLinkHandler';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('terminal link handling', () => {
  it('opens long OAuth links directly without xterm confirmation', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const confirm = vi.spyOn(window, 'confirm');
    const oauthUrl = 'https://claude.com/cai/oauth/authorize?code=true&state=exact-state';

    TERMINAL_LINK_HANDLER.activate(
      new MouseEvent('click'),
      oauthUrl,
      { start: { x: 1, y: 1 }, end: { x: 80, y: 1 } },
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(oauthUrl, '_blank', 'noopener,noreferrer');
  });

  it('rejects malformed and non-HTTP protocols', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    expect(openTerminalUrl('javascript:alert(1)')).toBe(false);
    expect(openTerminalUrl('file:///tmp/secret')).toBe(false);
    expect(openTerminalUrl('not a URL')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps xterm non-HTTP protocol delivery disabled', () => {
    expect(TERMINAL_LINK_HANDLER.allowNonHttpProtocols).toBe(false);
  });
});
