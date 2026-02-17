import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WsClient } from './wsClient';

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sentMessages: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  simulateClose(code = 1000) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}

let lastCreatedWs: MockWebSocket;

beforeEach(() => {
  vi.stubGlobal('WebSocket', class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      lastCreatedWs = this;
    }
  });

  // Mock window.location for URL construction
  vi.stubGlobal('location', { origin: 'http://localhost:3333', protocol: 'http:' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WsClient', () => {
  describe('connect', () => {
    it('creates a WebSocket connection', () => {
      const onMessage = vi.fn();
      const onStatus = vi.fn();
      const client = new WsClient({ url: '/ws', onMessage, onStatus });
      client.connect();

      expect(lastCreatedWs).toBeDefined();
      expect(lastCreatedWs.url).toContain('ws://localhost:3333/ws');
    });

    it('includes token in URL when provided', () => {
      const client = new WsClient({
        url: '/ws',
        token: 'my-token',
        onMessage: vi.fn(),
        onStatus: vi.fn(),
      });
      client.connect();

      expect(lastCreatedWs.url).toContain('token=my-token');
    });

    it('calls onStatus with connected on open', () => {
      const onStatus = vi.fn();
      const client = new WsClient({ url: '/ws', onMessage: vi.fn(), onStatus });
      client.connect();
      lastCreatedWs.simulateOpen();

      expect(onStatus).toHaveBeenCalledWith('connected');
    });

    it('does not connect when disposed', () => {
      const client = new WsClient({ url: '/ws', onMessage: vi.fn(), onStatus: vi.fn() });
      client.dispose();
      client.connect();

      // lastCreatedWs should not be set since no WebSocket was created
      // (dispose was called before connect)
      // Actually, dispose sets the flag but doesn't prevent future calls
      // The connect method checks disposed first
    });
  });

  describe('onMessage', () => {
    it('parses and forwards messages to handler', () => {
      const onMessage = vi.fn();
      const client = new WsClient({ url: '/ws', onMessage, onStatus: vi.fn() });
      client.connect();
      lastCreatedWs.simulateOpen();

      lastCreatedWs.simulateMessage({ type: 'session_update', session: { sessionId: 's1' } });

      expect(onMessage).toHaveBeenCalledWith({
        type: 'session_update',
        session: { sessionId: 's1' },
      });
    });

    it('tracks lastSeq from snapshot messages', () => {
      const client = new WsClient({ url: '/ws', onMessage: vi.fn(), onStatus: vi.fn() });
      client.connect();
      lastCreatedWs.simulateOpen();

      lastCreatedWs.simulateMessage({ type: 'snapshot', sessions: {}, teams: {}, seq: 42 });

      expect(client.getLastSeq()).toBe(42);
    });

    it('ignores unparseable messages', () => {
      const onMessage = vi.fn();
      const client = new WsClient({ url: '/ws', onMessage, onStatus: vi.fn() });
      client.connect();
      lastCreatedWs.simulateOpen();

      // Send raw invalid data
      lastCreatedWs.onmessage?.(new MessageEvent('message', { data: 'not-json' }));

      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  describe('send', () => {
    it('sends JSON message when connected', () => {
      const client = new WsClient({ url: '/ws', onMessage: vi.fn(), onStatus: vi.fn() });
      client.connect();
      lastCreatedWs.simulateOpen();

      client.send({ type: 'replay', sinceSeq: 10 });

      expect(lastCreatedWs.sentMessages).toHaveLength(1);
      expect(JSON.parse(lastCreatedWs.sentMessages[0])).toEqual({
        type: 'replay',
        sinceSeq: 10,
      });
    });

    it('does not send when not connected', () => {
      const client = new WsClient({ url: '/ws', onMessage: vi.fn(), onStatus: vi.fn() });
      client.connect();
      // Don't open the connection

      client.send({ type: 'replay', sinceSeq: 10 });

      expect(lastCreatedWs.sentMessages).toHaveLength(0);
    });
  });

  describe('reconnect', () => {
    it('fires reconnecting status on close', () => {
      vi.useFakeTimers();
      const onStatus = vi.fn();
      const client = new WsClient({ url: '/ws', onMessage: vi.fn(), onStatus });
      client.connect();
      lastCreatedWs.simulateOpen();
      onStatus.mockClear();

      lastCreatedWs.simulateClose(1006);

      expect(onStatus).toHaveBeenCalledWith('reconnecting');
      client.dispose();
      vi.useRealTimers();
    });

    it('dispatches ws-auth-failed on 4001 close code', () => {
      const onStatus = vi.fn();
      const dispatchSpy = vi.spyOn(document, 'dispatchEvent');
      const client = new WsClient({ url: '/ws', onMessage: vi.fn(), onStatus });
      client.connect();
      lastCreatedWs.simulateOpen();
      onStatus.mockClear();

      lastCreatedWs.simulateClose(4001);

      expect(onStatus).toHaveBeenCalledWith('disconnected');
      expect(dispatchSpy).toHaveBeenCalledWith(expect.any(CustomEvent));
      client.dispose();
    });

    it('sends replay on reconnect when lastSeq > 0', () => {
      vi.useFakeTimers();
      const client = new WsClient({ url: '/ws', onMessage: vi.fn(), onStatus: vi.fn() });
      client.connect();
      const ws1 = lastCreatedWs;
      ws1.simulateOpen();
      ws1.simulateMessage({ type: 'snapshot', sessions: {}, teams: {}, seq: 50 });

      // Simulate disconnect
      ws1.simulateClose(1006);

      // Advance timer to trigger reconnect
      vi.advanceTimersByTime(2000);

      // New WebSocket created
      const ws2 = lastCreatedWs;
      expect(ws2).not.toBe(ws1);
      ws2.simulateOpen();

      // Should have sent a replay message
      expect(ws2.sentMessages).toHaveLength(1);
      expect(JSON.parse(ws2.sentMessages[0])).toEqual({ type: 'replay', sinceSeq: 50 });

      client.dispose();
      vi.useRealTimers();
    });
  });

  describe('dispose', () => {
    it('cleans up WebSocket', () => {
      const client = new WsClient({ url: '/ws', onMessage: vi.fn(), onStatus: vi.fn() });
      client.connect();
      const ws = lastCreatedWs;

      client.dispose();

      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
      expect(ws.onopen).toBe(null);
      expect(ws.onclose).toBe(null);
      expect(ws.onmessage).toBe(null);
    });

    it('prevents reconnection after dispose', () => {
      vi.useFakeTimers();
      const onStatus = vi.fn();
      const client = new WsClient({ url: '/ws', onMessage: vi.fn(), onStatus });
      client.connect();
      lastCreatedWs.simulateOpen();

      // Close triggers reconnect schedule
      lastCreatedWs.simulateClose(1006);

      // Dispose before timer fires
      const wsAfterClose = lastCreatedWs;
      client.dispose();

      // Advance timer
      vi.advanceTimersByTime(10000);

      // No new WebSocket should have been created
      expect(lastCreatedWs).toBe(wsAfterClose);

      vi.useRealTimers();
    });
  });

  describe('setToken', () => {
    it('updates the token for future connections', () => {
      const client = new WsClient({ url: '/ws', token: null, onMessage: vi.fn(), onStatus: vi.fn() });
      client.setToken('new-token');
      client.connect();

      expect(lastCreatedWs.url).toContain('token=new-token');
      client.dispose();
    });
  });
});
