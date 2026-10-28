// test/serverTestSetup.ts — runs before every server test file (vitest.config.ts setupFiles).
//
// Central sessions (server/mcp) are off by default since Oct 28 2026. The suites that exercise them
// were written against the feature being on, so each file starts with `mcp.enabled: true` in the
// loaded config; a test that needs the switch off still sets `config.mcp = { enabled: false }`, and
// test/mcp/runtime.test.ts deletes it to check the real default.
import { config } from '../server/serverConfig.js';

config.mcp = { ...config.mcp, enabled: true };
