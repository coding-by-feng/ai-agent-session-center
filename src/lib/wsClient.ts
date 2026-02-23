import type { ClientMessage, ServerMessage } from '@/types';

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

  constructor(options: WsClientOptions) {
    this.options = options;
  }

  connect(): void {
    if (this.disposed) return;

    const url = new URL(this.options.url, window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (this.options.token) {
      url.searchParams.set('token', this.options.token);
    }

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

  getLastSeq(): number {
    return this.lastSeq;
  }

  dispose(): void {
    this.disposed = true;
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
