// clientEdition.test.ts — which Client this package is, and the data folder that keeps it away from a local AASC.
import { describe, it, expect } from 'vitest';
import { CLIENT_DATA_FOLDER, clientAppName, parseClientEdition } from '../electron/clientEdition.js';

describe('the Client edition', () => {
  it('reads Lite Client from the package', () => {
    expect(parseClientEdition('{"aascEdition":"lite-client"}')).toBe('lite-client');
  });

  it.each(['{"aascEdition":"full-client"}', '{"aascEdition":"lite"}', '{}', 'not json', ''])('%s reads as Full Client', (json) => {
    expect(parseClientEdition(json)).toBe('full-client');
  });

  it('names both', () => {
    expect(clientAppName('full-client')).toBe('AI Agent Session Center Full Client');
    expect(clientAppName('lite-client')).toBe('AI Agent Session Center Lite Client');
  });

  // Full and Lite derive their data folder and keychain item from `ai-agent-session-center` (edition.ts).
  it('never shares a data folder with a local edition', () => {
    expect(CLIENT_DATA_FOLDER).not.toBe('ai-agent-session-center');
    expect(CLIENT_DATA_FOLDER).toBe('ai-agent-session-center-client');
  });
});
