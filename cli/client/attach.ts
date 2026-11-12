/**
 * `aasc attach` (plan §9.6–§9.7): this terminal becomes a window on a session's PTY.
 *
 *   stdin (raw)  ── terminal_input ──▶  PTY        Ctrl-] detaches; Ctrl-] twice types one
 *   stdout       ◀─ terminal_output ──  PTY        raw bytes (base64 on the wire)
 *   SIGWINCH     ── terminal_resize ──▶ PTY size   cols ≤ 500, rows ≤ 200
 *
 * The size (Q4): the attached client sets the size, tmux-style, and the last one to act
 * wins. A terminal_geometry that isn't the echo of our own resize means another device
 * resized: we never answer it with a resize (that's how two clients fight), we only note
 * it in the window title, and our next keystroke sends our size before itself.
 *
 * Every way out (Ctrl-], terminal_closed, a lost socket, the process exiting) restores
 * the terminal: alternate screen off, cursor on, mouse tracking and bracketed paste off,
 * attributes reset, raw mode off. Leftover mouse tracking after a TUI's alternate screen
 * is a bug this app has hit before (Codex /logout).
 */
import WebSocket from 'ws';
import { StringDecoder } from 'string_decoder';
import { cleanText } from './sanitize.js';

export const RESTORE_SEQUENCE =
  '\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[0m';
/** Our own alternate screen, so the shell's screen comes back intact on detach. Entered only once raw mode is on. */
const ENTER_SCREEN = '\x1b[?1049h\x1b[H\x1b[2J';

const ESCAPE_KEY = '\x1d'; // Ctrl-]
/** = the server's terminal_resize limits (wsManager.ts). */
export const MAX_COLS = 500;
export const MAX_ROWS = 200;
/**
 * Characters per terminal_input frame. The server takes ≤ 262 144 characters of data in a
 * frame of ≤ 512 KB of JSON; 64 K keeps even an all-control-character paste (6× when
 * JSON-escaped) under that.
 */
export const INPUT_CHUNK_CHARS = 65_536;
/** How long a lone Ctrl-] waits for a second one before it detaches. */
const ESCAPE_WINDOW_MS = 400;
/**
 * Input frames are coalesced to at most one per this many ms: the server closes a socket
 * past 100 messages a second, and mouse motion in a TUI can produce more than that.
 */
const INPUT_THROTTLE_MS = 20;
/** The server sends the PTY's geometry right after a subscribe; this long without it, go on anyway. */
const GEOMETRY_WAIT_MS = 1500;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Server → client frames can carry a large replay ring (base64). */
const MAX_PAYLOAD = 64 * 1024 * 1024;

export interface Size { cols: number; rows: number }

export interface AttachIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(mode: boolean): unknown };
  stdout: { write(chunk: string | Uint8Array): boolean };
  /** This terminal's size now. */
  size(): Size;
  /** Called on SIGWINCH; returns the unsubscribe. */
  onResize(cb: () => void): () => void;
  /** Called when the process is exiting, however; returns the unregister. */
  onExit(cb: () => void): () => void;
}

export interface AttachOptions {
  url: string;
  headers: Record<string, string>;
  terminalId: string;
  io: AttachIo;
  escapeWindowMs?: number;
  inputThrottleMs?: number;
  geometryWaitMs?: number;
}

export type AttachReason = 'detached' | 'closed' | 'unavailable' | 'lost' | 'refused';

export interface AttachResult {
  code: number;
  reason: AttachReason;
  message?: string;
}

/**
 * The WebSocket URL: identity in the query (the server reads it at upgrade), the token only in
 * a header. With `socketPath` (the SSH tunnel's local end) it's ws's IPC form,
 * `ws+unix://<socket>:/?…`.
 */
export function buildWsUrl(origin: string, ident: { clientId: string; label: string }, socketPath?: string): string {
  const query = new URLSearchParams({ clientId: ident.clientId, label: ident.label, role: 'cli' }).toString();
  if (socketPath) return `ws+unix://${socketPath}:/?${query}`;
  const u = new URL(origin);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/';
  u.search = query;
  u.hash = '';
  return u.toString();
}

/** A client socket as aasc opens them: no redirects, a handshake deadline, Host: localhost through a Unix socket. */
export function openWebSocket(url: string, headers: Record<string, string>): WebSocket {
  return new WebSocket(url, {
    headers: url.startsWith('ws+unix:') ? { Host: 'localhost', ...headers } : headers,
    followRedirects: false,
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    maxPayload: MAX_PAYLOAD,
  });
}

