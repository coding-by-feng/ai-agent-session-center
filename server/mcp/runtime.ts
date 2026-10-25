// runtime.ts — the process-wide settings of the central-session MCP server (server/mcp/).
//
// Two things the rest of the folder needs and none of them owns: the port /mcp is served on (a launch
// line names it, and only the code that starts the server knows it), and the off switch.

import log from '../logger.js';
import { config } from '../serverConfig.js';

let mcpPort: number | null = null;

/** Is this a TCP port: a whole number from 1 to 65535? */
export function isTcpPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Record the port the server listens on, for launch lines (launch.ts) to name. Called once by the
 * code that starts the server. Throws `RangeError` for a value that is not a TCP port: a wrong one
 * would not fail here but in every central's launch, silently, so it is refused where it is set.
 */
export function setMcpPort(port: number): void {
  if (!isTcpPort(port)) throw new RangeError(`Not a TCP port: ${String(port)}`);
  mcpPort = port;
}

/**
 * A port the way `server.listen()` reads one: a number as it is, a string that is not blank through
 * `Number()` (net's `validatePort` takes `+port`: '3333' and ' 3333 ' are port 3333). Anything else is
 * no port.
 */
function listenPort(port: unknown): number {
  if (typeof port === 'number') return port;
  if (typeof port === 'string' && port.trim() !== '') return Number(port);
  return Number.NaN;
}

/**
 * What server startup calls with the port it is about to listen on (a config value can be a string).
 * Records it when it is a TCP port and answers true. Anything else is not recorded and never throws: the
 * server starts all the same, a warning says why, and centrals are left unwired (a launch with no port
 * names no /mcp, and the central it minted is revoked at once). Answers whether the port was recorded.
 */
export function recordMcpPort(port: unknown): boolean {
  const value = listenPort(port);
  if (!isTcpPort(value)) {
    log.warn(
      'mcp',
      `Central sessions are left unwired: the server port ${String(port).slice(0, 40)} is not a TCP port`,
    );
    return false;
  }
  setMcpPort(value);
  return true;
}

/** The port set by `setMcpPort`, or null while the server has not said what it listens on. */
export function getMcpPort(): number | null {
  return mcpPort;
}

/**
 * Is the central-session feature on? `mcp.enabled` in `data/server-config.json`; on unless that is
 * explicitly `false`. Read from the config each time, so it is whatever the loaded config says.
 */
export function isMcpEnabled(): boolean {
  return config.mcp?.enabled !== false;
}

/** @internal — test only: forget the port, as a server that has not started would. */
export function __resetMcpPortForTest(): void {
  mcpPort = null;
}
