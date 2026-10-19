import type { ClientMessage, ServerMessage } from '@/types';
import { isNativeMobileApp } from '@/lib/platform';
import { getClientId, getClientLabel } from './deviceIdentity';

type MessageHandler = (msg: ServerMessage) => void;
type StatusHandler = (status: 'connected' | 'disconnected' | 'reconnecting') => void;

interface WsClientOptions {
  url: string;
  token?: string | null;
  onMessage: MessageHandler;
  onStatus: StatusHandler;
}

const BASE_DELAY = 1000;
const MAX_DELAY = 10000;

export class WsClient {
  private ws: WebSocket | null = null;
  private options: WsClientOptions;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private lastSeq = 0;
  private wakeListening = false;
  /** The server refused our token (4001): waking must not retry it. An explicit connect clears it. */
  private authRefused = false;

  /**
   * Back in view, or back online: reconnect now rather than at the next back-off
   * step. A phone app's socket dies while it sleeps in the background, and the
   * back-off had grown to its 10 s cap by then, so every return to the app showed
   * "Reconnecting…" for up to 10 s (e2e run 5, F3). `reconnectNow` leaves an open
   * or connecting socket alone.
   */
  private readonly onWake = (): void => {
    if (this.authRefused || document.visibilityState !== 'visible') return;
    this.reconnectNow();
  };

  constructor(options: WsClientOptions) {
    this.options = options;
  }

  connect(): void {
    if (this.disposed) return;
    this.authRefused = false;
    if (!this.wakeListening) {
      this.wakeListening = true;
      document.addEventListener('visibilitychange', this.onWake);
      window.addEventListener('online', this.onWake);
    }

    const url = new URL(this.options.url, window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    // Never in the phone app: its session is the HttpOnly cookie, and on the
    // Cloudflare path a URL can end up in edge logs (AASC-17).
    if (this.options.token && !isNativeMobileApp()) {
      url.searchParams.set('token', this.options.token);
    }
    // Identify this device to the server's presence layer. It has to ride on
    // the URL: the server sends its snapshot and registers presence inside the
    // connection handler, so a post-connect hello message would arrive too late
    // to be reflected in the snapshot this socket receives.
    url.searchParams.set('clientId', getClientId());
    url.searchParams.set('label', getClientLabel());

    this.ws = new WebSocket(url.toString());

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.options.onStatus('connected');

      // Request replay of missed events on reconnect
      if (this.lastSeq > 0) {
        this.send({ type: 'replay', sinceSeq: this.lastSeq });
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;

        // Track sequence number from snapshots
        if (msg.type === 'snapshot' && 'seq' in msg) {
          this.lastSeq = msg.seq;
        }

        this.options.onMessage(msg);
      } catch {
        // Ignore unparseable messages
      }
    };

    this.ws.onclose = (event) => {
      if (this.disposed) return;

      // Auth failure -- don't reconnect
      if (event.code === 4001) {
        this.authRefused = true;
        this.options.onStatus('disconnected');
        document.dispatchEvent(new CustomEvent('ws-auth-failed'));
        return;
      }

      this.options.onStatus('reconnecting');
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  // #81: Check bufferedAmount before sending to prevent backpressure buildup
  private static readonly MAX_BUFFERED = 64 * 1024; // 64KB threshold

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Skip non-critical messages when buffer is backed up
      if (this.ws.bufferedAmount > WsClient.MAX_BUFFERED && msg.type !== 'terminal_input') {
        return;
      }
      this.ws.send(JSON.stringify(msg));
    }
  }

  setToken(token: string | null): void {
    this.options.token = token;
  }

  /** Expose raw WebSocket for terminal relay (needs direct message access) */
  getRawSocket(): WebSocket | null {
    return this.ws;
  }

  /**
   * Connect now instead of at the next back-off step (the phone's pull to
   * refresh, AASC-18). Only once the old socket is fully closed: a no-op while
   * it is open or connecting (never drops a working connection) and while it is
   * closing (its onclose schedules the reconnect; connecting now as well would
   * leave two sockets).
   */
  reconnectNow(): void {
    if (this.disposed) return;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.connect();
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  dispose(): void {
    this.disposed = true;
    document.removeEventListener('visibilitychange', this.onWake);
    window.removeEventListener('online', this.onWake);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;

    const delay = Math.min(BASE_DELAY * Math.pow(2, this.reconnectAttempt), MAX_DELAY);
    this.reconnectAttempt++;

    this.options.onStatus('reconnecting');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
