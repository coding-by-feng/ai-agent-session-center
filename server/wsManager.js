// wsManager.js — WebSocket broadcast manager
import { getAllSessions, getAllTeams } from './sessionStore.js';
import log from './logger.js';

const clients = new Set();

export function handleConnection(ws) {
  clients.add(ws);
  log.info('ws', `Client connected (total: ${clients.size})`);
  // Send full snapshot on connect (includes teams)
  const sessions = getAllSessions();
  const teams = getAllTeams();
  log.debug('ws', `Sending snapshot: ${Object.keys(sessions).length} sessions, ${Object.keys(teams).length} teams`);
  ws.send(JSON.stringify({ type: 'snapshot', sessions, teams }));
  ws.on('close', () => {
    clients.delete(ws);
    log.info('ws', `Client disconnected (total: ${clients.size})`);
  });
  ws.on('error', (err) => {
    clients.delete(ws);
    log.error('ws', 'Client error:', err.message);
  });
}

export function broadcast(data) {
  const msg = JSON.stringify(data);
  log.debug('ws', `Broadcasting ${data.type} to ${clients.size} clients`);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}
