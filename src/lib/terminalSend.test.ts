import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendPromptToTerminal, SUBMIT_ENTER_DELAY_MS } from './terminalSend';

describe('sendPromptToTerminal', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const bodyOf = (call: number): unknown =>
    JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);

  it('without auto-enter: writes the text once and sends no Enter', async () => {
    const ok = await sendPromptToTerminal('term-1', 'hello world', false, 0);
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/terminals/term-1/write');
    expect(bodyOf(0)).toEqual({ data: 'hello world' });
  });

  it('with auto-enter: writes the text, then a STANDALONE \\r as a separate write', async () => {
    // Regression guard for the "typed but not submitted" bug: the submit carriage
    // return must NEVER be concatenated onto the prompt text (old behaviour was a
    // single write of `text + "\r"`, which CLI TUIs treat as a paste).
    const ok = await sendPromptToTerminal('term-1', 'line1\nline2', true, 0);
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(0)).toEqual({ data: 'line1\nline2' });
    expect(bodyOf(1)).toEqual({ data: '\r' });
  });

  it('does not send the Enter keystroke if the text write fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    const ok = await sendPromptToTerminal('term-1', 'hello', true, 0);
    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports failure when the Enter write fails', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true }) // text
      .mockResolvedValueOnce({ ok: false }); // enter
    const ok = await sendPromptToTerminal('term-1', 'hello', true, 0);
    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses a non-zero default submit delay', () => {
    expect(SUBMIT_ENTER_DELAY_MS).toBeGreaterThan(0);
  });
});
