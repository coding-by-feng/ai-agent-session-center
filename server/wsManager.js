// wsManager.js — WebSocket broadcast manager with bidirectional terminal support
import { getAllSessions, getAllTeams } from './sessionStore.js';
import { writeToTerminal, resizeTerminal, closeTerminal, setWsClient } from './sshManager.js';
import log from './logger.js';

const clients = new Set();

export function handleConnection(ws) {
  clients.add(ws);
  ws._terminalIds = new Set(); // Track subscribed terminals
  log.info('ws', `Client connected (total: ${clients.size})`);

  // Send full snapshot on connect (includes teams)
  const sessions = getAllSessions();
  const teams = getAllTeams();
  log.debug('ws', `Sending snapshot: ${Object.keys(sessions).length} sessions, ${Object.keys(teams).length} teams`);
  ws.send(JSON.stringify({ type: 'snapshot', sessions, teams }));

  // Handle incoming messages (terminal input, resize, etc.)
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case 'terminal_input':
          if (msg.terminalId && msg.data) {
            writeToTerminal(msg.terminalId, msg.data);
          }
          break;
        case 'terminal_resize':
          if (msg.terminalId && msg.cols && msg.rows) {
            resizeTerminal(msg.terminalId, msg.cols, msg.rows);
          }
          break;
        case 'terminal_disconnect':
          if (msg.terminalId) {
            closeTerminal(msg.terminalId);
            ws._terminalIds.delete(msg.terminalId);
          }
          break;
        case 'terminal_subscribe':
          if (msg.terminalId) {
            ws._terminalIds.add(msg.terminalId);
            setWsClient(msg.terminalId, ws);
          }
          break;
        default:
          log.debug('ws', `Unknown message type: ${msg.type}`);
      }
    } catch (e) {
      log.debug('ws', `Invalid WS message: ${e.message}`);
    }
  });

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
