// wsManager.js — WebSocket broadcast manager
import { getAllSessions } from './sessionStore.js';

const clients = new Set();

export function handleConnection(ws) {
  clients.add(ws);
  // Send full snapshot on connect
  ws.send(JSON.stringify({ type: 'snapshot', sessions: getAllSessions() }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
}

export function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}
