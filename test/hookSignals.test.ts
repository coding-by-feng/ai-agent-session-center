// test/hookSignals.test.ts — AASC-42: the Mac confirms a phone's prompt from the hooks
// themselves, so a processed hook is announced per terminal. The announcement is the
// hook pipeline's hot path: no listener means no work, and a listener that throws must
// never break hook processing.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));
const handleEvent = vi.hoisted(() => vi.fn());
vi.mock('../server/sessionStore.js', () => ({ handleEvent }));
vi.mock('../server/wsManager.js', () => ({ broadcast: vi.fn() }));

import { onTerminalHook, emitTerminalHook, _resetHookSignalsForTests } from '../server/hookSignals.js';
import { processHookEvent } from '../server/hookProcessor.js';

beforeEach(() => {
  _resetHookSignalsForTests();
  handleEvent.mockReset();
});

describe('onTerminalHook', () => {
  it('tells only the listeners of that terminal, with the event and the session after it', () => {
    const mine = vi.fn();
    const other = vi.fn();
    onTerminalHook('term-1', mine);
    onTerminalHook('term-2', other);
    emitTerminalHook('UserPromptSubmit', { sessionId: 's1', terminalId: 'term-1', status: 'prompting', userCancelledAt: null });
    expect(mine).toHaveBeenCalledWith({
      event: 'UserPromptSubmit', sessionId: 's1', terminalId: 'term-1', status: 'prompting', userCancelledAt: null,
    });
    expect(other).not.toHaveBeenCalled();
  });

  it('stops telling a listener once it unsubscribes', () => {
    const cb = vi.fn();
    const off = onTerminalHook('term-1', cb);
    off();
    emitTerminalHook('Stop', { sessionId: 's1', terminalId: 'term-1', status: 'waiting' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('ignores a session with no terminal', () => {
    const cb = vi.fn();
    onTerminalHook('term-1', cb);
    emitTerminalHook('Stop', { sessionId: 's1', terminalId: null, status: 'waiting' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('keeps telling the others when one listener throws', () => {
    const after = vi.fn();
    onTerminalHook('term-1', () => { throw new Error('boom'); });
    onTerminalHook('term-1', after);
    expect(() => emitTerminalHook('Stop', { sessionId: 's1', terminalId: 'term-1', status: 'waiting' })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('lets a listener unsubscribe while it is being told', () => {
    const second = vi.fn();
    const off = onTerminalHook('term-1', () => off());
    onTerminalHook('term-1', second);
    emitTerminalHook('Stop', { sessionId: 's1', terminalId: 'term-1', status: 'waiting' });
    emitTerminalHook('Stop', { sessionId: 's1', terminalId: 'term-1', status: 'waiting' });
    expect(second).toHaveBeenCalledTimes(2);
  });
});

describe('processHookEvent announces each processed hook', () => {
  it('names the terminal of the session the hook landed on', () => {
    handleEvent.mockReturnValue({ session: { sessionId: 's1', terminalId: 'term-9', status: 'prompting', userCancelledAt: null } });
    const cb = vi.fn();
    onTerminalHook('term-9', cb);
    processHookEvent({ session_id: 's1', hook_event_name: 'UserPromptSubmit' } as never);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ event: 'UserPromptSubmit', sessionId: 's1', terminalId: 'term-9' }));
  });

  it('announces nothing for a hook that matched no session', () => {
    handleEvent.mockReturnValue(null);
    const cb = vi.fn();
    onTerminalHook('term-9', cb);
    processHookEvent({ session_id: 's1', hook_event_name: 'Stop' } as never);
    expect(cb).not.toHaveBeenCalled();
  });
});
