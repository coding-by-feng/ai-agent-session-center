// peekScreen.test.ts — the chat's terminal peek (AASC-41): the last lines of a
// terminal's output as plain text, with the redraws a TUI makes (carriage return,
// cursor up, erase line) applied rather than piled up, and no xterm instance.
import { describe, it, expect } from 'vitest';
import { PeekScreen } from './peekScreen';

describe('PeekScreen', () => {
  it('keeps the last lines, colours stripped', () => {
    const s = new PeekScreen();
    s.write('\x1b[38;5;214m●\x1b[0m Bash(npm test)\r\n  ⎿  Running…\r\n');
    expect(s.lastLines(3)).toEqual(['● Bash(npm test)', '  ⎿  Running…']);
  });

  it('overwrites a line after a carriage return (a spinner)', () => {
    const s = new PeekScreen();
    s.write('⠋ Thinking (1s)\r⠙ Thinking (2s)');
    expect(s.lastLines(3)).toEqual(['⠙ Thinking (2s)']);
    s.write('\rxy');
    expect(s.lastLines(3)).toEqual(['xyThinking (2s)']);
  });

  it('applies an erase-and-move-up redraw instead of stacking frames', () => {
    const s = new PeekScreen();
    s.write('frame one a\r\nframe one b\r\n');
    // Ink's eraseLines(3): erase the line, up one, repeated; then draw again.
    s.write('\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G');
    s.write('frame two a\r\nframe two b\r\n');
    expect(s.lastLines(5)).toEqual(['frame two a', 'frame two b']);
  });

  it('erases to the end of the line and of the screen', () => {
    const s = new PeekScreen();
    s.write('hello world\r\nsecond\r\nthird');
    s.write('\x1b[1A\x1b[3G\x1b[J');
    expect(s.lastLines(5)).toEqual(['hello world', 'se']);
    s.write('\x1b[1A\x1b[6G\x1b[K!');
    expect(s.lastLines(5)).toEqual(['hello!', 'se']);
  });

  it('survives an escape sequence split across writes', () => {
    const s = new PeekScreen();
    s.write('abc\x1b[3');
    s.write('8;5;1mdef\x1b[0m\r\n');
    expect(s.lastLines(2)).toEqual(['abcdef']);
  });

  it('drops OSC titles and keeps only the newest lines', () => {
    const s = new PeekScreen(5);
    s.write('\x1b]0;claude\x07');
    for (let i = 0; i < 20; i += 1) s.write(`line ${i}\r\n`);
    expect(s.lastLines(3)).toEqual(['line 17', 'line 18', 'line 19']);
    expect(s.lineCount()).toBeLessThanOrEqual(6);
  });

  it('skips blank lines at the end and trims trailing spaces', () => {
    const s = new PeekScreen();
    s.write('one   \r\n\r\n\r\n');
    expect(s.lastLines(3)).toEqual(['one']);
  });

  it('starts over on a full clear', () => {
    const s = new PeekScreen();
    s.write('old\r\n\x1b[2J\x1b[Hnew');
    expect(s.lastLines(3)).toEqual(['new']);
  });
});