export function clampSize(size: Size): Size {
  const clamp = (v: number, max: number): number => (Number.isFinite(v) ? Math.min(max, Math.max(1, Math.floor(v))) : 80);
  return { cols: clamp(size.cols, MAX_COLS), rows: clamp(size.rows, MAX_ROWS) };
}

const sameSize = (a: Size | null, b: Size | null): boolean => !!a && !!b && a.cols === b.cols && a.rows === b.rows;

/** Split into frames of at most `max` UTF-16 units without cutting a surrogate pair. */
export function chunkInput(text: string, max: number = INPUT_CHUNK_CHARS): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + max);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

const oneLine = (text: string): string => cleanText(text).slice(0, 120);

export function attach(opts: AttachOptions): Promise<AttachResult> {
  const { io, terminalId } = opts;
  const escapeWindowMs = opts.escapeWindowMs ?? ESCAPE_WINDOW_MS;
  const throttleMs = opts.inputThrottleMs ?? INPUT_THROTTLE_MS;

  return new Promise((resolve) => {
    const ws = openWebSocket(opts.url, opts.headers);
    const decoder = new StringDecoder('utf8');

    let phase: 'connecting' | 'waiting-geometry' | 'attached' | 'done' = 'connecting';
    let ours = clampSize(io.size());
    let ptySize: Size | null = null;
    let driving = false;
    /** Sizes we sent whose terminal_geometry echo hasn't come back yet. */
    let pendingEchoes: Size[] = [];
    let screenEntered = false;
    let rawOn = false;
    let restored = false;
    let titleTouched = false;
    let lastError: string | null = null;
    let escapeTimer: ReturnType<typeof setTimeout> | null = null;
    let geometryTimer: ReturnType<typeof setTimeout> | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingInput = '';
    /** Output that arrives before we're attached (the replay): written after our screen is up. */
    let heldOutput: Buffer[] = [];
    let lastFlushAt = 0;
    let unResize: () => void = () => {};

    const send = (msg: Record<string, unknown>): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    const setTitle = (text: string): void => {
      titleTouched = true;
      io.stdout.write(`\x1b]2;${oneLine(text)}\x07`);
    };

    const sendResize = (size: Size): void => {
      pendingEchoes = [...pendingEchoes.slice(-7), size];
      send({ type: 'terminal_resize', terminalId, cols: size.cols, rows: size.rows });
    };

    /** We act, so we set the size (Q4). */
    const takeSize = (): void => {
      ours = clampSize(io.size());
      sendResize(ours);
      if (!driving && titleTouched) setTitle('aasc');
      driving = true;
    };

    const restore = (): void => {
      if (restored) return;
      restored = true;
      io.stdout.write(RESTORE_SEQUENCE + (titleTouched ? '\x1b]2;\x07' : ''));
      if (rawOn && typeof io.stdin.setRawMode === 'function') {
        try { io.stdin.setRawMode(false); } catch { /* the tty is already gone */ }
      }
      rawOn = false;
    };
    const unExit = io.onExit(restore);

    const flush = (): void => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!pendingInput) return;
      const text = pendingInput;
      pendingInput = '';
      lastFlushAt = Date.now();
      for (const data of chunkInput(text)) send({ type: 'terminal_input', terminalId, data });
    };

    const queueInput = (text: string): void => {
      if (!text || phase !== 'attached') return;
      if (!driving) {
        flush();
        takeSize();
      }
      pendingInput += text;
      const wait = throttleMs - (Date.now() - lastFlushAt);
      if (wait <= 0) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, wait);
    };

    const onStdin = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let run = '';
      for (const ch of text) {
        if (phase !== 'attached') return;
        if (escapeTimer) {
          clearTimeout(escapeTimer);
          escapeTimer = null;
          if (ch === ESCAPE_KEY) {
            run += ESCAPE_KEY; // Ctrl-] twice: one literal Ctrl-]
            continue;
          }
          // Ctrl-] then anything else: detach (that key is not sent).
          queueInput(run);
          finish({ code: 0, reason: 'detached' });
          return;
        }
        if (ch === ESCAPE_KEY) {
          queueInput(run);
          run = '';
          escapeTimer = setTimeout(() => {
            escapeTimer = null;
            finish({ code: 0, reason: 'detached' });
          }, escapeWindowMs);
          continue;
        }
        run += ch;
      }
      queueInput(run);
    };

    const onResize = (): void => {
      if (phase !== 'attached') return;
      takeSize();
    };

    const begin = (): void => {
      if (phase !== 'waiting-geometry') return;
      phase = 'attached';
      if (geometryTimer) { clearTimeout(geometryTimer); geometryTimer = null; }
      ours = clampSize(io.size());
      if (sameSize(ptySize, ours)) {
        // Same size already: a resize would change nothing, so nudge it to make a TUI redraw
        // over the half-replayed frames.
        sendResize({ cols: ours.cols > 1 ? ours.cols - 1 : ours.cols + 1, rows: ours.rows });
      }
      sendResize(ours);
      driving = true;
      if (io.stdin.isTTY && typeof io.stdin.setRawMode === 'function') {
        io.stdin.setRawMode(true);
        rawOn = true;
      }
      screenEntered = true;
      io.stdout.write(ENTER_SCREEN);
      for (const chunk of heldOutput) io.stdout.write(chunk);
      heldOutput = [];
      io.stdin.on('data', onStdin);
      io.stdin.resume();
      unResize = io.onResize(onResize);
    };

    const onGeometry = (size: Size): void => {
      ptySize = size;
      if (phase === 'waiting-geometry') { begin(); return; }
      if (phase !== 'attached') return;
      const echo = pendingEchoes.findIndex((s) => sameSize(s, size));
      if (echo >= 0) {
        pendingEchoes = pendingEchoes.slice(echo + 1);
        return;
      }
      if (sameSize(size, ours)) {
        if (!driving && titleTouched) setTitle('aasc');
        driving = true;
        return;
      }
      // Another device resized. Don't answer: wait for our next keystroke.
      driving = false;
      setTitle(`aasc · sized by another device ${size.cols}×${size.rows} · type to take it back`);
    };

    function finish(result: AttachResult): void {
      if (phase === 'done') return;
      const wasAttached = phase === 'attached' || phase === 'waiting-geometry';
      phase = 'done';
      for (const t of [escapeTimer, geometryTimer, flushTimer]) if (t) clearTimeout(t);
      if (result.reason === 'detached') flush();
      if (wasAttached && ws.readyState === WebSocket.OPEN) {
        send({ type: 'terminal_disconnect', terminalId });
      }
      try { ws.close(1000); } catch { /* already closed */ }
      io.stdin.off('data', onStdin);
      io.stdin.pause();
      unResize();
      if (screenEntered || rawOn) restore();
      unExit();
      resolve(lastError && !result.message ? { ...result, message: lastError } : result);
    }

    ws.on('open', () => {
      phase = 'waiting-geometry';
      send({ type: 'terminal_subscribe', terminalId });
      geometryTimer = setTimeout(begin, opts.geometryWaitMs ?? GEOMETRY_WAIT_MS);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.terminalId !== undefined && msg.terminalId !== terminalId) return;
      switch (msg.type) {
        case 'terminal_output':
          if (typeof msg.data !== 'string') break;
          if (phase === 'attached') io.stdout.write(Buffer.from(msg.data, 'base64'));
          else if (phase === 'waiting-geometry') heldOutput.push(Buffer.from(msg.data, 'base64'));
          break;
        case 'terminal_geometry':
          if (Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
            onGeometry({ cols: msg.cols as number, rows: msg.rows as number });
          }
          break;
        case 'terminal_closed': {
          const reason = typeof msg.reason === 'string' ? msg.reason : '';
          if (phase === 'waiting-geometry' || reason === 'unavailable' || reason === 'hidden') {
            finish({ code: 4, reason: 'unavailable', message: 'That session’s terminal isn’t available to this computer.' });
          } else {
            finish({ code: 0, reason: 'closed', message: 'The session’s terminal closed.' });
          }
          break;
        }
        case 'control_denied':
          setTitle(`aasc · ${typeof msg.by === 'string' ? oneLine(msg.by) : 'another device'} has control`);
          break;
        case 'terminal_error':
          if (typeof msg.error === 'string') lastError = oneLine(msg.error);
          break;
        default:
          break;
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      finish(status === 401 || status === 403
        ? { code: 3, reason: 'refused', message: `The server refused this computer (${status}).` }
        : { code: 2, reason: 'lost', message: `The server answered ${status} instead of opening a connection.` });
    });

    ws.on('close', (code: number) => {
      if (code === 4001 || code === 4003) {
        finish({ code: 3, reason: 'refused', message: 'The server refused this computer’s sign-in.' });
        return;
      }
      if (code === 4004) {
        finish({ code: 2, reason: 'lost', message: 'The server closed the connection: too many messages.' });
        return;
      }
      finish({ code: 2, reason: 'lost', message: 'Lost the connection to the server.' });
    });

    ws.on('error', () => {
      finish({ code: 2, reason: 'lost', message: 'Lost the connection to the server.' });
    });
  });
}
