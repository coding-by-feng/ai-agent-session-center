// test/mcp/runtime.test.ts — the process-wide settings of the central-session MCP server
// (server/mcp/runtime.ts): the port /mcp listens on, and the `mcp.enabled` off switch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetMcpPortForTest,
  getMcpPort,
  isMcpEnabled,
  recordMcpPort,
  setMcpPort,
} from '../../server/mcp/runtime.js';
import { config } from '../../server/serverConfig.js';

// recordMcpPort warns about a port it cannot record; the logger would append to a file on disk.
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

describe('the /mcp port', () => {
  beforeEach(() => __resetMcpPortForTest());
  afterEach(() => __resetMcpPortForTest());

  it('is unknown until the server says what it listens on', () => {
    expect(getMcpPort()).toBeNull();
  });

  it('is what setMcpPort was last given', () => {
    setMcpPort(3333);
    expect(getMcpPort()).toBe(3333);

    setMcpPort(4455);
    expect(getMcpPort()).toBe(4455);
  });

  it('refuses a value that is not a TCP port, and keeps the one it had', () => {
    setMcpPort(3333);

    for (const bad of [0, -1, 65536, 3333.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => setMcpPort(bad)).toThrow(RangeError);
    }
    expect(() => setMcpPort('3333' as unknown as number)).toThrow(RangeError);

    expect(getMcpPort()).toBe(3333);
  });

  it('accepts both ends of the port range', () => {
    setMcpPort(1);
    expect(getMcpPort()).toBe(1);
    setMcpPort(65535);
    expect(getMcpPort()).toBe(65535);
  });
});

describe('recordMcpPort (what server startup calls)', () => {
  beforeEach(() => {
    __resetMcpPortForTest();
    log.warn.mockClear();
  });
  afterEach(() => __resetMcpPortForTest());

  it('records a TCP port and says so', () => {
    expect(recordMcpPort(3333)).toBe(true);
    expect(getMcpPort()).toBe(3333);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reads a numeric string the way listen() does', () => {
    // A port from data/server-config.json can be a string; net's validatePort takes `+port`.
    expect(recordMcpPort('4455')).toBe(true);
    expect(getMcpPort()).toBe(4455);
    expect(recordMcpPort(' 4456 ')).toBe(true);
    expect(getMcpPort()).toBe(4456);
  });

  it.each([
    0,
    -1,
    65536,
    3333.5,
    Number.NaN,
    '',
    '   ',
    'abc',
    '3333abc',
    null,
    undefined,
    true,
    {},
  ])('leaves centrals unwired for %j, with a warning, and never throws', (port) => {
    expect(() => recordMcpPort(port)).not.toThrow();
    expect(recordMcpPort(port)).toBe(false);
    expect(getMcpPort()).toBeNull();
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringMatching(/not a TCP port/));
  });

  it('keeps the port it had when a later one is no port', () => {
    recordMcpPort(3333);
    expect(recordMcpPort('nope')).toBe(false);
    expect(getMcpPort()).toBe(3333);
  });
});

describe('isMcpEnabled', () => {
  // `config` is the object serverConfig.ts built from data/server-config.json; a test edits it in
  // place and puts back whatever it found.
  const original = config.mcp;
  afterEach(() => {
    if (original === undefined) delete config.mcp;
    else config.mcp = original;
  });

  it('is on when the config does not mention mcp', () => {
    delete config.mcp;
    expect(isMcpEnabled()).toBe(true);
  });

  it('is on when mcp does not say', () => {
    config.mcp = {};
    expect(isMcpEnabled()).toBe(true);
  });

  it('is on when mcp.enabled is true', () => {
    config.mcp = { enabled: true };
    expect(isMcpEnabled()).toBe(true);
  });

  it('is off when mcp.enabled is false', () => {
    config.mcp = { enabled: false };
    expect(isMcpEnabled()).toBe(false);
  });

  it('reads the config each time it is asked', () => {
    config.mcp = { enabled: false };
    expect(isMcpEnabled()).toBe(false);
    config.mcp = { enabled: true };
    expect(isMcpEnabled()).toBe(true);
  });
});
