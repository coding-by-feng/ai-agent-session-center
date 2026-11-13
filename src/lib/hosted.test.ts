import { afterEach, expect, it, vi } from 'vitest';
import { queuePopoutUrl } from './queuePopout';
import { openTerminalPopupFallback } from './popoutTerminalWindow';
afterEach(() => {
  document.querySelector('meta[name="aasc-ui-base"]')?.remove();
  vi.restoreAllMocks();
});
it('keeps queue and terminal windows in the current hosted edition', () => {
  const meta = document.createElement('meta');
  meta.name = 'aasc-ui-base';
  meta.content = '/ui/full';
  document.head.append(meta);
  expect(queuePopoutUrl('session-one')).toBe('/ui/full/?popout=queue&sessionId=session-one');
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  openTerminalPopupFallback({ terminalId: 'pty-one', originSessionId: 'session-one' });
  expect(open.mock.calls[0][0]).toBe(
    '/ui/full/?popout=terminal&terminalId=pty-one&originSessionId=session-one',
  );
});
