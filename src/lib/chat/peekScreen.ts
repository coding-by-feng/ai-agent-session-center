/**
 * peekScreen.ts — the chat's terminal peek (AASC-41): a terminal's last lines as
 * plain text, kept without an xterm instance.
 *
 * Not a terminal emulator: just enough of one that a TUI's redraws replace what
 * they redraw instead of piling up — carriage return, line feed, cursor moves
 * (up / down / column / position), erase in line and in display, save / restore.
 * Colours and every other escape are dropped. Columns count UTF-16 units, which
 * is close enough for a three-line glance.
 *
 * Fed straight from the terminal stream (`terminal_output`, base64 → UTF-8 text
 * via a streaming TextDecoder in the caller); an escape split across two chunks is
 * held until the rest arrives.
 */

const ESC = '\x1b';
/** An unterminated OSC / DCS longer than this is junk, not a sequence still arriving. */
const MAX_PENDING = 4096;

export class PeekScreen {
  private lines: string[] = [''];
  private row = 0;
  private col = 0;
  private saved: { row: number; col: number } | null = null;
  private pending = '';

  /**
   * @param maxLines lines kept (older ones scroll away)
   * @param rows     the screen's height, for absolute cursor positions (counted from the bottom of what is kept)
   */
  constructor(private readonly maxLines = 200, private readonly rows = 40) {}

  write(chunk: string): void {
    const data = this.pending + chunk;
    this.pending = '';
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === ESC) {
        const used = this.escape(data, i);
        if (used < 0) {
          const rest = data.slice(i);
          if (rest.length <= MAX_PENDING) this.pending = rest;
          break;
        }
        i += used;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) {
        this.control(ch);
        i += 1;
        continue;
      }
      let end = i + 1;
      while (end < data.length) {
        const c = data.charCodeAt(end);
        if (c < 0x20 || c === 0x7f) break;
        end += 1;
      }
      this.print(data.slice(i, end));
      i = end;
    }
    this.trim();
  }

  /** The last `n` lines, trailing blank lines skipped, trailing spaces trimmed. */
  lastLines(n: number): string[] {
    let end = this.lines.length;
    while (end > 0 && this.lines[end - 1].trim() === '') end -= 1;
    return this.lines.slice(Math.max(0, end - n), end).map((l) => l.replace(/\s+$/, ''));
  }

  lineCount(): number {
    return this.lines.length;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private ensureRow(): void {
    while (this.lines.length <= this.row) this.lines.push('');
  }

  private print(text: string): void {
    this.ensureRow();
    const line = this.lines[this.row];
    const head = line.length >= this.col ? line.slice(0, this.col) : line.padEnd(this.col, ' ');
    this.lines[this.row] = head + text + line.slice(this.col + text.length);
    this.col += text.length;
  }

  private control(ch: string): void {
    switch (ch) {
      case '\r':
        this.col = 0;
        break;
      case '\n':
        this.row += 1;
        this.ensureRow();
        break;
      case '\b':
        this.col = Math.max(0, this.col - 1);
        break;
      case '\t':
        this.col = (Math.floor(this.col / 8) + 1) * 8;
        break;
      default:
        break;
    }
  }

  private screenTop(): number {
    return Math.max(0, this.lines.length - this.rows);
  }

  /** Characters consumed by the escape at `i`, or -1 when it isn't complete yet. */
  private escape(data: string, i: number): number {
    if (i + 1 >= data.length) return -1;
    const kind = data[i + 1];
    if (kind === '[') {
      let j = i + 2;
      while (j < data.length) {
        const c = data.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) break;
        j += 1;
      }
      if (j >= data.length) return -1;
      this.csi(data.slice(i + 2, j), data[j]);
      return j - i + 1;
    }
    if (kind === ']' || kind === 'P' || kind === '^' || kind === '_') {
      for (let j = i + 2; j < data.length; j += 1) {
        if (data[j] === '\x07') return j - i + 1;
        if (data[j] === ESC && data[j + 1] === '\\') return j - i + 2;
      }
      return -1;
    }
    if (kind === '(' || kind === ')' || kind === '*' || kind === '+' || kind === '#') {
      return i + 2 < data.length ? 3 : -1;
    }
    if (kind === '7') this.saved = { row: this.row, col: this.col };
    else if (kind === '8' && this.saved) ({ row: this.row, col: this.col } = this.saved);
    else if (kind === 'M') this.row = Math.max(0, this.row - 1);
    return 2;
  }

  private csi(params: string, final: string): void {
    const nums = params.replace(/^[?>=]/, '').split(';').map((p) => Number.parseInt(p, 10));
    const n = (k: number, fallback: number) => (Number.isFinite(nums[k]) && nums[k] > 0 ? nums[k] : fallback);
    const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
    switch (final) {
      case 'A':
        this.row = Math.max(0, this.row - n(0, 1));
        break;
      case 'B':
        this.row += n(0, 1);
        this.ensureRow();
        break;
      case 'C':
        this.col += n(0, 1);
        break;
      case 'D':
        this.col = Math.max(0, this.col - n(0, 1));
        break;
      case 'E':
        this.row += n(0, 1);
        this.col = 0;
        this.ensureRow();
        break;
      case 'F':
        this.row = Math.max(0, this.row - n(0, 1));
        this.col = 0;
        break;
      case 'G':
      case '`':
        this.col = n(0, 1) - 1;
        break;
      case 'H':
      case 'f':
        this.row = this.screenTop() + n(0, 1) - 1;
        this.col = n(1, 1) - 1;
        this.ensureRow();
        break;
      case 'd':
        this.row = this.screenTop() + n(0, 1) - 1;
        this.ensureRow();
        break;
      case 'K':
        this.eraseLine(mode);
        break;
      case 'J':
        this.eraseDisplay(mode);
        break;
      case 'X': {
        this.ensureRow();
        const line = this.lines[this.row];
        if (line.length > this.col) {
          const count = Math.min(n(0, 1), line.length - this.col);
          this.lines[this.row] = line.slice(0, this.col) + ' '.repeat(count) + line.slice(this.col + count);
        }
        break;
      }
      case 'P': {
        this.ensureRow();
        const line = this.lines[this.row];
        this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + n(0, 1));
        break;
      }
      case 's':
        this.saved = { row: this.row, col: this.col };
        break;
      case 'u':
        if (this.saved) ({ row: this.row, col: this.col } = this.saved);
        break;
      default:
        break; // colours (m), modes (h / l), scroll regions (r)…
    }
  }

  private eraseLine(mode: number): void {
    this.ensureRow();
    const line = this.lines[this.row];
    if (mode === 0) this.lines[this.row] = line.slice(0, this.col);
    else if (mode === 1) this.lines[this.row] = ' '.repeat(Math.min(this.col + 1, line.length)) + line.slice(this.col + 1);
    else this.lines[this.row] = '';
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.lines = [''];
      this.row = 0;
      this.col = 0;
      return;
    }
    if (mode === 0) {
      this.ensureRow();
      this.lines[this.row] = this.lines[this.row].slice(0, this.col);
      this.lines.length = this.row + 1;
    }
  }

  private trim(): void {
    const extra = this.lines.length - this.maxLines;
    if (extra <= 0) return;
    this.lines.splice(0, extra);
    this.row = Math.max(0, this.row - extra);
    if (this.saved) this.saved = { row: Math.max(0, this.saved.row - extra), col: this.saved.col };
  }
}
