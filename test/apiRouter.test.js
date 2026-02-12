// test/apiRouter.test.js — Integration tests for API endpoints
// Tests validation logic via actual HTTP requests to a test server
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'http';
import { handleEvent, getAllSessions, setSessionTitle } from '../server/sessionStore.js';
import { EVENT_TYPES } from '../server/constants.js';

// We create a minimal test server with just the routes we need to test
let server;
let baseUrl;

async function startTestServer() {
  const app = express();
  app.use(express.json());

  // Import the actual apiRouter
  const { default: apiRouter, hookRateLimitMiddleware } = await import('../server/apiRouter.js');
  const hookRouter = (await import('../server/hookRouter.js')).default;

  app.use('/api', apiRouter);
  app.use('/api/hooks', hookRateLimitMiddleware, hookRouter);
  app.get('/api/sessions', (req, res) => {
    res.json(getAllSessions());
  });

  return new Promise((resolve) => {
    server = createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
}

function stopTestServer() {
  return new Promise((resolve) => {
    if (server) {
      server.close(resolve);
    } else {
      resolve();
    }
  });
}

describe('apiRouter - integration tests', () => {
  before(async () => {
    await startTestServer();
  });

  after(async () => {
    await stopTestServer();
  });

  describe('POST /api/hooks', () => {
    it('returns 200 for valid hook payload', async () => {
      const res = await fetch(`${baseUrl}/api/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'api-test-hook-1',
          hook_event_name: 'SessionStart',
          cwd: '/tmp/test',
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    });

    it('returns 400 for missing session_id', async () => {
      const res = await fetch(`${baseUrl}/api/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'SessionStart',
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.ok(body.error.includes('session_id'));
    });

    it('returns 400 for unknown event type', async () => {
      const res = await fetch(`${baseUrl}/api/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'api-test-hook-2',
          hook_event_name: 'InvalidEvent',
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error.includes('unknown event type'));
    });

    it('returns 400 for invalid claude_pid', async () => {
      const res = await fetch(`${baseUrl}/api/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'api-test-hook-3',
          hook_event_name: 'SessionStart',
          claude_pid: 'not-a-number',
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error.includes('claude_pid'));
    });
  });

  describe('GET /api/sessions', () => {
    it('returns an object with sessions', async () => {
      // Ensure at least one session exists
      handleEvent({
        session_id: 'api-test-sessions-1',
        hook_event_name: EVENT_TYPES.SESSION_START,
        cwd: '/tmp/test',
      });
      const res = await fetch(`${baseUrl}/api/sessions`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(typeof body, 'object');
      assert.ok(body['api-test-sessions-1']);
    });
  });

  describe('PUT /api/sessions/:id/title', () => {
    it('returns 200 for valid title', async () => {
      handleEvent({
        session_id: 'api-test-title-1',
        hook_event_name: EVENT_TYPES.SESSION_START,
        cwd: '/tmp/test',
      });
      const res = await fetch(`${baseUrl}/api/sessions/api-test-title-1/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'My Session Title' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    });

    it('returns 400 when title is missing', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/api-test-title-1/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error.includes('title'));
    });

    it('returns 400 for too-long title', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/api-test-title-1/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'x'.repeat(501) }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error.includes('500'));
    });

    it('returns 400 for non-string title', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/api-test-title-1/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 12345 }),
      });
      assert.equal(res.status, 400);
    });
  });

  describe('PUT /api/sessions/:id/label', () => {
    it('returns 200 for valid label', async () => {
      handleEvent({
        session_id: 'api-test-label-1',
        hook_event_name: EVENT_TYPES.SESSION_START,
        cwd: '/tmp/test',
      });
      const res = await fetch(`${baseUrl}/api/sessions/api-test-label-1/label`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'reviewer' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    });

    it('returns 400 when label is missing', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/api-test-label-1/label`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    });
  });

  describe('GET /api/hook-stats', () => {
    it('returns hook stats', async () => {
      const res = await fetch(`${baseUrl}/api/hook-stats`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(typeof body.totalHooks, 'number');
      assert.equal(typeof body.hooksPerMin, 'number');
      assert.equal(typeof body.events, 'object');
    });
  });

  describe('GET /api/mq-stats', () => {
    it('returns MQ reader stats', async () => {
      const res = await fetch(`${baseUrl}/api/mq-stats`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(typeof body.linesProcessed, 'number');
      assert.equal(typeof body.queueFile, 'string');
    });
  });

  describe('GET /api/sessions/:id/source', () => {
    it('returns session source', async () => {
      handleEvent({
        session_id: 'api-test-source-1',
        hook_event_name: EVENT_TYPES.SESSION_START,
        cwd: '/tmp/test',
      });
      const res = await fetch(`${baseUrl}/api/sessions/api-test-source-1/source`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(typeof body.source, 'string');
    });
  });

  describe('DELETE /api/sessions/:id', () => {
    it('deletes a session', async () => {
      handleEvent({
        session_id: 'api-test-delete-1',
        hook_event_name: EVENT_TYPES.SESSION_START,
        cwd: '/tmp/test',
      });
      const res = await fetch(`${baseUrl}/api/sessions/api-test-delete-1`, {
        method: 'DELETE',
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.removed, true);
    });
  });
});
