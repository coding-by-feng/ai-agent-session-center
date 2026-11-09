/**
 * wsServerOptions — how the dashboard's one WebSocketServer is built (server/index.ts; the
 * remote-only listener upgrades into the same server).
 *
 * permessage-deflate (Nov 7 2026): on connect a device gets every session it may see (1.17 MB
 * that night, 36 sessions) and then a whole session on every hook update (up to ~200 KB each:
 * prompt history and tool log). A phone on weak Wi-Fi fell behind; its pongs queued behind
 * megabytes, the 30 s heartbeat dropped it, and it reconnected into the same snapshot, stuck on
 * "Loading sessions…". The JSON deflates to about a quarter (measured 1.17 MB → 316 KB).
 *
 * Negotiated per socket: WKWebView, Electron and the `ws`-based clients offer it, and a client
 * that doesn't gets plain frames. Frames under `threshold` (keystrokes, acks, pings) are sent as
 * they are, so typing gains no latency. Deflate runs on zlib's thread pool, not the event loop.
 */
export const WS_SERVER_OPTIONS = {
  /** 512 KB max incoming message (large terminal pastes). */
  maxPayload: 512 * 1024,
  perMessageDeflate: {
    threshold: 1024,
  },
} as const;
