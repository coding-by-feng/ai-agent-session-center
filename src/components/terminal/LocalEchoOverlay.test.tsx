// LocalEchoOverlay.test.tsx — instant typing on a real xterm in jsdom. A key shows in the overlay before its
// echo, the overlay empties once the echo lands, and the guess never enters xterm's buffer.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';
import LocalEchoOverlay from './LocalEchoOverlay';

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

const terms: Terminal[] = [];
afterEach(() => {
  terms.splice(0).forEach((t) => t.dispose());
  document.body.innerHTML = '';
});

function openTerminal(): Terminal {
  const term = new Terminal({ cols: 40, rows: 10, theme: { background: '#101010', foreground: '#eeeeee' } });
  const host = document.createElement('div');
  document.body.appendChild(host);
  term.open(host);
  terms.push(term);
  return term;
}

const write = (term: Terminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve));

/** The overlay's guessed text, in order. */
const guessed = () => [...document.querySelectorAll('[data-local-echo-guess]')].map((el) => el.textContent).join('');

const bufferLine = (term: Terminal, row = 0) => term.buffer.active.getLine(row)?.translateToString(true) ?? '';

function mount(term: Terminal, enabled = true) {
  return render(<LocalEchoOverlay getTerminal={() => term} terminalId="t1" enabled={enabled} />);
}

/** A prompt whose first key ("a") has echoed, so the line is trusted. */
async function trustedPrompt(term: Terminal) {
  await act(async () => { await write(term, '❯ '); });
  act(() => { term.input('a'); });
  await act(async () => { await write(term, 'a'); });
}

describe('LocalEchoOverlay', () => {
  it('shows a key before its echo, and only in the overlay', async () => {
    const term = openTerminal();
    mount(term);
    await trustedPrompt(term);

    act(() => { term.input('b'); });
    expect(guessed()).toBe('b');
    expect(bufferLine(term)).toBe('❯ a'); // the guess is not in xterm's buffer

    await act(async () => { await write(term, 'b'); });
    expect(guessed()).toBe('');
    expect(bufferLine(term)).toBe('❯ ab');
  });

  it('draws inside the terminal screen and never takes the pointer', async () => {
    const term = openTerminal();
    mount(term);
    await trustedPrompt(term);
    act(() => { term.input('b'); });
    const layer = document.querySelector('[data-local-echo]') as HTMLElement;
    expect(term.element?.querySelector('.xterm-screen')?.contains(layer)).toBe(true);
    expect(layer.getAttribute('aria-hidden')).toBe('true');
  });

  it('never shows what a program does not echo, such as a password', async () => {
    const term = openTerminal();
    mount(term);
    await act(async () => { await write(term, 'Password: '); });
    act(() => { term.input('s'); term.input('e'); term.input('c'); });
    await act(async () => { await write(term, ''); });
    expect(guessed()).toBe('');
  });

  it.each(['\r\nPassword: ', '\r\x1b[2KPassword: '])('revokes trust when output changes the prompt without Enter (%j)', async (prompt) => {
    const term = openTerminal();
    mount(term);
    await trustedPrompt(term);
    await act(async () => { await write(term, prompt); });
    act(() => { term.input('synthetic-secret'); });
    expect(guessed()).toBe('');
    expect(bufferLine(term, term.buffer.active.cursorY)).not.toContain('synthetic-secret');
  });

  it('covers the program\'s faint suggestion text after the guesses', async () => {
    const term = openTerminal();
    mount(term);
    await trustedPrompt(term);
    // Claude's grey suggestion after the caret: faint text, then the cursor back to where typing goes.
    await act(async () => { await write(term, '\x1b[2mTry this\x1b[0m\x1b[8D'); });
    act(() => { term.input('b'); });
    const erase = document.querySelector('[data-local-echo-erase]') as HTMLElement | null;
    expect(erase).not.toBeNull();
  });

  it('draws nothing when instant typing is off', async () => {
    const term = openTerminal();
    mount(term, false);
    await trustedPrompt(term);
    act(() => { term.input('b'); });
    expect(document.querySelector('[data-local-echo]')).toBeNull();
  });

  it('drops its guesses when the terminal is resized', async () => {
    const term = openTerminal();
    mount(term);
    await trustedPrompt(term);
    act(() => { term.input('b'); });
    act(() => { term.resize(30, 10); });
    expect(guessed()).toBe('');
  });

  it('stops listening when unmounted', async () => {
    const term = openTerminal();
    const view = mount(term);
    await trustedPrompt(term);
    view.unmount();
    act(() => { term.input('b'); });
    expect(document.querySelector('[data-local-echo]')).toBeNull();
  });
});
